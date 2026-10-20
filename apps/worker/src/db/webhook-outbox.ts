import { webhookOutbox } from "@waapi/db";
import type { WebhookEventType } from "@waapi/shared";
import type { Db } from "./client.js";

export async function enqueueWebhookOutbox(
  db: Db["db"],
  args: {
    accountId: string;
    sessionId: string;
    eventType: WebhookEventType;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(webhookOutbox).values({
    accountId: args.accountId,
    sessionId: args.sessionId,
    eventType: args.eventType,
    payload: args.payload,
  });
}
