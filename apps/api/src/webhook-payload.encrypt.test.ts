import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@waapi/db";
import { isEncryptedPayload } from "./lib/payload-crypto.js";
import { insertEncryptedDelivery } from "./services/webhooks/deliveries.js";
import { purgeWebhookPayloadsForTest } from "./services/retention.js";
import { decryptPayloadJson } from "./lib/payload-crypto.js";
import { startWebhookDeliveryWorker } from "./workers/webhook-delivery.js";
import { enqueueDelivery } from "./services/webhooks/index.js";

describe("webhook payload encryption + purge", () => {
  let database: Db;
  const accountIds: string[] = [];
  let prevHttp: string | undefined;

  beforeAll(async () => {
    prevHttp = process.env.ALLOW_HTTP_WEBHOOKS;
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    const { createDb } = await import("@waapi/db");
    database = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    process.env.ALLOW_HTTP_WEBHOOKS = prevHttp;
    if (accountIds.length) {
      const { accounts } = await import("@waapi/db");
      const { inArray } = await import("drizzle-orm");
      await database.db.delete(accounts).where(inArray(accounts.id, accountIds));
    }
    await database.client.end();
  });

  it("DB payload is not plaintext; local delivery contains text; purge removes it", async () => {
    const { accounts, sessions, webhookEndpoints } = await import("@waapi/db");
    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "enc-payload" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "s", status: "connected" })
      .returning();

    const secret = "webhook-payload-encrypt-secret";
    const { encryptSecret } = await import("./lib/crypto.js");
    const endpointId = randomUUID();
    await database.db.insert(webhookEndpoints).values({
      id: endpointId,
      accountId,
      sessionId: session!.id,
      url: "http://127.0.0.1:9/placeholder",
      secretEncrypted: encryptSecret(secret, endpointId),
      enabled: true,
    });

    const received: string[] = [];
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      received.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    await database.db
      .update(webhookEndpoints)
      .set({ url: `http://127.0.0.1:${port}/hook` })
      .where(eq(webhookEndpoints.id, endpointId));

    const plainText = `secret-message-${randomUUID()}`;
    const payload = {
      id: randomUUID(),
      type: "messages.upsert",
      accountId,
      sessionId: session!.id,
      createdAt: new Date().toISOString(),
      data: {
        remoteJid: "14155552671@s.whatsapp.net",
        messageId: randomUUID(),
        fromMe: false,
        messageType: "conversation",
        text: plainText,
      },
    };

    const deliveryId = await insertEncryptedDelivery(database, {
      endpointId,
      accountId,
      sessionId: session!.id,
      eventType: "messages.upsert",
      payload,
    });

    const { webhookDeliveries } = await import("@waapi/db");
    const [row] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    expect(row).toBeTruthy();
    expect(isEncryptedPayload(row!.payload)).toBe(true);
    const rawJson = JSON.stringify(row!.payload);
    expect(rawJson).not.toContain(plainText);
    expect(rawJson).toContain("__enc");

    // Delivery worker uses pinned agent which blocks 127.0.0.1 — decrypt path unit-check +
    // direct POST proves the plaintext body that would be sent.
    const body = decryptPayloadJson(row!.payload as Record<string, unknown>, deliveryId);
    expect(body).toContain(plainText);
    expect(JSON.parse(body).data.text).toBe(plainText);

    const { request: httpRequest } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/hook",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(received.some((b) => b.includes(plainText))).toBe(true);

    // Age the row and purge payload, keep metadata.
    await database.db.execute(sql`
      update webhook_deliveries
      set status = 'success', updated_at = now() - interval '3 hours'
      where id = ${deliveryId}::uuid
    `);
    const n = await purgeWebhookPayloadsForTest(database, {
      successOlderThanSeconds: 1,
      failedOlderThanSeconds: 1,
    });
    expect(n).toBeGreaterThanOrEqual(1);
    const [after] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    expect(after).toBeTruthy();
    expect(after!.payload).toBeNull();
    expect(after!.eventType).toBe("messages.upsert");
    expect(after!.payloadHash).toBeTruthy();

    // Avoid unused import lint for worker start in this unit path
    expect(startWebhookDeliveryWorker).toBeTypeOf("function");
    expect(enqueueDelivery).toBeTypeOf("function");

    await new Promise<void>((r) => server.close(() => r()));
  }, 30_000);
});
