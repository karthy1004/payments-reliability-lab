// Runs every failure scenario in-process against the simulated provider and prints what
// the service did. No network, no ports, no keys: `npm run demo`.

import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { DEFAULT_SERVICE_CONFIG, PaymentService } from "../src/payments.ts";
import { SimulatedProvider } from "../src/provider.ts";

const SECRET = "whsec_demo_only_not_a_real_secret";
const now = () => new Date();
const db = openDb();
const provider = new SimulatedProvider(SECRET);
const service = new PaymentService(db, provider, now, {
  ...DEFAULT_SERVICE_CONFIG,
  providerTimeoutMs: 200,
  sleep: async () => {},
});
const app = buildApp({ db, payments: service, webhookSecret: SECRET, now });

const pay = async (amount: number, key: string, customer: string) =>
  app.inject({
    method: "POST",
    url: "/payments",
    headers: { "idempotency-key": key },
    payload: { amount, currency: "USD", customer_id: customer },
  });

const scenarios: Array<[string, number]> = [
  ["succeeds", 1000],
  ["card declined", 1002],
  ["needs 3-D Secure", 1003],
  ["provider 503 x2, then ok", 1004],
  ["provider times out (charge DID happen)", 1005],
  ["pending, settles by webhook", 1006],
  ["provider down for good", 1007],
];

console.log("1) Payment scenarios\n");
console.log(`${"scenario".padEnd(40)}${"state".padEnd(17)}${"provider calls".padEnd(16)}reason`);
const ids: Record<string, string> = {};
for (const [i, [name, amount]] of scenarios.entries()) {
  const before = provider.calls.length;
  const p = (await pay(amount, `demo-${i}-${amount}`, `cus_demo${i}x`)).json();
  ids[name] = p.id;
  console.log(
    `${name.padEnd(40)}${p.state.padEnd(17)}${String(provider.calls.length - before).padEnd(16)}${p.failureReason ?? ""}`,
  );
}

console.log("\n2) Client retries the first request with the same Idempotency-Key");
const retry = await pay(1000, "demo-0-1000", "cus_demo0x");
console.log(
  `   status ${retry.statusCode}, replayed=${retry.headers["idempotent-replayed"]}, charges at provider for it: ${
    [...provider.charges.values()].filter((c) => c.paymentId === ids.succeeds).length
  }`,
);
const misuse = await pay(9999, "demo-0-1000", "cus_demo0x");
console.log(`   same key, different body -> ${misuse.statusCode} ${misuse.json().error.code}`);

console.log("\n3) Webhooks arrive: one duplicated, one forged, one late");
const deliveries = provider.drainWebhooks();
const post = (headers: Record<string, string>, body: string) =>
  app.inject({ method: "POST", url: "/webhooks/provider", headers, payload: body });
for (const d of deliveries) {
  const r = (await post(d.headers, d.body)).json();
  console.log(`   ${d.event.type.padEnd(18)} for ${d.event.data.payment_id.slice(0, 12)}… -> ${r.outcome}`);
}
const first = deliveries[0];
if (first) {
  console.log(
    `   redelivery of ${first.event.id.slice(0, 12)}…           -> ${(await post(first.headers, first.body)).json().outcome}`,
  );
  const forged = provider.signEvent(first.event, "whsec_guessed_by_attacker");
  const res = await post(forged.headers, forged.body);
  console.log(`   forged signature                     -> ${res.statusCode} ${res.json().error.code}`);
}
const late = provider.signEvent({
  id: "evt_late_demo",
  type: "charge.requires_action",
  created: Math.floor(Date.now() / 1000),
  data: { charge_id: "ch_x", payment_id: ids.succeeds ?? "", amount: 1000, currency: "USD" },
});
console.log(
  `   late requires_action after success   -> ${(await post(late.headers, late.body)).json().outcome}`,
);
console.log(
  `   timed-out payment is now: ${service.get(ids["provider times out (charge DID happen)"] ?? "").state}`,
);

console.log("\n4) End-of-day reconciliation against the provider's settlement file");
const short = service.get(ids["provider 503 x2, then ok"] ?? "");
provider.tamper(short.providerChargeId ?? "", { amount: 990 });
provider.addOrphanCharge(4200, "USD");
const report = (
  await app.inject({
    method: "POST",
    url: "/reconciliation",
    headers: { "content-type": "text/csv" },
    payload: provider.settlementCsv(),
  })
).json();
console.log("   summary:", JSON.stringify(report.summary));
for (const e of report.exceptions) console.log("   exception:", JSON.stringify(e));
