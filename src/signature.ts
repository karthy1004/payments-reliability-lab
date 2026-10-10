import { createHmac, timingSafeEqual } from "node:crypto";

// Header format: "t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>]".
// Signed payload is `${t}.${rawBody}` so the timestamp can't be swapped independently.
// Multiple v1 values let a provider rotate secrets without downtime.

export const SIGNATURE_HEADER = "provider-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function sign(rawBody: string, secret: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "stale" | "mismatch" };

export function verify(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  if (!header) return { ok: false, reason: "missing" };
  let timestamp: number | undefined;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && v && /^[0-9a-f]{64}$/.test(v)) candidates.push(v);
  }
  if (timestamp === undefined || candidates.length === 0) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return { ok: false, reason: "stale" };

  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"));
  const match = candidates.some((c) => timingSafeEqual(Buffer.from(c), expected));
  return match ? { ok: true } : { ok: false, reason: "mismatch" };
}
