import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { webhookDeliveries, webhookEndpoints, webhookOutbox, type Db } from "@waapi/db";
import { enqueueDelivery } from "../services/webhooks/index.js";

export function startOutboxPoller(database: Db): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const rows = await database.db.select().from(webhookOutbox).where(isNull(webhookOutbox.processedAt)).limit(100);
      for (const row of rows) {
        const [endpoint] = await database.db.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.sessionId, row.sessionId), eq(webhookEndpoints.enabled, true))).limit(1);
        if (!endpoint) {
          await database.db.update(webhookOutbox).set({ processedAt: new Date() }).where(eq(webhookOutbox.id, row.id));
          continue;
        }
        const body = JSON.stringify(row.payload);
        const [delivery] = await database.db.transaction(async (tx) => {
          const inserted = await tx.insert(webhookDeliveries).values({
            endpointId: endpoint.id, accountId: row.accountId, sessionId: row.sessionId,
            eventType: row.eventType, payload: row.payload, payloadHash: createHash("sha256").update(body).digest("hex"),
          }).returning();
          await tx.update(webhookOutbox).set({ processedAt: new Date() }).where(eq(webhookOutbox.id, row.id));
          return inserted;
        });
        await enqueueDelivery(delivery!.id);
      }
    } finally {
      running = false;
    }
  }, 1_000);
}
