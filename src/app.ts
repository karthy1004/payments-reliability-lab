import type { DatabaseSync } from "node:sqlite";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { CURRENCIES, DomainError } from "./domain.ts";
import { IdempotencyStore, KEY_PATTERN, requestHash } from "./idempotency.ts";
import type { PaymentService, WebhookOutcome } from "./payments.ts";
import type { WebhookEvent } from "./provider.ts";
import { parseSettlement, reconcile, SettlementParseError } from "./reconcile.ts";
import { SIGNATURE_HEADER, verify } from "./signature.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export interface AppDeps {
  db: DatabaseSync;
  payments: PaymentService;
  webhookSecret: string;
  now: () => Date;
  logger?: boolean;
}

const error = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });

const createPaymentSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["amount", "currency", "customer_id"],
    properties: {
      amount: { type: "integer", minimum: 1, maximum: 100_000_000 },
      currency: { type: "string", enum: [...CURRENCIES] },
      customer_id: { type: "string", pattern: "^cus_[a-z0-9]{4,32}$" },
      description: { type: "string", maxLength: 200 },
    },
  },
} as const;

const webhookSchema = {
  body: {
    type: "object",
    required: ["id", "type", "created", "data"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
      type: {
        type: "string",
        enum: ["charge.succeeded", "charge.failed", "charge.requires_action", "charge.refunded"],
      },
      created: { type: "integer" },
      data: {
        type: "object",
        required: ["charge_id", "payment_id", "amount", "currency"],
        properties: {
          charge_id: { type: "string" },
          payment_id: { type: "string" },
          amount: { type: "integer" },
          currency: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 64 * 1024,
    // Strict validation: no type coercion, no silently dropped fields.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
  });
  const idem = new IdempotencyStore(deps.db, deps.now);

  // Keep the exact bytes: webhook signatures are computed over the raw body.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = body as string;
    req.rawBody = raw;
    if (raw === "") return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch {
      done(
        Object.assign(new Error("malformed JSON body"), { statusCode: 400, code: "malformed_json" }),
        undefined,
      );
    }
  });

  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
      if (err instanceof DomainError) return error(reply, err.statusCode, err.code, err.message);
      if (err.validation) return error(reply, 400, "invalid_request", err.message);
      if (err.statusCode && err.statusCode < 500)
        return error(reply, err.statusCode, err.code ?? "bad_request", err.message);
      req.log.error({ err }, "unhandled error");
      return error(reply, 500, "internal_error", "internal error");
    },
  );

  // Wraps a mutating handler with Idempotency-Key semantics (see idempotency.ts).
  async function idempotent(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    handler: () => Promise<{ status: number; body: unknown }>,
  ) {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      return error(
        reply,
        400,
        "idempotency_key_required",
        "Idempotency-Key header (8-128 chars) is required",
      );
    }
    const begin = idem.begin(scope, key, requestHash(req.body ?? null));
    if (begin.kind === "mismatch")
      return error(reply, 422, "idempotency_key_reused", "this key was used with a different request body");
    if (begin.kind === "conflict")
      return error(reply, 409, "request_in_progress", "a request with this key is still in progress");
    if (begin.kind === "replay")
      return reply.code(begin.status).header("idempotent-replayed", "true").send(begin.body);

    try {
      const { status, body } = await handler();
      idem.complete(scope, key, status, body);
      return reply.code(status).send(body);
    } catch (err) {
      if (err instanceof DomainError && err.statusCode < 500) {
        const body = { error: { code: err.code, message: err.message } };
        idem.complete(scope, key, err.statusCode, body);
        return reply.code(err.statusCode).send(body);
      }
      idem.release(scope, key); // 5xx: let the client retry with the same key
      throw err;
    }
  }

  app.post("/payments", { schema: createPaymentSchema }, (req, reply) =>
    idempotent(req, reply, "POST /payments", async () => {
      const b = req.body as { amount: number; currency: (typeof CURRENCIES)[number]; customer_id: string };
      const payment = await deps.payments.create({
        customerId: b.customer_id,
        amount: b.amount,
        currency: b.currency,
      });
      return { status: 201, body: payment };
    }),
  );

  app.get<{ Params: { id: string } }>("/payments/:id", async (req) => deps.payments.get(req.params.id));

  app.get<{ Params: { id: string } }>("/payments/:id/events", async (req) =>
    deps.payments.auditTrail(req.params.id),
  );

  app.post<{ Params: { id: string } }>("/payments/:id/refund", (req, reply) =>
    idempotent(req, reply, `POST /payments/${req.params.id}/refund`, async () => ({
      status: 200,
      body: await deps.payments.refund(req.params.id),
    })),
  );

  app.post("/webhooks/provider", { schema: webhookSchema }, async (req, reply) => {
    const check = verify(
      req.rawBody ?? "",
      req.headers[SIGNATURE_HEADER] as string | undefined,
      deps.webhookSecret,
      Math.floor(deps.now().getTime() / 1000),
    );
    if (!check.ok) return error(reply, 401, `signature_${check.reason}`, "webhook signature rejected");
    const outcome: WebhookOutcome = deps.payments.handleWebhook(req.body as WebhookEvent);
    // 200 for every verified event, including duplicates: a non-2xx would make the
    // provider redeliver something we have already handled.
    return { received: true, outcome };
  });

  app.post("/reconciliation", async (req, reply) => {
    if (typeof req.body !== "string") return error(reply, 415, "unsupported_media_type", "send text/csv");
    try {
      return reconcile(deps.payments.list(), parseSettlement(req.body));
    } catch (err) {
      if (err instanceof SettlementParseError) return error(reply, 400, "malformed_settlement", err.message);
      throw err;
    }
  });
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.get("/health", async () => ({ ok: true }));

  return app;
}
