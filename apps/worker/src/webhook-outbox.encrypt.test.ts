import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@waapi/db";
import { isEncryptedPayload } from "@waapi/shared";
import { enqueueWebhookOutbox } from "./db/webhook-outbox.js";
import { resetConfigCache } from "./config.js";

describe("worker webhook outbox enqueue", () => {
  let database: Db;
  const accountIds: string[] = [];

  beforeAll(async () => {
    resetConfigCache();
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

  it("skips outbox when no enabled endpoint", async () => {
    const { accounts, sessions, webhookOutbox } = await import("@waapi/db");
    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "no-ep" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "s", status: "connected" })
      .returning();
    const plainText = `plain-${randomUUID()}`;
    const id = await enqueueWebhookOutbox(database.db as never, {
      accountId,
      sessionId: session!.id,
      eventType: "messages.upsert",
      payload: { data: { text: plainText } },
    });
    expect(id).toBeNull();
    const rows = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.sessionId, session!.id));
    expect(rows).toHaveLength(0);
  });

  it("stores encrypted payload when endpoint exists", async () => {
    const { accounts, sessions, webhookEndpoints, webhookOutbox } = await import("@waapi/db");
    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "ep" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "s", status: "connected" })
      .returning();
    const endpointId = randomUUID();
    // Worker DB schema uses secretEncrypted — insert a dummy ciphertext blob
    await database.db.insert(webhookEndpoints).values({
      id: endpointId,
      accountId,
      sessionId: session!.id,
      url: "https://example.test/hook",
      secretEncrypted: "v1:test:dummy",
      enabled: true,
    });
    const plainText = `worker-secret-${randomUUID()}`;
    const id = await enqueueWebhookOutbox(database.db as never, {
      accountId,
      sessionId: session!.id,
      eventType: "messages.upsert",
      payload: { data: { text: plainText } },
    });
    expect(id).toBeTruthy();
    const [row] = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.id, id!))
      .limit(1);
    expect(isEncryptedPayload(row!.payload)).toBe(true);
    expect(JSON.stringify(row!.payload)).not.toContain(plainText);
  });
});
