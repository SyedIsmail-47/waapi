import { and, eq, sql } from "drizzle-orm";
import { webhookEndpoints, webhookOutbox, type Db } from "@waapi/db";
import { enqueueDelivery } from "../services/webhooks/index.js";
import { insertEncryptedDelivery } from "../services/webhooks/deliveries.js";
import { decryptOutboxPayloadJson } from "../lib/payload-crypto.js";

type ClaimedOutbox = {
  id: string;
  account_id: string;
  session_id: string;
  event_type: (typeof webhookOutbox.$inferSelect)["eventType"];
  payload: Record<string, unknown>;
};

type ClaimResult =
  | { status: "empty" }
  | { status: "skipped" }
  | { status: "delivered"; deliveryId: string };

/**
 * Claim one unprocessed outbox row with FOR UPDATE SKIP LOCKED, then
 * decrypt → insert encrypted delivery → DELETE outbox in the same transaction.
 */
async function claimAndProcessOne(database: Db): Promise<ClaimResult> {
  return database.db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      select id, account_id, session_id, event_type, payload
      from webhook_outbox
      where processed_at is null
      order by created_at
      limit 1
      for update skip locked
    `);
    const row = claimed[0] as ClaimedOutbox | undefined;
    if (!row) return { status: "empty" };

    const [endpoint] = await tx
      .select()
      .from(webhookEndpoints)
      .where(
        and(eq(webhookEndpoints.sessionId, row.session_id), eq(webhookEndpoints.enabled, true)),
      )
      .limit(1);
    if (!endpoint) {
      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      return { status: "skipped" };
    }

    let plaintextJson: string;
    try {
      plaintextJson = decryptOutboxPayloadJson(row.payload, row.id);
    } catch {
      await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
      return { status: "skipped" };
    }
    const payload = JSON.parse(plaintextJson) as Record<string, unknown>;

    const deliveryId = await insertEncryptedDelivery(tx, {
      endpointId: endpoint.id,
      accountId: row.account_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      payload,
    });
    await tx.delete(webhookOutbox).where(eq(webhookOutbox.id, row.id));
    return { status: "delivered", deliveryId };
  });
}

async function processOutboxRows(database: Db): Promise<number> {
  let processed = 0;
  const deliveryIds: string[] = [];
  for (let i = 0; i < 100; i++) {
    const result = await claimAndProcessOne(database);
    if (result.status === "empty") break;
    if (result.status === "delivered") {
      deliveryIds.push(result.deliveryId);
      processed += 1;
    }
  }
  for (const deliveryId of deliveryIds) {
    await enqueueDelivery(deliveryId);
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
