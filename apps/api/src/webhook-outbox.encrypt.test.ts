import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@waapi/db";
import { isEncryptedPayload } from "@waapi/shared";
import { pollOutboxOnce } from "./workers/outbox-poller.js";
import { decryptPayloadJson } from "./lib/payload-crypto.js";
import { encryptOutboxPayload } from "./lib/outbox-crypto.js";
import { insertEncryptedDelivery } from "./services/webhooks/deliveries.js";

describe("API outbox poller encryption path", () => {
  let database: Db;
  const accountIds: string[] = [];

  beforeAll(async () => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    const { createDb } = await import("@waapi/db");
    database = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    if (accountIds.length) {
      const { accounts } = await import("@waapi/db");
      const { inArray } = await import("drizzle-orm");
      await database.db.delete(accounts).where(inArray(accounts.id, accountIds));
    }
    await database.client.end();
  });

  it("plaintext never in DB; delivery has text; crash mid-txn does not lose/duplicate", async () => {
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

    const { accounts, sessions, webhookEndpoints, webhookOutbox, webhookDeliveries } =
      await import("@waapi/db");
    const { encryptSecret } = await import("./lib/crypto.js");
    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "poller-enc" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "s", status: "connected" })
      .returning();
    const endpointId = randomUUID();
    await database.db.insert(webhookEndpoints).values({
      id: endpointId,
      accountId,
      sessionId: session!.id,
      url: `http://127.0.0.1:${port}/hook`,
      secretEncrypted: encryptSecret("poller-encrypt-secret!!", endpointId),
      enabled: true,
    });

    const plainText = `secret-outbox-${randomUUID()}`;
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
    const outboxId = randomUUID();
    const stored = encryptOutboxPayload(payload, outboxId);
    await database.db.insert(webhookOutbox).values({
      id: outboxId,
      accountId,
      sessionId: session!.id,
      eventType: "messages.upsert",
      payload: stored,
    });

    const [obox] = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.id, outboxId))
      .limit(1);
    expect(isEncryptedPayload(obox!.payload)).toBe(true);
    expect(JSON.stringify(obox!.payload)).not.toContain(plainText);

    const beforeCount = (
      await database.db
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.sessionId, session!.id))
    ).length;

    await expect(
      database.db.transaction(async (tx) => {
        await insertEncryptedDelivery(tx, {
          endpointId,
          accountId,
          sessionId: session!.id,
          eventType: "messages.upsert",
          payload,
        });
        throw new Error("simulated-poller-crash");
      }),
    ).rejects.toThrow(/simulated-poller-crash/);

    expect(
      (
        await database.db.select().from(webhookOutbox).where(eq(webhookOutbox.id, outboxId))
      ).length,
    ).toBe(1);
    expect(
      (
        await database.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.sessionId, session!.id))
      ).length,
    ).toBe(beforeCount);

    // Prove decrypt works with AAD = outbox id before poller runs.
    const { decryptOutboxPayloadJson } = await import("./lib/payload-crypto.js");
    const [oboxFresh] = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.id, outboxId))
      .limit(1);
    const roundTrip = decryptOutboxPayloadJson(
      oboxFresh!.payload as Record<string, unknown>,
      outboxId,
    );
    expect(JSON.parse(roundTrip).data.text).toBe(plainText);

    const n = await pollOutboxOnce(database);
    expect(n).toBe(1);
    expect(
      (
        await database.db.select().from(webhookOutbox).where(eq(webhookOutbox.id, outboxId))
      ).length,
    ).toBe(0);

    const [delivery] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sessionId, session!.id))
      .limit(1);
    expect(isEncryptedPayload(delivery!.payload)).toBe(true);
    expect(JSON.stringify(delivery!.payload)).not.toContain(plainText);

    const body = decryptPayloadJson(delivery!.payload as Record<string, unknown>, delivery!.id);
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

    expect(await pollOutboxOnce(database)).toBe(0);
    expect(
      (
        await database.db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.sessionId, session!.id))
      ).length,
    ).toBe(1);

    await new Promise<void>((r) => server.close(() => r()));
  }, 30_000);
});
