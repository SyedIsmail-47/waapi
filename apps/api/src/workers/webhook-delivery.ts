import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { request } from "undici";
import { QUEUE_WEBHOOK_DELIVERY } from "@waapi/shared";
import { webhookDeliveries, webhookEndpoints, type Db } from "@waapi/db";
import { config } from "../config.js";
import { decryptSecret } from "../lib/crypto.js";
import { decryptPayloadJson } from "../lib/payload-crypto.js";
import { redis } from "../services/queues.js";
import { signWebhook } from "../services/webhooks/sign.js";
import {
  assertWebhookUrlShape,
  createPinnedAgent,
  dumpBodyLimited,
} from "../services/webhooks/ssrf.js";

/**
 * ~15 attempts over ~24h with jitter.
 * BullMQ passes attemptsMade (0-based after first failure for custom strategy).
 */
export function backoffWithJitter(attemptsMade: number): number {
  const scheduleMs = [
    5_000,
    15_000,
    30_000,
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    20 * 60_000,
    30 * 60_000,
    45 * 60_000,
    60 * 60_000,
    90 * 60_000,
    2 * 60 * 60_000,
    3 * 60 * 60_000,
    4 * 60 * 60_000,
  ];
  const base = scheduleMs[Math.min(Math.max(attemptsMade, 0), scheduleMs.length - 1)]!;
  const jitter = Math.floor(Math.random() * Math.min(30_000, base * 0.2));
  return base + jitter;
}

export function startWebhookDeliveryWorker(database: Db): Worker {
  const agent = createPinnedAgent();
  const maxAttempts = config.WEBHOOK_MAX_ATTEMPTS;
  const deadAfter = config.WEBHOOK_DEAD_AFTER_CONSECUTIVE;
  const brand = config.brand;

  return new Worker(
    QUEUE_WEBHOOK_DELIVERY,
    async (job) => {
      const [delivery] = await database.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, job.data.deliveryId as string))
        .limit(1);
      if (
        !delivery ||
        delivery.status === "success" ||
        delivery.status === "dead" ||
        delivery.status === "skipped"
      ) {
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
        if (delivery.payload == null) {
          await database.db
            .update(webhookDeliveries)
            .set({
              status: "skipped",
              lastError: "payload_purged",
              attempts: delivery.attempts + 1,
              updatedAt: new Date(),
            })
            .where(eq(webhookDeliveries.id, delivery.id));
          return;
        }
        const body = decryptPayloadJson(
          delivery.payload as Record<string, unknown>,
          delivery.id,
        );
        const timestamp = Math.floor(Date.now() / 1000);
        const secret = decryptSecret(endpoint.secretEncrypted, endpoint.id);
        const response = await request(url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": brand.userAgentWebhooks,
            [brand.headerEvent]: delivery.eventType,
            [brand.headerTimestamp]: String(timestamp),
            [brand.headerDeliveryId]: delivery.id,
            [brand.headerSignature]: `sha256=${signWebhook(secret, timestamp, body)}`,
          },
          body,
          dispatcher: agent,
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
        } as Parameters<typeof request>[1]);

        // Oversize bodies: stop reading; judge success by status code only.
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
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, delivery.id));
        await database.db
          .update(webhookEndpoints)
          .set({ consecutiveFailures: 0, updatedAt: new Date() })
          .where(eq(webhookEndpoints.id, endpoint.id));
      } catch (error) {
        const attempts = delivery.attempts + 1;
        const final =
          job.attemptsMade + 1 >= maxAttempts ||
          (endpoint != null && endpoint.consecutiveFailures + 1 >= deadAfter);
        const lastError = error instanceof Error ? error.message : String(error);

        await database.db
          .update(webhookDeliveries)
          .set({
            status: final ? "dead" : "retrying",
            attempts,
            lastError,
            updatedAt: new Date(),
          })
          .where(eq(webhookDeliveries.id, delivery.id));

        if (endpoint) {
          const nextFail = endpoint.consecutiveFailures + 1;
          await database.db
            .update(webhookEndpoints)
            .set({
              consecutiveFailures: nextFail,
              enabled: nextFail >= deadAfter ? false : endpoint.enabled,
              updatedAt: new Date(),
            })
            .where(eq(webhookEndpoints.id, endpoint.id));
        }

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
