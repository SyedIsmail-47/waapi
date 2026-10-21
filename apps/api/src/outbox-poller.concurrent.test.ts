import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@waapi/db";

describe("outbox poller concurrency", () => {
  let database: Db;
  let pollOutboxOnce: (db: Db) => Promise<number>;
  const accountIds: string[] = [];

  beforeAll(async () => {
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    vi.resetModules();
    const webhooks = await import("./services/webhooks/index.js");
    vi.spyOn(webhooks, "enqueueDelivery").mockResolvedValue(undefined);
    ({ pollOutboxOnce } = await import("./workers/outbox-poller.js"));
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

  it("two concurrent pollers over 200 outbox rows produce exactly 200 deliveries", async () => {
    const { accounts, sessions, webhookEndpoints, webhookOutbox, webhookDeliveries } =
      await import("@waapi/db");
    const { encryptSecret } = await import("./lib/crypto.js");
    const { encryptOutboxPayload } = await import("./lib/outbox-crypto.js");

    const accountId = randomUUID();
    accountIds.push(accountId);
    await database.db.insert(accounts).values({ id: accountId, name: "poller-concurrent" });
    const [session] = await database.db
      .insert(sessions)
      .values({ accountId, name: "s-concurrent", status: "connected" })
      .returning();
    const endpointId = randomUUID();
    await database.db.insert(webhookEndpoints).values({
      id: endpointId,
      accountId,
      sessionId: session!.id,
      url: "https://example.test/hook",
      secretEncrypted: encryptSecret("concurrent-poller-secret!!", endpointId),
      enabled: true,
    });

    const total = 200;
    for (let i = 0; i < total; i++) {
      const outboxId = randomUUID();
      const payload = {
        id: randomUUID(),
        type: "messages.upsert",
        accountId,
        sessionId: session!.id,
        createdAt: new Date().toISOString(),
        data: { messageId: randomUUID(), i },
      };
      await database.db.insert(webhookOutbox).values({
        id: outboxId,
        accountId,
        sessionId: session!.id,
        eventType: "messages.upsert",
        payload: encryptOutboxPayload(payload, outboxId),
      });
    }

    async function drain(): Promise<number> {
      let n = 0;
      for (;;) {
        const batch = await pollOutboxOnce(database);
        if (batch === 0) break;
        n += batch;
      }
      return n;
    }

    const [a, b] = await Promise.all([drain(), drain()]);
    expect(a + b).toBe(total);

    const remaining = await database.db
      .select({ id: webhookOutbox.id })
      .from(webhookOutbox)
      .where(eq(webhookOutbox.sessionId, session!.id));
    expect(remaining).toHaveLength(0);

    const deliveries = await database.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.sessionId, session!.id));
    expect(deliveries).toHaveLength(total);
    expect(new Set(deliveries.map((d) => d.id)).size).toBe(total);
  }, 120_000);
});
