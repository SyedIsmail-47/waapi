import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { authAad, decryptJson, encryptJson } from "../crypto/aes.js";
import { buildKeyRing } from "../crypto/key-ring.js";
import { loadConfig, resetConfigCache } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import { accounts, sessions, waAuthCreds, waAuthKeys } from "../db/schema.js";
import { wipeAuthForSession } from "../db/sessions.js";
import { usePostgresAuthState } from "./auth-state.js";

describe("auth state encryption shape", () => {
  it("stores opaque ciphertext for creds-like objects with AAD", () => {
    const key = randomBytes(32);
    const aad = authAad("sess", "creds", "default");
    const creds = { noiseKey: { private: Buffer.from("abc") }, me: { id: "1" } };
    const blob = encryptJson(JSON.parse(JSON.stringify(creds)), key, aad);
    expect(blob.ciphertext.toString("utf8")).not.toContain("noiseKey");
    const round = decryptJson<typeof creds>(blob, key, aad);
    expect(round.me).toEqual({ id: "1" });
  });
});

describe("auth-state closed flag + flush", () => {
  let db: Db["db"];
  let client: Db["client"];
  let enabled = false;
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const keyRaw = Buffer.alloc(32, 9).toString("base64");

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      if (process.env.CI) throw new Error("DATABASE_URL required in CI");
      return;
    }
    process.env.BRAND_NAME ??= "waapi";
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= keyRaw;
    process.env.REDIS_URL ??= "redis://localhost:6379";
    resetConfigCache();
    try {
      const cfg = loadConfig();
      const created = createDb(cfg.databaseUrl);
      db = created.db;
      client = created.client;
      await db.execute(sql`select 1`);
      await db.insert(accounts).values({ id: accountId, name: "auth-closed", maxSessions: 5 });
      await db.insert(sessions).values({
        id: sessionId,
        accountId,
        name: "closed-test",
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
    await wipeAuthForSession(db, sessionId);
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(accounts).where(eq(accounts.id, accountId));
    await client.end({ timeout: 5 });
  });

  it("does not recreate wa_auth_* rows after close + wipe (creds.update race)", async () => {
    if (!enabled) return;
    const keyRing = buildKeyRing({ currentVersion: 1, currentKeyRaw: keyRaw });
    const auth = await usePostgresAuthState({
      db,
      sessionId,
      accountId,
      keyRing,
    });

    await auth.saveCreds();
    const before = await db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    expect(before.length).toBe(1);

    auth.close();
    await wipeAuthForSession(db, sessionId);

    await auth.saveCreds();
    await auth.state.keys.set({
      "pre-key": { "1": { private: Buffer.alloc(32), public: Buffer.alloc(32) } as never },
    });

    const credsRows = await db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    const keyRows = await db.select().from(waAuthKeys).where(eq(waAuthKeys.sessionId, sessionId));
    expect(credsRows.length).toBe(0);
    expect(keyRows.length).toBe(0);
  });

  it("flush awaits queued saveCreds so shutdown sees the row written", async () => {
    if (!enabled) return;
    await wipeAuthForSession(db, sessionId);
    const keyRing = buildKeyRing({ currentVersion: 1, currentKeyRaw: keyRaw });
    const auth = await usePostgresAuthState({
      db,
      sessionId,
      accountId,
      keyRing,
    });

    // Queue without awaiting — simulates in-flight creds.update during shutdown.
    void auth.saveCreds();
    await auth.flush();

    const rows = await db.select().from(waAuthCreds).where(eq(waAuthCreds.sessionId, sessionId));
    expect(rows.length).toBe(1);
  });
});
