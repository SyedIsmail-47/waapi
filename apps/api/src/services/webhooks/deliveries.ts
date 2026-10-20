import { createHash, randomUUID } from "node:crypto";
import { webhookDeliveries, type Db } from "@waapi/db";
import { wrapDeliveryPayload } from "../../lib/payload-crypto.js";

/** Insert a delivery with AES-GCM encrypted payload (AAD = delivery id). */
export async function insertEncryptedDelivery(
  database: Db,
  args: {
    endpointId: string;
    accountId: string;
    sessionId: string;
    eventType: (typeof webhookDeliveries.$inferInsert)["eventType"];
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  const { stored, hash } = wrapDeliveryPayload(args.payload, id);
  await database.db.insert(webhookDeliveries).values({
    id,
    endpointId: args.endpointId,
    accountId: args.accountId,
    sessionId: args.sessionId,
    eventType: args.eventType,
    payload: stored,
    payloadHash: hash,
  });
  return id;
}

export function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
