import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { loadConfig, resetConfigCache } from "../config.js";
import { createDb, type Db } from "./client.js";
import { accounts, sessions, waAuthCreds } from "./schema.js";
import {
  listSessionsToLoad,
  markLoggedOutAndWipeAuth,
  sweepAuthForLoggedOutSessions,
  updateSessionStatus,
} from "./sessions.js";
import { encryptJson, authAad } from "../crypto/aes.js";

describe("sessions DB", () => {
  let db: Db["db"];
  let client: Db["client"];
  let enabled = false;
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const key = Buffer.alloc(32, 3);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      if (process.env.CI) throw new Error("DATABASE_URL required in CI");
      return;
    }
    process.env.BRAND_NAME ??= "waapi";
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= key.toString("base64");
    process.env.REDIS_URL ??= "redis://localhost:6379";
    resetConfigCache();
    try {
      const cfg = loadConfig();
      const created = createDb(cfg.databaseUrl);
      db = created.db;
      client = created.client;
      await db.execute(sql`select 1`);
      await db.insert(accounts).values({ id: accountId, name: "status-test", maxSessions: 5 });
      await db.insert(sessions).values({
        id: sessionId,
        accountId,
        name: "s1",
        status: "connected",
      });
      enabled = true;
    } catch (err) {
      if (process.env.CI) throw err;
      enabled = false;
    }
  });

  afterAll(async () => {
    if (!enabled) return;
    await db.delete(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    await db.delete(sessions).where(eq(sessions.accountId, accountId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
    await client.end({ timeout: 5 });
  });

  it("never overwrites terminal logged_out", async () => {
    if (!enabled) return;
    // Reset to connected for this assertion path
    await db
      .update(sessions)
      .set({ status: "connected" })
      .where(eq(sessions.id, sessionId));
    const loggedOut = await updateSessionStatus(db, accountId, sessionId, "logged_out");
    expect(loggedOut?.status).toBe("logged_out");

    const overwrite = await updateSessionStatus(db, accountId, sessionId, "connected");
    expect(overwrite).toBeNull();

    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(rows[0]?.status).toBe("logged_out");
  });

  it("listSessionsToLoad excludes error and logged_out", async () => {
    if (!enabled) return;
    const errId = randomUUID();
    const outId = randomUUID();
    const okId = randomUUID();
    await db.insert(sessions).values([
      { id: errId, accountId, name: "err", status: "error" },
      { id: outId, accountId, name: "out", status: "logged_out" },
      { id: okId, accountId, name: "ok", status: "disconnected" },
    ]);
    const rows = await listSessionsToLoad(db, 100);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(okId)).toBe(true);
    expect(ids.has(errId)).toBe(false);
    expect(ids.has(outId)).toBe(false);
    await db.delete(sessions).where(eq(sessions.id, errId));
    await db.delete(sessions).where(eq(sessions.id, outId));
    await db.delete(sessions).where(eq(sessions.id, okId));
  });

  it("markLoggedOutAndWipeAuth is atomic and boot sweep clears orphans", async () => {
    if (!enabled) return;
    const sid = randomUUID();
    await db.insert(sessions).values({
      id: sid,
      accountId,
      name: "atomic",
      status: "connected",
    });
    const blob = encryptJson({ x: 1 }, key, authAad(sid, "creds", "default"));
    await db.insert(waAuthCreds).values({
      sessionId: sid,
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      keyVersion: 1,
    });

    await markLoggedOutAndWipeAuth(db, accountId, sid);
    const sess = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(sess[0]?.status).toBe("logged_out");
    const creds = await db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sid));
    expect(creds.length).toBe(0);

    // Orphan re-insert then sweep
    await db.insert(waAuthCreds).values({
      sessionId: sid,
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      keyVersion: 1,
    });
    const swept = await sweepAuthForLoggedOutSessions(db);
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sid));
    expect(after.length).toBe(0);
    await db.delete(sessions).where(eq(sessions.id, sid));
  });
});
