import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { PaymentService } from "../src/payments.ts";
import { SimulatedProvider } from "../src/provider.ts";
import { harness, SECRET } from "./harness.ts";

describe("request validation", () => {
  it.each([
    ["float amount", { amount: 10.5, currency: "USD", customer_id: "cus_alice" }],
    ["string amount (no coercion)", { amount: "1000", currency: "USD", customer_id: "cus_alice" }],
    ["zero amount", { amount: 0, currency: "USD", customer_id: "cus_alice" }],
    ["unsupported currency", { amount: 1000, currency: "XYZ", customer_id: "cus_alice" }],
    ["bad customer id", { amount: 1000, currency: "USD", customer_id: "alice" }],
    ["unknown field", { amount: 1000, currency: "USD", customer_id: "cus_alice", admin: true }],
    ["missing field", { amount: 1000, currency: "USD" }],
  ])("rejects %s with 400", async (_name, payload) => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": "key-12345678" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(h.provider.calls).toHaveLength(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/payments",
      headers: { "idempotency-key": "key-12345678", "content-type": "application/json" },
      payload: '{"amount": 10,',
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown payments", async () => {
    const res = await harness().app.inject({ method: "GET", url: "/payments/pay_nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("idempotency keys", () => {
  it("requires a key", async () => {
    const h = harness();
    const res = await h.app.inject({
      method: "POST",
      url: "/payments",
      payload: { amount: 1000, currency: "USD", customer_id: "cus_alice" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_required");
  });

  it("replays the original response for a retried request and charges once", async () => {
    const h = harness();
    const first = await h.pay(1000, { key: "order-42-attempt" });
    const retry = await h.pay(1000, { key: "order-42-attempt" });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.json()).toEqual(first.json());
    expect(h.provider.calls).toHaveLength(1);
    expect(h.service.list()).toHaveLength(1);
  });

  it("rejects reuse of a key with a different body", async () => {
    const h = harness();
    await h.pay(1000, { key: "order-43-attempt" });
    const res = await h.pay(2000, { key: "order-43-attempt" });
    expect(res.statusCode).toBe(422);
    expect(h.service.list()).toHaveLength(1);
  });

  it("returns 409 to a duplicate that arrives while the first is still in flight", async () => {
    // Hold the provider call open so request A is genuinely in flight when B arrives.
    // Synchronise on events, not sleeps: a fixed delay is a race on a slow or busy machine.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const atProvider = new Promise<void>((r) => {
      reached = r;
    });
    const db = openDb();
    const provider = new SimulatedProvider(SECRET);
    const original = provider.createCharge.bind(provider);
    provider.createCharge = async (req) => {
      reached();
      await gate;
      return original(req);
    };
    const now = () => new Date("2026-10-01T12:00:00Z");
    const app = buildApp({ db, payments: new PaymentService(db, provider, now), webhookSecret: SECRET, now });
    const send = () =>
      app.inject({
        method: "POST",
        url: "/payments",
        headers: { "idempotency-key": "double-click-1" },
        payload: { amount: 1000, currency: "USD", customer_id: "cus_alice" },
      });

    const first = send();
    await atProvider; // A holds the key and is waiting on the provider
    const second = await send();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("request_in_progress");

    release();
    expect((await first).statusCode).toBe(201);
    expect(provider.calls).toHaveLength(1);
  });

  it("expires keys after 24 hours", async () => {
    const h = harness();
    await h.pay(1000, { key: "old-key-1234" });
    h.advanceClock(24 * 60 * 60 * 1000 + 1);
    const res = await h.pay(1000, { key: "old-key-1234" });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(h.service.list()).toHaveLength(2);
  });

  it("stores client errors so a retry gets the same answer", async () => {
    const h = harness();
    const pay = (await h.pay(1002)).json(); // declined
    const r1 = await h.app.inject({
      method: "POST",
      url: `/payments/${pay.id}/refund`,
      headers: { "idempotency-key": "refund-try-1" },
    });
    const r2 = await h.app.inject({
      method: "POST",
      url: `/payments/${pay.id}/refund`,
      headers: { "idempotency-key": "refund-try-1" },
    });
    expect(r1.statusCode).toBe(409);
    expect(r2.statusCode).toBe(409);
    expect(r2.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("risk rules", () => {
  it("declines on velocity with a named rule", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++)
      expect((await h.pay(1000, { customer: "cus_bob1" })).json().state).toBe("succeeded");
    const sixth = (await h.pay(1000, { customer: "cus_bob1" })).json();
    expect(sixth.state).toBe("failed");
    expect(sixth.failureReason).toBe("risk_declined:velocity");
    expect(h.provider.calls).toHaveLength(5);
    h.advanceClock(10 * 60 * 1000 + 1);
    expect((await h.pay(1000, { customer: "cus_bob1" })).json().state).toBe("succeeded");
  });

  it("declines amounts over the per-currency limit", async () => {
    const h = harness();
    const res = (await h.pay(1_000_001)).json();
    expect(res.failureReason).toBe("risk_declined:amount_limit");
    expect(h.provider.calls).toHaveLength(0);
  });
});
