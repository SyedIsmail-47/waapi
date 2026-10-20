import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { request } from "undici";
import { QUEUE_WEBHOOK_DELIVERY } from "@waapi/shared";
import { webhookDeliveries, webhookEndpoints, type Db } from "@waapi/db";
import { decryptSecret } from "../lib/crypto.js";
import { redis } from "../services/queues.js";
import { signWebhook } from "../services/webhooks/sign.js";
import {
  assertWebhookUrlShape,
  createPinnedAgent,
  dumpBodyLimited,
} from "../services/webhooks/ssrf.js";

function backoffWithJitter(attempts: number): number {
  const base = Math.min(3_600_000, 1_000 * 2 ** attempts);
  const jitter = Math.floor(Math.random() * Math.min(1_000, base * 0.2));
  return base + jitter;
}

export function startWebhookDeliveryWorker(database: Db): Worker {
  const agent = createPinnedAgent();

  return new Worker(
    QUEUE_WEBHOOK_DELIVERY,
    async (job) => {
      const [delivery] = await database.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, job.data.deliveryId as string))
        .limit(1);
      if (!delivery || delivery.status === "success" || delivery.status === "dead" || delivery.status === "skipped") {
        return;
      }
      const [endpoint] = await database.db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, delivery.endpointId))
        .limit(1);

      try {
        if (!endpoint) {
          await database.db
            .update(webhookDeliveries)
            .set({
              status: "skipped",
              lastError: "endpoint_missing",
              attempts: delivery.attempts + 1,
              updatedAt: new Date(),
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }
        if (!endpoint.enabled) {
          await database.db
            .update(webhookDeliveries)
            .set({
              status: "skipped",
              lastError: "endpoint_disabled",
              attempts: delivery.attempts + 1,
              updatedAt: new Date(),
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }

        const url = assertWebhookUrlShape(endpoint.url);
        const body = JSON.stringify(delivery.payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const response = await request(url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "waapi-webhooks/1.0",
            "x-waapi-event": delivery.eventType,
            "x-waapi-timestamp": String(timestamp),
            "x-waapi-delivery-id": delivery.id,
            "x-waapi-signature": `sha256=${signWebhook(decryptSecret(endpoint.secretEncrypted), timestamp, body)}`,
          },
          body,
          dispatcher: agent,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
          // undici request does not follow redirects by default (maxRedirections: 0)
        } as Parameters<typeof request>[1]);
        await dumpBodyLimited(response.body);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new Error(`HTTP ${response.statusCode}`);
        }
        await database.db
          .update(webhookDeliveries)
          .set({
            status: "success",
            attempts: delivery.attempts + 1,
            responseCode: response.statusCode,
            updatedAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
      } catch (error) {
        const final = job.attemptsMade + 1 >= 8;
        await database.db
          .update(webhookDeliveries)
          .set({
            status: final ? "dead" : "retrying",
            attempts: delivery.attempts + 1,
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        throw error;
      }
    },
    {
      connection: redis,
      concurrency: 10,
      settings: { backoffStrategy: backoffWithJitter },
    },
  );
}
