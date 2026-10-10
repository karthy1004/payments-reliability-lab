import type { DatabaseSync } from "node:sqlite";
import type { Currency } from "./domain.ts";

// Deliberately simple, explainable pre-authorisation rules. Each decline names its rule.

export interface RiskConfig {
  maxAttemptsPerWindow: number;
  windowMs: number;
  maxAmount: Record<Currency, number>; // minor units
}

export const DEFAULT_RISK: RiskConfig = {
  maxAttemptsPerWindow: 5,
  windowMs: 10 * 60 * 1000,
  maxAmount: { USD: 1_000_000, EUR: 1_000_000, GBP: 1_000_000, SGD: 1_500_000, INR: 80_000_000 },
};

export type RiskDecision = { allow: true } | { allow: false; rule: "velocity" | "amount_limit" };

export function assessRisk(
  db: DatabaseSync,
  config: RiskConfig,
  input: { customerId: string; amount: number; currency: Currency },
  now: Date,
): RiskDecision {
  if (input.amount > config.maxAmount[input.currency]) return { allow: false, rule: "amount_limit" };
  const since = new Date(now.getTime() - config.windowMs).toISOString();
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM payments WHERE customer_id = ? AND created_at > ?")
    .get(input.customerId, since) as { n: number };
  if (row.n >= config.maxAttemptsPerWindow) return { allow: false, rule: "velocity" };
  return { allow: true };
}
