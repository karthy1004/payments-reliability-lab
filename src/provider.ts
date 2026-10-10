import { randomUUID } from "node:crypto";
import { sign } from "./signature.ts";

// An in-process stand-in for a card processor / PSP. No network, no real money.
// Behaviour is selected by the amount's last two digits (like PSP test cards), so every
// failure mode in the README can be reproduced on demand:
//
//   ..02  decline                      ..05  times out, but the charge DID succeed
//   ..03  requires customer action     ..06  accepted as pending, succeeds via webhook
//   ..04  503 twice, then succeeds     ..07  503 on every attempt
//   else  succeeds immediately

export type ChargeStatus = "succeeded" | "failed" | "requires_action" | "pending" | "refunded";

export interface Charge {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: ChargeStatus;
  declineCode: string | null;
}

export interface ChargeRequest {
  idempotencyKey: string;
  paymentId: string;
  amount: number;
  currency: string;
}

export type WebhookType = "charge.succeeded" | "charge.failed" | "charge.requires_action" | "charge.refunded";

export interface WebhookEvent {
  id: string;
  type: WebhookType;
  created: number;
  data: { charge_id: string; payment_id: string; amount: number; currency: string };
}

export interface SignedDelivery {
  body: string;
  headers: Record<string, string>;
  event: WebhookEvent;
}

export class TransientProviderError extends Error {
  readonly status = 503;
  constructor() {
    super("provider temporarily unavailable (request not processed)");
    this.name = "TransientProviderError";
  }
}

export interface PaymentProvider {
  createCharge(req: ChargeRequest): Promise<Charge>;
  refund(chargeId: string, idempotencyKey: string): Promise<Charge>;
}

export class SimulatedProvider implements PaymentProvider {
  readonly charges = new Map<string, Charge>();
  readonly calls: ChargeRequest[] = [];
  private readonly byKey = new Map<string, string>();
  private readonly refundKeys = new Set<string>();
  private readonly transientFailures = new Map<string, number>();
  private outbox: WebhookEvent[] = [];
  private readonly secret: string;
  private readonly nowSeconds: () => number;

  constructor(secret: string, nowSeconds: () => number = () => Math.floor(Date.now() / 1000)) {
    this.secret = secret;
    this.nowSeconds = nowSeconds;
  }

  async createCharge(req: ChargeRequest): Promise<Charge> {
    this.calls.push(req);
    const scenario = req.amount % 100;

    // Provider-side idempotency: the same key never creates a second charge.
    const existingId = this.byKey.get(req.idempotencyKey);
    if (existingId) {
      const existing = this.charges.get(existingId);
      if (existing) return { ...existing };
    }

    if (scenario === 4 || scenario === 7) {
      const failures = this.transientFailures.get(req.idempotencyKey) ?? 0;
      if (scenario === 7 || failures < 2) {
        this.transientFailures.set(req.idempotencyKey, failures + 1);
        throw new TransientProviderError();
      }
    }

    const status: ChargeStatus =
      scenario === 2
        ? "failed"
        : scenario === 3
          ? "requires_action"
          : scenario === 6
            ? "pending"
            : "succeeded";
    const charge: Charge = {
      id: `ch_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      paymentId: req.paymentId,
      amount: req.amount,
      currency: req.currency,
      status,
      declineCode: status === "failed" ? "insufficient_funds" : null,
    };
    this.charges.set(charge.id, charge);
    this.byKey.set(req.idempotencyKey, charge.id);

    if (scenario === 5) {
      // The charge succeeded on the provider's side, but the response never arrives.
      this.emit("charge.succeeded", charge);
      return new Promise<Charge>(() => {});
    }
    if (scenario === 6) {
      charge.status = "succeeded";
      this.emit("charge.succeeded", charge);
      return { ...charge, status: "pending" };
    }
    return { ...charge };
  }

  async refund(chargeId: string, idempotencyKey: string): Promise<Charge> {
    const charge = this.charges.get(chargeId);
    if (!charge) throw new Error(`no such charge ${chargeId}`);
    if (!this.refundKeys.has(idempotencyKey)) {
      this.refundKeys.add(idempotencyKey);
      charge.status = "refunded";
      this.emit("charge.refunded", charge);
    }
    return { ...charge };
  }

  /** Test hook: make the provider's books disagree with ours. */
  tamper(chargeId: string, patch: Partial<Pick<Charge, "amount" | "status">>): void {
    const charge = this.charges.get(chargeId);
    if (charge) Object.assign(charge, patch);
  }

  /** Test hook: a charge the provider has but we never recorded (e.g. a manual dashboard charge). */
  addOrphanCharge(amount: number, currency: string): Charge {
    const charge: Charge = {
      id: `ch_orphan_${this.charges.size}`,
      paymentId: "unknown",
      amount,
      currency,
      status: "succeeded",
      declineCode: null,
    };
    this.charges.set(charge.id, charge);
    return charge;
  }

  private emit(type: WebhookType, charge: Charge): void {
    this.outbox.push({
      id: `evt_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      type,
      created: this.nowSeconds(),
      data: {
        charge_id: charge.id,
        payment_id: charge.paymentId,
        amount: charge.amount,
        currency: charge.currency,
      },
    });
  }

  /** Hand pending webhooks to the caller, signed exactly as a real provider would. */
  drainWebhooks(): SignedDelivery[] {
    const events = this.outbox;
    this.outbox = [];
    return events.map((event) => this.signEvent(event));
  }

  signEvent(event: WebhookEvent, secret = this.secret, timestamp = this.nowSeconds()): SignedDelivery {
    const body = JSON.stringify(event);
    return {
      body,
      event,
      headers: { "content-type": "application/json", "provider-signature": sign(body, secret, timestamp) },
    };
  }

  /** Daily settlement report, as the provider would send it. */
  settlementCsv(): string {
    const rows = [...this.charges.values()]
      .filter((c) => c.status === "succeeded" || c.status === "refunded")
      .map((c) =>
        [c.id, c.paymentId, c.amount, c.currency, c.status === "refunded" ? "refunded" : "captured"].join(
          ",",
        ),
      );
    return ["charge_id,payment_id,amount,currency,status", ...rows].join("\n");
  }
}
