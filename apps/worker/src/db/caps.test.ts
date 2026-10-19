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
    if (!process.env.DATABASE_URL) return;
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
    } catch {
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
});
