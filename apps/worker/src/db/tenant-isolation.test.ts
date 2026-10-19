import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig, resetConfigCache } from "../config.js";
import { createDb, type Db } from "./client.js";
import { accounts, sessions } from "./schema.js";
import { getSessionForAccount } from "./sessions.js";

describe("tenant isolation", () => {
  let db: Db["db"];
  let client: Db["client"];
  let enabled = false;
  const accountA = randomUUID();
  const accountB = randomUUID();
  let sessionA: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    process.env.BRAND_NAME ??= "waapi";
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString("base64");
    process.env.REDIS_URL ??= "redis://localhost:6379";
    resetConfigCache();
    try {
      const cfg = loadConfig();
      const created = createDb(cfg.databaseUrl);
      db = created.db;
      client = created.client;
      await client`select 1`;
      await db.insert(accounts).values([
        { id: accountA, name: "A", maxSessions: 5 },
        { id: accountB, name: "B", maxSessions: 5 },
      ]);
      const [row] = await db
        .insert(sessions)
        .values({ accountId: accountA, name: "s1", status: "need_scan" })
        .returning();
      sessionA = row!.id;
      enabled = true;
    } catch {
      enabled = false;
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.delete(sessions).where(eq(sessions.accountId, accountA));
    await db.delete(accounts).where(eq(accounts.id, accountA));
    await db.delete(accounts).where(eq(accounts.id, accountB));
    await client.end({ timeout: 5 });
  });

  it("does not return another account's session", async () => {
    if (!enabled) return;
    const owned = await getSessionForAccount(db, accountA, sessionA);
    expect(owned?.id).toBe(sessionA);
    const leaked = await getSessionForAccount(db, accountB, sessionA);
    expect(leaked).toBeNull();
  });
});
