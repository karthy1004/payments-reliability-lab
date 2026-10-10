import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.ts";
import {
  type Currency,
  canTransition,
  DomainError,
  IllegalTransition,
  NotFound,
  type Payment,
  type PaymentState,
} from "./domain.ts";
import {
  type ChargeStatus,
  type PaymentProvider,
  TransientProviderError,
  type WebhookEvent,
} from "./provider.ts";
import { TimeoutError, withRetry, withTimeout } from "./retry.ts";
import { assessRisk, DEFAULT_RISK, type RiskConfig } from "./risk.ts";

export interface ServiceConfig {
  providerTimeoutMs: number;
  providerRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  risk: RiskConfig;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  providerTimeoutMs: 2_000,
  providerRetries: 3,
  retryBaseMs: 100,
  retryMaxMs: 1_000,
  risk: DEFAULT_RISK,
};

export type Advance = "applied" | "no_op" | "ignored_out_of_order";
export type WebhookOutcome = Advance | "duplicate" | "unknown_payment" | "amount_mismatch";

interface PaymentRow {
  id: string;
  customer_id: string;
  amount: number;
  currency: Currency;
  state: PaymentState;
  provider_charge_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

const toPayment = (r: PaymentRow): Payment => ({
  id: r.id,
  customerId: r.customer_id,
  amount: r.amount,
  currency: r.currency,
  state: r.state,
  providerChargeId: r.provider_charge_id,
  failureReason: r.failure_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const CHARGE_TO_STATE: Record<ChargeStatus, PaymentState> = {
  succeeded: "succeeded",
  failed: "failed",
  requires_action: "requires_action",
  pending: "processing",
  refunded: "refunded",
};

const EVENT_TO_STATE: Record<WebhookEvent["type"], PaymentState> = {
  "charge.succeeded": "succeeded",
  "charge.failed": "failed",
  "charge.requires_action": "requires_action",
  "charge.refunded": "refunded",
};

export class PaymentService {
  private readonly db: DatabaseSync;
  private readonly provider: PaymentProvider;
  private readonly now: () => Date;
  private readonly config: ServiceConfig;

  constructor(db: DatabaseSync, provider: PaymentProvider, now: () => Date, config = DEFAULT_SERVICE_CONFIG) {
    this.db = db;
    this.provider = provider;
    this.now = now;
    this.config = config;
  }

  get(id: string): Payment {
    const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;
    if (!row) throw new NotFound(`payment ${id}`);
    return toPayment(row);
  }

  list(): Payment[] {
    return (
      this.db.prepare("SELECT * FROM payments ORDER BY created_at, id").all() as unknown as PaymentRow[]
    ).map(toPayment);
  }

  auditTrail(paymentId: string): unknown[] {
    this.get(paymentId);
    return this.db
      .prepare(
        "SELECT id, at, actor, action, from_state, to_state, detail FROM audit_events WHERE payment_id = ? ORDER BY id",
      )
      .all(paymentId)
      .map((r) => ({ ...r, detail: r.detail ? JSON.parse(String(r.detail)) : null }));
  }

  async create(input: { customerId: string; amount: number; currency: Currency }): Promise<Payment> {
    const id = `pay_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const risk = assessRisk(this.db, this.config.risk, input, this.now());
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO payments (id, customer_id, amount, currency, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)",
      )
      .run(id, input.customerId, input.amount, input.currency, at, at);
    this.audit(id, "api", "payment_created", null, "created", {
      amount: input.amount,
      currency: input.currency,
    });

    if (!risk.allow) {
      this.advance(id, "failed", "risk", { failureReason: `risk_declined:${risk.rule}` });
      return this.get(id);
    }
    this.advance(id, "processing", "api");

    const call = withRetry(
      () =>
        this.provider.createCharge({
          idempotencyKey: id, // provider-side idempotency: retries can never double-charge
          paymentId: id,
          amount: input.amount,
          currency: input.currency,
        }),
      {
        retries: this.config.providerRetries,
        baseMs: this.config.retryBaseMs,
        maxMs: this.config.retryMaxMs,
        isRetryable: (e) => e instanceof TransientProviderError,
        onRetry: (attempt, delayMs) =>
          this.audit(id, "system", "provider_retry", null, null, { attempt, delayMs }),
        ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
      },
    );

    try {
      const charge = await withTimeout(call, this.config.providerTimeoutMs, "provider.createCharge");
      this.advance(id, CHARGE_TO_STATE[charge.status], "provider", {
        providerChargeId: charge.id,
        failureReason: charge.declineCode,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        // The charge may or may not exist. Do NOT mark failed and do NOT retry with a new
        // key: leave it processing and let the webhook or reconciliation settle the truth.
        this.audit(id, "system", "provider_timeout_outcome_unknown", null, null, {
          timeoutMs: this.config.providerTimeoutMs,
        });
      } else if (err instanceof TransientProviderError) {
        // 503 = provider states the request was not processed, so failing is safe.
        this.advance(id, "failed", "system", { failureReason: "provider_unavailable" });
      } else {
        throw err;
      }
    }
    return this.get(id);
  }

  async refund(id: string): Promise<Payment> {
    const payment = this.get(id);
    if (!canTransition(payment.state, "refunded")) throw new IllegalTransition(payment.state, "refunded");
    if (!payment.providerChargeId) throw new DomainError(409, "no_charge", "payment has no provider charge");
    await withRetry(() => this.provider.refund(payment.providerChargeId as string, `refund:${id}`), {
      retries: this.config.providerRetries,
      baseMs: this.config.retryBaseMs,
      maxMs: this.config.retryMaxMs,
      isRetryable: (e) => e instanceof TransientProviderError,
      ...(this.config.sleep ? { sleep: this.config.sleep } : {}),
    });
    this.advance(id, "refunded", "api");
    return this.get(id);
  }

  /** Apply a verified webhook exactly once. Dedupe and state change share one transaction. */
  handleWebhook(event: WebhookEvent): WebhookOutcome {
    return inTransaction(this.db, () => {
      const at = this.now().toISOString();
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO processed_events (event_id, type, payment_id, outcome, received_at) VALUES (?, ?, ?, 'pending', ?)",
        )
        .run(event.id, event.type, event.data.payment_id, at);
      if (inserted.changes === 0) return "duplicate";

      const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(event.data.payment_id) as
        | PaymentRow
        | undefined;
      let outcome: WebhookOutcome;
      if (!row) {
        outcome = "unknown_payment";
      } else if (row.amount !== event.data.amount || row.currency !== event.data.currency) {
        outcome = "amount_mismatch";
        this.audit(row.id, "provider", "webhook_rejected_amount_mismatch", row.state, null, {
          event: event.id,
          eventAmount: event.data.amount,
          eventCurrency: event.data.currency,
        });
      } else {
        outcome = this.advance(
          row.id,
          EVENT_TO_STATE[event.type],
          "provider",
          {
            providerChargeId: event.data.charge_id,
          },
          { event: event.id, type: event.type },
        );
      }
      this.db.prepare("UPDATE processed_events SET outcome = ? WHERE event_id = ?").run(outcome, event.id);
      return outcome;
    });
  }

  /**
   * Move a payment toward `to`. Same state -> no-op (but fill a missing charge id).
   * Illegal from the current state -> ignored and audited (late or out-of-order signal).
   * Uses compare-and-set on the current state so a concurrent writer can't be overwritten.
   */
  private advance(
    id: string,
    to: PaymentState,
    actor: string,
    patch: { providerChargeId?: string | null; failureReason?: string | null } = {},
    detail: Record<string, unknown> = {},
  ): Advance {
    const current = this.get(id);
    const at = this.now().toISOString();
    if (current.state === to) {
      if (patch.providerChargeId && !current.providerChargeId) {
        this.db
          .prepare("UPDATE payments SET provider_charge_id = ?, updated_at = ? WHERE id = ?")
          .run(patch.providerChargeId, at, id);
      }
      return "no_op";
    }
    if (!canTransition(current.state, to)) {
      this.audit(id, actor, "transition_ignored", current.state, to, detail);
      return "ignored_out_of_order";
    }
    const result = this.db
      .prepare(
        `UPDATE payments SET state = ?, provider_charge_id = COALESCE(provider_charge_id, ?),
         failure_reason = COALESCE(?, failure_reason), updated_at = ? WHERE id = ? AND state = ?`,
      )
      .run(to, patch.providerChargeId ?? null, patch.failureReason ?? null, at, id, current.state);
    if (result.changes === 0)
      throw new DomainError(409, "concurrent_update", `payment ${id} changed concurrently`);
    this.audit(id, actor, "state_changed", current.state, to, detail);
    return "applied";
  }

  private audit(
    paymentId: string | null,
    actor: string,
    action: string,
    from: string | null,
    to: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events (at, payment_id, actor, action, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(this.now().toISOString(), paymentId, actor, action, from, to, JSON.stringify(detail));
  }
}
