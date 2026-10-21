import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { sessions, webhookDeliveries, webhookEndpoints, type Db } from "@waapi/db";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { defaultJobOptions, webhookDeliveryQueue } from "../queues.js";
import { insertEncryptedDelivery } from "./deliveries.js";
import { assertPublicUrl } from "./ssrf.js";

export async function upsertWebhook(
  database: Db,
  accountId: string,
  sessionId: string,
  input: { url: string; secret?: string; enabled?: boolean },
) {
  await assertPublicUrl(input.url);
  const [session] = await database.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!session) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const [existing] = await database.db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.sessionId, sessionId))
    .limit(1);
  const endpointId = existing?.id ?? randomUUID();
  const secret =
    input.secret ??
    (existing
      ? decryptSecret(existing.secretEncrypted, existing.id)
      : randomBytes(32).toString("base64url"));
  const values = {
    accountId,
    sessionId,
    url: input.url,
    enabled: input.enabled ?? true,
    secretEncrypted: encryptSecret(secret, endpointId),
    consecutiveFailures: 0,
    updatedAt: new Date(),
  };
  const [row] = existing
    ? await database.db
        .update(webhookEndpoints)
        .set(values)
        .where(eq(webhookEndpoints.id, existing.id))
        .returning()
    : await database.db.insert(webhookEndpoints).values({ id: endpointId, ...values }).returning();
  return { ...row!, secret: existing && !input.secret ? undefined : secret };
}

export async function removeWebhook(database: Db, accountId: string, sessionId: string) {
  const [session] = await database.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!session) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  await database.db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.sessionId, sessionId)));
}

export async function getWebhook(database: Db, accountId: string, sessionId: string) {
  const [row] = await database.db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      enabled: webhookEndpoints.enabled,
      createdAt: webhookEndpoints.createdAt,
      updatedAt: webhookEndpoints.updatedAt,
    })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.sessionId, sessionId)))
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Webhook not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  return row;
}

export async function testWebhook(database: Db, accountId: string, sessionId: string) {
  const [endpoint] = await database.db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.sessionId, sessionId)))
    .limit(1);
  if (!endpoint) {
    throw Object.assign(new Error("Webhook not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const payload = {
    id: crypto.randomUUID(),
    type: "session.status" as const,
    accountId,
    sessionId,
    createdAt: new Date().toISOString(),
    data: { status: "connected", test: true },
  };
  return insertEncryptedDelivery(database.db, {
    endpointId: endpoint.id,
    accountId,
    sessionId,
    eventType: "session.status",
    payload,
  });
}

export async function enqueueDelivery(id: string, jobId?: string): Promise<void> {
  const { config } = await import("../../config.js");
  await webhookDeliveryQueue.add(
    "deliver",
    { deliveryId: id },
    {
      ...defaultJobOptions,
      jobId: jobId ?? id,
      attempts: config.WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: "custom" },
    },
  );
}

export async function listDeliveries(
  database: Db,
  accountId: string,
  sessionId: string,
  opts: { cursor?: string; limit?: number } = {},
) {
  const [session] = await database.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)))
    .limit(1);
  if (!session) {
    throw Object.assign(new Error("Session not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const conditions = [
    eq(webhookDeliveries.accountId, accountId),
    eq(webhookDeliveries.sessionId, sessionId),
  ];
  if (opts.cursor) {
    const decoded = Buffer.from(opts.cursor, "base64url").toString("utf8");
    const cursorDate = new Date(decoded);
    if (Number.isNaN(cursorDate.getTime())) {
      throw Object.assign(new Error("Invalid cursor"), { statusCode: 400, code: "VALIDATION_ERROR" });
    }
    conditions.push(lt(webhookDeliveries.createdAt, cursorDate));
  }
  const rows = await database.db
    .select({
      id: webhookDeliveries.id,
      eventType: webhookDeliveries.eventType,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      lastError: webhookDeliveries.lastError,
      responseCode: webhookDeliveries.responseCode,
      createdAt: webhookDeliveries.createdAt,
      updatedAt: webhookDeliveries.updatedAt,
    })
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const next =
    rows.length > limit
      ? Buffer.from(page[page.length - 1]!.createdAt.toISOString(), "utf8").toString("base64url")
      : null;
  return { items: page, nextCursor: next };
}

/** Re-queue a failed/dead delivery for another attempt cycle. */
export async function replayDelivery(
  database: Db,
  accountId: string,
  sessionId: string,
  deliveryId: string,
): Promise<{ deliveryId: string; queued: true }> {
  const [delivery] = await database.db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.accountId, accountId),
        eq(webhookDeliveries.sessionId, sessionId),
      ),
    )
    .limit(1);
  if (!delivery) {
    throw Object.assign(new Error("Delivery not found"), { statusCode: 404, code: "NOT_FOUND" });
  }
  await database.db
    .update(webhookDeliveries)
    .set({ status: "pending", lastError: null, updatedAt: new Date() })
    .where(eq(webhookDeliveries.id, deliveryId));
  await enqueueDelivery(deliveryId, `replay-${deliveryId}-${Date.now()}`);
  return { deliveryId, queued: true };
}
