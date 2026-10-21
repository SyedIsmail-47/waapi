import { and, eq, isNull } from "drizzle-orm";
import { webhookEndpoints, webhookOutbox, type Db } from "@waapi/db";
import { enqueueDelivery } from "../services/webhooks/index.js";
import { insertEncryptedDelivery } from "../services/webhooks/deliveries.js";
import { decryptOutboxPayloadJson } from "../lib/payload-crypto.js";

async function processOutboxRows(database: Db): Promise<number> {
  let processed = 0;
  const rows = await database.db
    .select()
    .from(webhookOutbox)
    .where(isNull(webhookOutbox.processedAt))
    .limit(100);
  for (const row of rows) {
    const [endpoint] = await database.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.sessionId, row.sessionId), eq(webhookEndpoints.enabled, true)),
      )
      .limit(1);
    if (!endpoint) {
      await database.db.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      continue;
    }

    let plaintextJson: string;
    try {
      plaintextJson = decryptOutboxPayloadJson(row.payload as Record<string, unknown>, row.id);
    } catch {
      await database.db.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      continue;
    }
    const payload = JSON.parse(plaintextJson) as Record<string, unknown>;

    const deliveryId = await database.db.transaction(async (tx) => {
      const id = await insertEncryptedDelivery(tx, {
        endpointId: endpoint.id,
        accountId: row.accountId,
        sessionId: row.sessionId,
        eventType: row.eventType,
        payload,
      });
      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      return id;
    });
    await enqueueDelivery(deliveryId);
    processed += 1;
  }
  return processed;
}

/**
 * Poll unprocessed outbox rows: decrypt → insert encrypted delivery → DELETE
 * outbox row in one transaction, then enqueue BullMQ outside the txn.
 */
export function startOutboxPoller(database: Db): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processOutboxRows(database);
    } finally {
      running = false;
    }
  }, 1_000);
}

/** One-shot poll for tests (same semantics as the timer). */
export async function pollOutboxOnce(database: Db): Promise<number> {
  return processOutboxRows(database);
}
