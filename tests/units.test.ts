import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { canTransition, PAYMENT_STATES } from "../src/domain.ts";
import { requestHash } from "../src/idempotency.ts";
import { backoffDelay, TimeoutError, withRetry, withTimeout } from "../src/retry.ts";
import { sign, verify } from "../src/signature.ts";

describe("state machine", () => {
  it("allows exactly the documented transitions", () => {
    const allowed = PAYMENT_STATES.flatMap((from) =>
      PAYMENT_STATES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed).toEqual([
      "created->processing",
      "created->failed",
      "processing->requires_action",
      "processing->succeeded",
      "processing->failed",
      "requires_action->processing",
      "requires_action->succeeded",
      "requires_action->failed",
      "succeeded->refunded",
    ]);
  });

  it("has no exits from terminal states", () => {
    for (const terminal of ["failed", "refunded"] as const) {
      expect(PAYMENT_STATES.some((to) => canTransition(terminal, to))).toBe(false);
    }
  });
});

describe("webhook signatures", () => {
  const body = '{"id":"evt_1"}';
  const secret = "whsec_unit";
  const t = 1_790_000_000;

  it("accepts a valid signature", () => {
    expect(verify(body, sign(body, secret, t), secret, t)).toEqual({ ok: true });
  });

  it.each([
    ["tampered body", '{"id":"evt_2"}', sign(body, secret, t), t, "mismatch"],
    ["wrong secret", body, sign(body, "whsec_other", t), t, "mismatch"],
    ["too old (replay)", body, sign(body, secret, t), t + 301, "stale"],
    ["too far in future", body, sign(body, secret, t), t - 301, "stale"],
    ["no header", body, undefined, t, "missing"],
    ["garbage header", body, "hello", t, "malformed"],
    ["non-hex signature", body, `t=${t},v1=zz`, t, "malformed"],
  ])("rejects %s", (_name, raw, header, now, reason) => {
    expect(verify(raw, header, secret, now)).toEqual({ ok: false, reason });
  });

  it("supports secret rotation via multiple v1 values", () => {
    const oldSig = sign(body, "whsec_old", t).split(",")[1];
    const header = `${sign(body, secret, t)},${oldSig}`;
    expect(verify(body, header, "whsec_old", t)).toEqual({ ok: true });
    expect(verify(body, header, secret, t)).toEqual({ ok: true });
  });
});

describe("retry and timeout", () => {
  const noSleep = async () => {};

  it("retries retryable errors then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { retries: 3, baseMs: 10, maxMs: 100, isRetryable: () => true, sleep: noSleep },
    );
    expect([result, calls]).toEqual(["ok", 3]);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("fatal");
        },
        { retries: 3, baseMs: 10, maxMs: 100, isRetryable: () => false, sleep: noSleep },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("still down");
        },
        { retries: 2, baseMs: 10, maxMs: 100, isRetryable: () => true, sleep: noSleep },
      ),
    ).rejects.toThrow("still down");
    expect(calls).toBe(3);
  });

  it("caps backoff and applies full jitter", () => {
    expect(backoffDelay(0, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelay(3, 100, 1000, () => 0)).toBe(0);
  });

  it("times out a hung call", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "hung")).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(Promise.resolve(7), 10, "fast")).resolves.toBe(7);
  });
});

describe("request hashing", () => {
  it("is independent of key order", () => {
    expect(requestHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(requestHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe("audit table", () => {
  it("is append-only at the database level", () => {
    const db = openDb();
    db.prepare("INSERT INTO audit_events (at, actor, action) VALUES ('t', 'x', 'y')").run();
    expect(() => db.prepare("UPDATE audit_events SET actor = 'z'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });
});
