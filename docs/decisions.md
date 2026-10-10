# Design decisions

Short ADRs. Each records the decision, why it was made, and what it costs.

## ADR-1: A timeout is "unknown", never "failed"

**Context.** When `createCharge` times out, the provider may have charged the card. Marking the payment failed invites the customer to pay again, so they get charged twice. Retrying with a *new* provider key can also double charge.

**Decision.** On timeout, leave the payment in `processing`, write `provider_timeout_outcome_unknown` to the audit log, and return 201 with `state: processing`. The webhook settles it. If the webhook never comes, reconciliation reports `status_mismatch` (ours `processing`, theirs `captured`).

**Cost.** Clients must handle a non-final state. That is the honest API: the alternative lies about what we know.

## ADR-2: Two layers of idempotency

**Decision.** The client supplies an `Idempotency-Key`, stored with a canonical hash of the request body. The service passes the payment id as the provider's idempotency key. The first layer stops duplicate *payments*. The second stops duplicate *charges*, even when our own retries resend.

**Details.** A key that is still in flight returns 409, and a key reused with a different body returns 422. 2xx and 4xx responses are stored and replayed. On 5xx or a thrown error the key is released so a retry can proceed. Keys expire after 24 hours. The `(scope, key)` primary key, not application code, is what makes a racing duplicate lose.

## ADR-3: 503 means "not processed", so it is safe to fail

The simulated provider's documented contract is that a 503 was rejected before processing. Check your real provider's contract before copying this rule. After the retry budget (3 retries, full jitter), the payment fails with `provider_unavailable`. This is deliberately different from ADR-1: the protocol tells us more about a 503 than about a timeout.

## ADR-4: Webhook processing is exactly-once per event id

At-least-once delivery is a given. The `processed_events` insert (`INSERT OR IGNORE` on the event id) and the payment state change happen **in one transaction**. If applying the event fails, the dedupe row rolls back too and the provider's redelivery is processed normally. Duplicates still get 200, because a non-2xx would make the provider keep retrying something already handled.

## ADR-5: Transitions never go backwards; disagreements are recorded, not "fixed"

A late `charge.requires_action` after `succeeded` is ignored and audited as `transition_ignored`. An event whose amount or currency differs from ours is refused (`amount_mismatch`). Reconciliation reports differences and never edits either side. Silent auto-correction is how ledgers end up unexplainable.

## ADR-6: SQLite via `node:sqlite`, raw SQL

The invariants live in the database: a `CHECK (amount > 0)`, unique `provider_charge_id`, a primary key on idempotency keys and event ids, and triggers that make `audit_events` append-only. Raw SQL keeps those visible in review. `node:sqlite` ships with Node 24, so there is no native build. Production would use Postgres. The SQL is deliberately portable apart from `INSERT OR IGNORE` (`ON CONFLICT DO NOTHING` in Postgres).
