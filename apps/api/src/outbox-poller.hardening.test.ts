import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@waapi/db";
import { encryptPayloadJson } from "@waapi/shared";

describe("outbox poller hardening", () => {
  let database: Db;
  let pollOutboxOnce: (db: Db) => Promise<number>;
  let sweepStalePendingDeliveries: (db: Db) => Promise<number>;
  let enqueueSpy: ReturnType<typeof vi.fn>;
  const accountIds: string[] = [];

  beforeAll(async () => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    vi.resetModules();
    const webhooks = await import("./services/webhooks/index.js");
    enqueueSpy = vi.spyOn(webhooks, "enqueueDelivery").mockResolvedValue(undefined);
    ({ pollOutboxOnce, sweepStalePendingDeliveries } = await import("./workers/outbox-poller.js"));
    const { createDb } = await import("@waapi/db");
    database = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (accountIds.length) {
      const { accounts } = await import("@waapi/db");
      const { inArray } = await import("drizzle-orm");
      await database.db.delete(accounts).where(inArray(accounts.id, accountIds));
    }
    await database.client.end();
  });

  async function seedSession(label: string) {
    const { accounts, sessions, webhookEndpoints } = await import("@waapi/db");
    const { encryptSecret } = await import("./lib/crypto.js");
    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: label });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: label, status: "connected" })
      .returning();
    const endpointId = randomUUID();
    await database.db.insert(webhookEndpoints).values({
      id: endpointId,
      accountId,
      sessionId: session!.id,
      url: "https://example.test/hook",
      secretEncrypted: encryptSecret("hardening-secret-value!!", endpointId),
      enabled: true,
    });
    return { accountId, sessionId: session!.id, endpointId };
  }

  function goodPayload(accountId: string, sessionId: string, i: number) {
    return {
      id: randomUUID(),
      type: "messages.upsert",
      accountId,
      sessionId,
      createdAt: new Date().toISOString(),
      data: { messageId: randomUUID(), i },
    };
  }

  it("poison row does not block 50 good rows behind it", async () => {
    const { encryptOutboxPayload } = await import("./lib/outbox-crypto.js");
    const { webhookOutbox, webhookDeliveries } = await import("@waapi/db");
    const { accountId, sessionId } = await seedSession("poison-ahead");

    const poisonId = randomUUID();
    await database.db.insert(webhookOutbox).values({
      id: poisonId,
      accountId,
      sessionId,
      eventType: "messages.upsert",
      // Looks encrypted but ciphertext is garbage → decrypt_failed forever.
      payload: { __enc: `v1.${Buffer.alloc(80, 9).toString("base64url")}` },
      status: "pending",
      attempts: 0,
    });

    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      await database.db.insert(webhookOutbox).values({
        id,
        accountId,
        sessionId,
        eventType: "messages.upsert",
        payload: encryptOutboxPayload(goodPayload(accountId, sessionId, i), id),
        status: "pending",
        attempts: 0,
      });
    }

    // Drain: poison retries then goes dead; good rows must still deliver.
    for (let round = 0; round < 20; round++) {
      await pollOutboxOnce(database);
      // Force poison retries due immediately.
      await database.db.execute(sql`
        update webhook_outbox
        set next_attempt_at = now() - interval '1 second'
        where id = ${poisonId}::uuid and status = 'pending'
      `);
    }

    const [poison] = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.id, poisonId))
      .limit(1);
    expect(poison).toBeTruthy();
    expect(poison!.status).toBe("dead");
    expect(poison!.attempts).toBeGreaterThanOrEqual(5);
    expect(poison!.payload).toBeNull();
    expect(poison!.lastError).toBe("decrypt_failed");

    const remainingPending = await database.db
      .select({ id: webhookOutbox.id })
      .from(webhookOutbox)
      .where(eq(webhookOutbox.sessionId, sessionId));
    expect(remainingPending.every((r) => r.id === poisonId)).toBe(true);

    const deliveries = await database.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sessionId, sessionId));
    expect(deliveries).toHaveLength(50);
  }, 120_000);

  it("wrong encryption key sends rows to dead and deletes none", async () => {
    const { webhookOutbox } = await import("@waapi/db");
    const { accountId, sessionId } = await seedSession("wrong-key");
    const wrongKey = Buffer.alloc(32, 3);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      const stored = encryptPayloadJson(
        JSON.stringify(goodPayload(accountId, sessionId, i)),
        id,
        wrongKey,
        "v1",
      );
      await database.db.insert(webhookOutbox).values({
        id,
        accountId,
        sessionId,
        eventType: "messages.upsert",
        payload: stored as unknown as Record<string, unknown>,
        status: "pending",
        attempts: 0,
      });
    }

    for (let round = 0; round < 20; round++) {
      await pollOutboxOnce(database);
      await database.db.execute(sql`
        update webhook_outbox
        set next_attempt_at = now() - interval '1 second'
        where session_id = ${sessionId}::uuid and status = 'pending'
      `);
    }

    const rows = await database.db
      .select()
      .from(webhookOutbox)
      .where(eq(webhookOutbox.sessionId, sessionId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(ids).toContain(row.id);
      expect(row.status).toBe("dead");
      expect(row.payload).toBeNull();
      expect(row.lastError).toBe("decrypt_failed");
      expect(row.attempts).toBeGreaterThanOrEqual(5);
    }
  }, 60_000);

  it("crash between commit and enqueue is recovered by the sweeper", async () => {
    const { webhookDeliveries } = await import("@waapi/db");
    const { insertEncryptedDelivery } = await import("./services/webhooks/deliveries.js");
    const { accountId, sessionId, endpointId } = await seedSession("sweeper");

    enqueueSpy.mockClear();
    const deliveryId = await insertEncryptedDelivery(database.db, {
      endpointId,
      accountId,
      sessionId,
      eventType: "messages.upsert",
      payload: goodPayload(accountId, sessionId, 0),
    });
    // Simulate committed delivery with no BullMQ job yet, aged past 60s.
    await database.db.execute(sql`
      update webhook_deliveries
      set created_at = now() - interval '2 minutes',
          status = 'pending'
      where id = ${deliveryId}::uuid
    `);

    const n = await sweepStalePendingDeliveries(database);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(enqueueSpy).toHaveBeenCalledWith(deliveryId);

    const [row] = await database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    expect(row!.status).toBe("pending");
  });
});
