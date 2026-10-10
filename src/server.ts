import { buildApp } from "./app.ts";
import { openDb } from "./db.ts";
import { PaymentService } from "./payments.ts";
import { SimulatedProvider } from "./provider.ts";

// Local server against the simulated provider. Webhooks are "delivered" back into the
// app shortly after they are emitted, the way a real provider would call you.

const secret = process.env.WEBHOOK_SECRET;
if (!secret || secret.length < 16) {
  console.error("Set WEBHOOK_SECRET (>= 16 chars). See .env.example.");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const now = () => new Date();
const db = openDb(process.env.DATABASE_PATH ?? ":memory:");
const provider = new SimulatedProvider(secret);
const app = buildApp({
  db,
  payments: new PaymentService(db, provider, now),
  webhookSecret: secret,
  now,
  logger: true,
});

setInterval(async () => {
  for (const d of provider.drainWebhooks()) {
    await app.inject({ method: "POST", url: "/webhooks/provider", headers: d.headers, payload: d.body });
  }
}, 250).unref();

await app.listen({ port, host: "127.0.0.1" });
