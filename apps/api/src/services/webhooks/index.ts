import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sessions, webhookDeliveries, webhookEndpoints, type Db } from "@waapi/db";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { defaultJobOptions, webhookDeliveryQueue } from "../queues.js";
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
  const [delivery] = await database.db
    .insert(webhookDeliveries)
    .values({
      endpointId: endpoint.id,
      accountId,
      sessionId,
      eventType: "session.status",
      payload,
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    })
    .returning();
  return delivery!.id;
}

export async function enqueueDelivery(id: string): Promise<void> {
  await webhookDeliveryQueue.add(
    "deliver",
    { deliveryId: id },
    {
      ...defaultJobOptions,
      jobId: id,
      attempts: 8,
      backoff: { type: "custom" },
    },
  );
}
