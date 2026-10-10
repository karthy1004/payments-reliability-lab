import { describe, expect, it } from "vitest";
import { parseSettlement, SettlementParseError } from "../src/reconcile.ts";
import { harness } from "./harness.ts";

async function run(h: ReturnType<typeof harness>, csv = h.provider.settlementCsv()) {
  return (
    await h.app.inject({
      method: "POST",
      url: "/reconciliation",
      headers: { "content-type": "text/csv" },
      payload: csv,
    })
  ).json();
}

describe("reconciliation", () => {
  it("matches a clean day", async () => {
    const h = harness();
    for (const amount of [1000, 1004, 1006]) await h.pay(amount, { customer: `cus_c${amount}` });
    await h.deliverAll();
    const report = await run(h);
    expect(report.summary).toEqual({
      matched: 3,
      amount_mismatch: 0,
      status_mismatch: 0,
      missing_at_provider: 0,
      unknown_to_us: 0,
    });
  });

  it("surfaces every kind of break", async () => {
    const h = harness();
    const ok = (await h.pay(1000, { customer: "cus_ok01" })).json();
    const short = (await h.pay(2000, { customer: "cus_sh01" })).json();
    const timedOut = (await h.pay(1005, { customer: "cus_to01" })).json(); // webhook never delivered
    const ghost = (await h.pay(3000, { customer: "cus_gh01" })).json();
    h.provider.drainWebhooks(); // drop them: simulates a webhook outage

    h.provider.tamper(short.providerChargeId, { amount: 1990 });
    h.provider.charges.delete(ghost.providerChargeId);
    const orphan = h.provider.addOrphanCharge(500, "USD");

    const report = await run(h);
    expect(report.summary).toEqual({
      matched: 1,
      amount_mismatch: 1,
      status_mismatch: 1,
      missing_at_provider: 1,
      unknown_to_us: 1,
    });
    const kinds = Object.fromEntries(report.exceptions.map((e: { kind: string }) => [e.kind, e]));
    expect(kinds.amount_mismatch).toMatchObject({ paymentId: short.id, ours: 2000, theirs: 1990 });
    expect(kinds.status_mismatch).toMatchObject({
      paymentId: timedOut.id,
      ours: "processing",
      theirs: "captured",
    });
    expect(kinds.missing_at_provider).toMatchObject({ paymentId: ghost.id });
    expect(kinds.unknown_to_us).toMatchObject({ chargeId: orphan.id });
    expect(report.findings.find((f: { kind: string }) => f.kind === "matched").paymentId).toBe(ok.id);
  });

  it.each([
    ["wrong header", "id,amount\n1,2"],
    ["non-integer amount", "charge_id,payment_id,amount,currency,status\nch_1,pay_1,10.5,USD,captured"],
    ["unknown status", "charge_id,payment_id,amount,currency,status\nch_1,pay_1,10,USD,lost"],
    ["missing cell", "charge_id,payment_id,amount,currency,status\nch_1,pay_1,10,USD"],
  ])("rejects a malformed settlement file: %s", async (_name, csv) => {
    expect(() => parseSettlement(csv)).toThrow(SettlementParseError);
    const res = await harness().app.inject({
      method: "POST",
      url: "/reconciliation",
      headers: { "content-type": "text/csv" },
      payload: csv,
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires CSV", async () => {
    const res = await harness().app.inject({ method: "POST", url: "/reconciliation", payload: { a: 1 } });
    expect(res.statusCode).toBe(415);
  });
});
