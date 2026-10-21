import { createDb } from "@waapi/db";
import { config } from "./config.js";
import { startOutboxPoller } from "./workers/outbox-poller.js";
import { startWebhookDeliveryWorker } from "./workers/webhook-delivery.js";

async function main(): Promise<void> {
  const database = createDb(config.DATABASE_URL);
  const webhookWorker = startWebhookDeliveryWorker(database);
  const poller = startOutboxPoller(database);
  console.log(JSON.stringify({ service: "webhooks", status: "started" }));

  const shutdown = async () => {
    clearInterval(poller);
    await webhookWorker.close();
    await database.client.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
