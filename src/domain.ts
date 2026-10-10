// Payment domain: states, legal transitions, and the errors the API maps to HTTP codes.

export const PAYMENT_STATES = [
  "created",
  "processing",
  "requires_action",
  "succeeded",
  "failed",
  "refunded",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const CURRENCIES = ["USD", "EUR", "GBP", "INR", "SGD"] as const;
export type Currency = (typeof CURRENCIES)[number];

// The only way a payment's state changes. Terminal states have no exits.
const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  created: ["processing", "failed"],
  processing: ["succeeded", "failed", "requires_action"],
  requires_action: ["processing", "succeeded", "failed"],
  succeeded: ["refunded"],
  failed: [],
  refunded: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Payment {
  id: string;
  customerId: string;
  amount: number; // integer minor units (cents, paise); never floats for money
  currency: Currency;
  state: PaymentState;
  providerChargeId: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class IllegalTransition extends DomainError {
  constructor(from: PaymentState, to: PaymentState) {
    super(409, "illegal_transition", `payment cannot move from ${from} to ${to}`);
  }
}

export class NotFound extends DomainError {
  constructor(what: string) {
    super(404, "not_found", `${what} not found`);
  }
}
