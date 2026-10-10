import { describe, expect, it } from "vitest";
import { harness, SECRET } from "./harness.ts";

const actions = (trail: Array<{ action: string; to_state: string | null }>) =>
  trail.map((e) => (e.to_state ? `${e.action}:${e.to_state}` : e.action));

describe("provider outcomes", () => {
  it("happy path: created -> processing -> succeeded, fully audited", async () => {
    const h = harness();
    const p = (await h.pay(1000)).json();
    expect(p.state).toBe("succeeded");
    expect(p.providerChargeId).toMatch(/^ch_/);
    const trail = (await h.app.inject({ url: `/payments/${p.id}/events` })).json();
    expect(actions(trail)).toEqual([
      "payment_created:created",
      "state_changed:processing",
      "state_changed:succeeded",
    ]);
  });

  it("decline -> failed with the provider's reason", async () => {
    const p = (await harness().pay(1002)).json();
    expect([p.state, p.failureReason]).toEqual(["failed", "insufficient_funds"]);
  });

  it("requires_action is a resting state", async () => {
    expect((await harness().pay(1003)).json().state).toBe("requires_action");
  });

  it("transient 503s are retried with the same provider key: one charge", async () => {
    const h = harness();
    const p = (await h.pay(1004)).json();
    expect(p.state).toBe("succeeded");
    expect(h.provider.calls).toHaveLength(3);
    expect(new Set(h.provider.calls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(h.provider.charges.size).toBe(1);
    const trail = (await h.app.inject({ url: `/payments/${p.id}/events` })).json();
    expect(actions(trail).filter((a: string) => a === "provider_retry")).toHaveLength(2);
  });

  it("persistent 503 -> failed (provider says nothing was processed)", async () => {
    const h = harness();
    const p = (await h.pay(1007)).json();
    expect([p.state, p.failureReason]).toEqual(["failed", "provider_unavailable"]);
    expect(h.provider.calls).toHaveLength(4); // 1 + 3 retries
  });

  it("timeout leaves the payment processing; the webhook settles it", async () => {
    const h = harness();
    const p = (await h.pay(1005)).json();
    expect(p.state).toBe("processing");
    expect(p.providerChargeId).toBeNull();
    const trail = (await h.app.inject({ url: `/payments/${p.id}/events` })).json();
    expect(actions(trail)).toContain("provider_timeout_outcome_unknown");

    expect(await h.deliverAll()).toEqual([{ received: true, outcome: "applied" }]);
    const settled = h.service.get(p.id);
    expect(settled.state).toBe("succeeded");
    expect(settled.providerChargeId).toMatch(/^ch_/);
  });

  it("pending charge records the charge id, then succeeds via webhook", async () => {
    const h = harness();
    const p = (await h.pay(1006)).json();
    expect(p.state).toBe("processing");
    expect(p.providerChargeId).toMatch(/^ch_/);
    await h.deliverAll();
    expect(h.service.get(p.id).state).toBe("succeeded");
  });
});

describe("refunds", () => {
  it("refunds a succeeded payment once, even if retried", async () => {
    const h = harness();
    const p = (await h.pay(1000)).json();
    const headers = { "idempotency-key": "refund-key-01" };
    const r1 = await h.app.inject({ method: "POST", url: `/payments/${p.id}/refund`, headers });
    const r2 = await h.app.inject({ method: "POST", url: `/payments/${p.id}/refund`, headers });
    expect(r1.json().state).toBe("refunded");
    expect(r2.headers["idempotent-replayed"]).toBe("true");
    // The provider's own refund webhook arrives later and is a no-op.
    expect(await h.deliverAll()).toEqual([{ received: true, outcome: "no_op" }]);
  });

  it("cannot refund twice with a new key", async () => {
    const h = harness();
    const p = (await h.pay(1000)).json();
    await h.app.inject({
      method: "POST",
      url: `/payments/${p.id}/refund`,
      headers: { "idempotency-key": "refund-a-0001" },
    });
    const again = await h.app.inject({
      method: "POST",
      url: `/payments/${p.id}/refund`,
      headers: { "idempotency-key": "refund-b-0002" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("illegal_transition");
  });
});

describe("webhooks", () => {
  it("rejects a bad signature and changes nothing", async () => {
    const h = harness();
    const p = (await h.pay(1006)).json();
    const [d] = h.provider.drainWebhooks();
    if (!d) throw new Error("expected a webhook");
    const forged = h.provider.signEvent(d.event, "whsec_attacker_guess_000");
    const res = await h.deliver(forged);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("signature_mismatch");
    expect(h.service.get(p.id).state).toBe("processing");
  });

  it("rejects a replayed delivery outside the tolerance window", async () => {
    const h = harness();
    await h.pay(1006);
    const [d] = h.provider.drainWebhooks();
    if (!d) throw new Error("expected a webhook");
    h.advanceClock(10 * 60 * 1000);
    expect((await h.deliver(d)).json().error.code).toBe("signature_stale");
  });

  it("rolls back the dedupe record when applying an event fails, so redelivery works", async () => {
    const h = harness();
    const p = (await h.pay(1006)).json();
    const [d] = h.provider.drainWebhooks();
    if (!d) throw new Error("expected a webhook");

    const svc = h.service as unknown as { advance: (...args: unknown[]) => unknown };
    const original = svc.advance;
    svc.advance = () => {
      throw new Error("simulated crash mid-apply");
    };
    expect((await h.deliver(d)).statusCode).toBe(500);
    expect(h.service.get(p.id).state).toBe("processing");

    svc.advance = original;
    expect((await h.deliver(d)).json().outcome).toBe("applied"); // not "duplicate"
    expect(h.service.get(p.id).state).toBe("succeeded");
  });

  it("processes a duplicate delivery exactly once", async () => {
    const h = harness();
    const p = (await h.pay(1006)).json();
    const [d] = h.provider.drainWebhooks();
    if (!d) throw new Error("expected a webhook");
    const outcomes = [(await h.deliver(d)).json().outcome, (await h.deliver(d)).json().outcome];
    expect(outcomes).toEqual(["applied", "duplicate"]);
    const trail = (await h.app.inject({ url: `/payments/${p.id}/events` })).json();
    expect(actions(trail).filter((a: string) => a === "state_changed:succeeded")).toHaveLength(1);
  });

  it("ignores a late, out-of-order event instead of moving backwards", async () => {
    const h = harness();
    const p = (await h.pay(1000)).json(); // already succeeded synchronously
    const late = h.provider.signEvent({
      id: "evt_late_requires_action",
      type: "charge.requires_action",
      created: 0,
      data: { charge_id: p.providerChargeId, payment_id: p.id, amount: 1000, currency: "USD" },
    });
    expect((await h.deliver(late)).json().outcome).toBe("ignored_out_of_order");
    expect(h.service.get(p.id).state).toBe("succeeded");
  });

  it("refuses an event whose amount disagrees with ours", async () => {
    const h = harness();
    const p = (await h.pay(1006)).json();
    const evil = h.provider.signEvent({
      id: "evt_amount_mismatch",
      type: "charge.succeeded",
      created: 0,
      data: { charge_id: "ch_x", payment_id: p.id, amount: 1, currency: "USD" },
    });
    expect((await h.deliver(evil)).json().outcome).toBe("amount_mismatch");
    expect(h.service.get(p.id).state).toBe("processing");
  });

  it("acknowledges events for unknown payments without failing", async () => {
    const h = harness();
    const stray = h.provider.signEvent({
      id: "evt_stray",
      type: "charge.succeeded",
      created: 0,
      data: { charge_id: "ch_y", payment_id: "pay_unknown", amount: 5, currency: "USD" },
    });
    const res = await h.deliver(stray);
    expect([res.statusCode, res.json().outcome]).toEqual([200, "unknown_payment"]);
  });

  it("rejects a schema-invalid event even when signed", async () => {
    const h = harness();
    const body = JSON.stringify({ id: "evt_bad", type: "charge.exploded", created: 0, data: {} });
    const { sign } = await import("../src/signature.ts");
    const res = await h.app.inject({
      method: "POST",
      url: "/webhooks/provider",
      headers: {
        "content-type": "application/json",
        "provider-signature": sign(body, SECRET, 1_790_000_000),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });
});
