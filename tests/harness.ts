import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { DEFAULT_SERVICE_CONFIG, PaymentService, type ServiceConfig } from "../src/payments.ts";
import { type SignedDelivery, SimulatedProvider } from "../src/provider.ts";

export const SECRET = "whsec_test_0123456789abcdef";

export function harness(overrides: Partial<ServiceConfig> = {}) {
  let current = new Date("2026-10-01T12:00:00Z");
  const now = () => new Date(current);
  const db = openDb();
  const provider = new SimulatedProvider(SECRET, () => Math.floor(current.getTime() / 1000));
  const config: ServiceConfig = {
    ...DEFAULT_SERVICE_CONFIG,
    providerTimeoutMs: 50,
    sleep: async () => {},
    ...overrides,
  };
  const service = new PaymentService(db, provider, now, config);
  const app = buildApp({ db, payments: service, webhookSecret: SECRET, now });
  let keySeq = 0;

  return {
    app,
    db,
    provider,
    service,
    advanceClock(ms: number) {
      current = new Date(current.getTime() + ms);
    },
    key: () => `test-key-${++keySeq}-${Date.now()}`,
    pay(amount: number, opts: { key?: string; customer?: string; currency?: string } = {}) {
      return app.inject({
        method: "POST",
        url: "/payments",
        headers: { "idempotency-key": opts.key ?? `k-${++keySeq}-abcdef` },
        payload: { amount, currency: opts.currency ?? "USD", customer_id: opts.customer ?? "cus_alice" },
      });
    },
    deliver(d: SignedDelivery) {
      return app.inject({ method: "POST", url: "/webhooks/provider", headers: d.headers, payload: d.body });
    },
    async deliverAll() {
      const out = [];
      for (const d of provider.drainWebhooks()) out.push((await this.deliver(d)).json());
      return out;
    },
  };
}
