import type { Payment } from "./domain.ts";

// Compare our ledger with the provider's settlement report. The two sources are
// independent; disagreement is the signal, never something to silently "fix".

export type Finding =
  | { kind: "matched"; paymentId: string; chargeId: string }
  | { kind: "amount_mismatch"; paymentId: string; chargeId: string; ours: number; theirs: number }
  | { kind: "status_mismatch"; paymentId: string; chargeId: string; ours: string; theirs: string }
  | { kind: "missing_at_provider"; paymentId: string; chargeId: string | null; ours: string }
  | { kind: "unknown_to_us"; chargeId: string; theirs: string; amount: number };

export interface SettlementRow {
  chargeId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: "captured" | "refunded";
}

export class SettlementParseError extends Error {}

const HEADER = "charge_id,payment_id,amount,currency,status";

export function parseSettlement(csv: string): SettlementRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0]?.trim() !== HEADER) throw new SettlementParseError(`expected header "${HEADER}"`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    const [chargeId, paymentId, amount, currency, status] = cells;
    if (cells.length !== 5 || !chargeId || !paymentId || !currency || !amount || !/^\d+$/.test(amount)) {
      throw new SettlementParseError(`line ${i + 2}: malformed row`);
    }
    if (status !== "captured" && status !== "refunded") {
      throw new SettlementParseError(`line ${i + 2}: unknown status "${status}"`);
    }
    return { chargeId, paymentId, amount: Number(amount), currency, status };
  });
}

const EXPECTED: Partial<Record<Payment["state"], SettlementRow["status"]>> = {
  succeeded: "captured",
  refunded: "refunded",
};

export function reconcile(payments: Payment[], settlement: SettlementRow[]) {
  const theirs = new Map(settlement.map((r) => [r.chargeId, r]));
  const byPayment = new Map(settlement.map((r) => [r.paymentId, r]));
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const p of payments) {
    // A payment stuck in "processing" (e.g. a timed-out call) has no charge id yet;
    // the settlement row is matched by payment id to recover it.
    const row = (p.providerChargeId && theirs.get(p.providerChargeId)) || byPayment.get(p.id);
    const expected = EXPECTED[p.state];
    if (!row) {
      if (expected)
        findings.push({
          kind: "missing_at_provider",
          paymentId: p.id,
          chargeId: p.providerChargeId,
          ours: p.state,
        });
      continue;
    }
    seen.add(row.chargeId);
    if (row.amount !== p.amount || row.currency !== p.currency) {
      findings.push({
        kind: "amount_mismatch",
        paymentId: p.id,
        chargeId: row.chargeId,
        ours: p.amount,
        theirs: row.amount,
      });
    } else if (expected !== row.status) {
      findings.push({
        kind: "status_mismatch",
        paymentId: p.id,
        chargeId: row.chargeId,
        ours: p.state,
        theirs: row.status,
      });
    } else {
      findings.push({ kind: "matched", paymentId: p.id, chargeId: row.chargeId });
    }
  }
  for (const row of settlement) {
    if (!seen.has(row.chargeId)) {
      findings.push({
        kind: "unknown_to_us",
        chargeId: row.chargeId,
        theirs: row.status,
        amount: row.amount,
      });
    }
  }

  const summary: Record<Finding["kind"], number> = {
    matched: 0,
    amount_mismatch: 0,
    status_mismatch: 0,
    missing_at_provider: 0,
    unknown_to_us: 0,
  };
  for (const f of findings) summary[f.kind]++;
  return { summary, exceptions: findings.filter((f) => f.kind !== "matched"), findings };
}
