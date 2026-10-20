import { and, eq } from "drizzle-orm";
import { webhookEndpoints, webhookOutbox } from "@waapi/db";
import type { WebhookEventType } from "@waapi/shared";
import { randomUUID } from "node:crypto";
import type { Db } from "./client.js";
import { encryptOutboxPayload } from "../lib/outbox-crypto.js";

/**
 * Enqueue messages.upsert (and other events) only when an enabled webhook
 * endpoint exists. Payload is AES-GCM encrypted at rest (AAD = outbox id).
 * Returns outbox id, or null when skipped (no endpoint).
 */
export async function enqueueWebhookOutbox(
  // Accept monorepo @waapi/db handle or worker-local drizzle (schema variance).
  db: {
    select: Db["db"]["select"];
    insert: Db["db"]["insert"];
  },
  args: {
    accountId: string;
    sessionId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
  },
): Promise<string | null> {
  const [endpoint] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(eq(webhookEndpoints.sessionId, args.sessionId), eq(webhookEndpoints.enabled, true)),
    )
    .limit(1);
  if (!endpoint) return null;

  const id = randomUUID();
  const stored = encryptOutboxPayload(args.payload, id);
  await db.insert(webhookOutbox).values({
    id,
    accountId: args.accountId,
    sessionId: args.sessionId,
    eventType: args.eventType,
    payload: stored as unknown as Record<string, unknown>,
  });
  return id;
}
