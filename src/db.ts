import { DatabaseSync } from "node:sqlite";

// One file, no ORM: the schema is part of the design and should be readable in review.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL,
  amount              INTEGER NOT NULL CHECK (amount > 0),
  currency            TEXT NOT NULL,
  state               TEXT NOT NULL,
  provider_charge_id  TEXT UNIQUE,
  failure_reason      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_customer_created ON payments (customer_id, created_at);

-- Idempotency: one row per (scope, key). The PRIMARY KEY is what makes a concurrent
-- duplicate request fail fast instead of charging twice.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('in_flight', 'done')),
  response_code  INTEGER,
  response_body  TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Webhook dedupe: providers deliver at-least-once.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payment_id   TEXT,
  outcome      TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

-- Append-only audit trail. Nothing in the code issues UPDATE or DELETE on it.
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  payment_id  TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  detail      TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
`;

export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
