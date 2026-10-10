import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Idempotency-Key semantics (modelled on common PSP APIs):
//   same key + same body      -> replay the stored response, never re-execute
//   same key + different body -> 422, the client has a bug
//   same key while in flight  -> 409, retry later
//   5xx or thrown error       -> key released so the client can safely retry
//   keys expire after 24h

export const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;
export const KEY_TTL_MS = 24 * 60 * 60 * 1000;

export type Begin =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "conflict" }
  | { kind: "mismatch" };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function requestHash(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

interface Row {
  request_hash: string;
  status: "in_flight" | "done";
  response_code: number | null;
  response_body: string | null;
  created_at: string;
}

export class IdempotencyStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date) {
    this.db = db;
    this.now = now;
  }

  begin(scope: string, key: string, hash: string): Begin {
    const row = this.db
      .prepare(
        "SELECT request_hash, status, response_code, response_body, created_at FROM idempotency_keys WHERE scope = ? AND key = ?",
      )
      .get(scope, key) as Row | undefined;

    if (row && this.now().getTime() - Date.parse(row.created_at) > KEY_TTL_MS) {
      this.release(scope, key);
    } else if (row) {
      if (row.request_hash !== hash) return { kind: "mismatch" };
      if (row.status === "in_flight") return { kind: "conflict" };
      return {
        kind: "replay",
        status: row.response_code ?? 200,
        body: JSON.parse(row.response_body ?? "null"),
      };
    }

    try {
      this.db
        .prepare(
          "INSERT INTO idempotency_keys (scope, key, request_hash, status, created_at) VALUES (?, ?, ?, 'in_flight', ?)",
        )
        .run(scope, key, hash, this.now().toISOString());
      return { kind: "new" };
    } catch {
      return { kind: "conflict" }; // lost a race with a concurrent identical request
    }
  }

  complete(scope: string, key: string, status: number, body: unknown): void {
    this.db
      .prepare(
        "UPDATE idempotency_keys SET status = 'done', response_code = ?, response_body = ? WHERE scope = ? AND key = ?",
      )
      .run(status, JSON.stringify(body), scope, key);
  }

  release(scope: string, key: string): void {
    this.db.prepare("DELETE FROM idempotency_keys WHERE scope = ? AND key = ?").run(scope, key);
  }
}
