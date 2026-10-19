import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { loadConfig, resetConfigCache } from "../config.js";
import { createDb, type Db } from "./client.js";
import { accounts, sessions } from "./schema.js";
import { createSessionTransactional } from "./sessions.js";

describe("session caps", () => {
  let db: Db["db"];
  let client: Db["client"];
  let enabled = false;
  const accountId = randomUUID();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      if (process.env.CI) throw new Error("DATABASE_URL required in CI");
      return;
    }
    process.env.BRAND_NAME ??= "waapi";
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= Buffer.alloc(32, 2).toString("base64");
    process.env.REDIS_URL ??= "redis://localhost:6379";
    resetConfigCache();
    try {
      const cfg = loadConfig();
      const created = createDb(cfg.databaseUrl);
      db = created.db;
      client = created.client;
      await db.execute(sql`select 1`);
      await db.insert(accounts).values({ id: accountId, name: "cap", maxSessions: 1 });
      enabled = true;
    } catch (err) {
      if (process.env.CI) throw err;
      enabled = false;
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.delete(sessions).where(eq(sessions.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
    await client.end({ timeout: 5 });
  });

  it("enforces account max_sessions", async () => {
    if (!enabled) return;
    await createSessionTransactional(db, {
      accountId,
      name: "one",
      maxSessionsPerNode: 10,
      currentNodeSessionCount: 0,
    });
    await expect(
      createSessionTransactional(db, {
        accountId,
        name: "two",
        maxSessionsPerNode: 10,
        currentNodeSessionCount: 0,
      }),
    ).rejects.toThrow("ACCOUNT_SESSION_CAP");
  });

  it("enforces node cap argument", async () => {
    if (!enabled) return;
    const other = randomUUID();
    await db.insert(accounts).values({ id: other, name: "node", maxSessions: 5 });
    await expect(
      createSessionTransactional(db, {
        accountId: other,
        name: "n1",
        maxSessionsPerNode: 1,
        currentNodeSessionCount: 1,
      }),
    ).rejects.toThrow("NODE_SESSION_CAP");
    await db.delete(accounts).where(eq(accounts.id, other));
  });

  it("enforces account cap under Promise.all concurrency", async () => {
    if (!enabled) return;
    const concurrentAccount = randomUUID();
    await db.insert(accounts).values({
      id: concurrentAccount,
      name: "concurrent-cap",
      maxSessions: 2,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        createSessionTransactional(db, {
          accountId: concurrentAccount,
          name: `c-${i}`,
          maxSessionsPerNode: 100,
          currentNodeSessionCount: 0,
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(2);
    expect(rejected.length).toBe(6);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
      expect(((r as PromiseRejectedResult).reason as Error).message).toBe("ACCOUNT_SESSION_CAP");
    }
    await db.delete(sessions).where(eq(sessions.accountId, concurrentAccount));
    await db.delete(accounts).where(eq(accounts.id, concurrentAccount));
  });
});
