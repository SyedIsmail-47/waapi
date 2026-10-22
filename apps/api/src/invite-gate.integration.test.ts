import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@waapi/db";
import type { BuiltApp } from "./app.js";
import type { FastifyInstance } from "fastify";

/**
 * WP-B closed-beta gate: SIGNUPS_MODE open|invite|closed,
 * single-use invite codes with expiry.
 */
describe("WP-B invite gate", () => {
  let app: BuiltApp;
  let internal: FastifyInstance;
  let database: Db;
  let adminSecret: string;
  const accountIds = new Set<string>();

  beforeAll(async () => {
    await import("dotenv/config");
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-bytes";
    process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.ADMIN_API_SECRET ??= "test-admin-api-secret";
    process.env.PAYLOAD_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
    process.env.AUTH_STATE_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.TURNSTILE_DISABLED = "true";
    process.env.SIGNUPS_MODE = "open";
    adminSecret = process.env.ADMIN_API_SECRET;

    if (!process.env.DATABASE_URL || !process.env.REDIS_URL) {
      throw new Error("DATABASE_URL and REDIS_URL required for invite-gate tests");
    }

    const { buildApp, buildInternalApp } = await import("./app.js");
    app = await buildApp();
    database = app.database;
    internal = await buildInternalApp(database);
    await app.ready();
    await internal.ready();
  });

  afterAll(async () => {
    process.env.SIGNUPS_MODE = "open";
    if (!app || !database) return;
    const { accounts } = await import("@waapi/db");
    const { inArray } = await import("drizzle-orm");
    if (accountIds.size) {
      await database.db.delete(accounts).where(inArray(accounts.id, [...accountIds]));
    }
    await Promise.allSettled([app.close(), internal.close()]);
  });

  async function createInvite(expiresInHours = 24): Promise<string> {
    const res = await internal.inject({
      method: "POST",
      url: "/internal/admin/invites",
      headers: { "x-admin-secret": adminSecret },
      payload: { expiresInHours },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ code: string }>();
    expect(body.code).toEqual(expect.any(String));
    return body.code;
  }

  it("GET /auth/signup-config exposes mode (no secrets)", async () => {
    process.env.SIGNUPS_MODE = "invite";
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/signup-config" });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toEqual({ mode: "invite" });
    expect(JSON.stringify(body)).not.toMatch(/secret|token|password/i);
    process.env.SIGNUPS_MODE = "open";
  });

  it("open mode allows register without inviteCode", async () => {
    process.env.SIGNUPS_MODE = "open";
    const email = `open-${crypto.randomUUID()}@example.test`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    expect(res.statusCode).toBe(201);
    accountIds.add(res.json<{ accountId: string }>().accountId);
  });

  it("closed mode rejects all signups", async () => {
    process.env.SIGNUPS_MODE = "closed";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `closed-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
        inviteCode: "whatever-long-enough",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNUPS_CLOSED");
    process.env.SIGNUPS_MODE = "open";
  });

  it("invite mode requires inviteCode", async () => {
    process.env.SIGNUPS_MODE = "invite";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `need-invite-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toMatch(/INVITE|VALIDATION|BAD_REQUEST/);
    process.env.SIGNUPS_MODE = "open";
  });

  it("invite mode accepts a fresh code once, rejects reuse", async () => {
    process.env.SIGNUPS_MODE = "invite";
    const code = await createInvite(48);
    const email1 = `invite-ok-${crypto.randomUUID()}@example.test`;
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: email1,
        password: "correct-horse-battery-staple",
        inviteCode: code,
      },
    });
    expect(first.statusCode).toBe(201);
    accountIds.add(first.json<{ accountId: string }>().accountId);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `invite-reuse-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
        inviteCode: code,
      },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe("INVITE_INVALID");
    process.env.SIGNUPS_MODE = "open";
  });

  it("expired invite is rejected", async () => {
    process.env.SIGNUPS_MODE = "invite";
    const code = await createInvite(1);
    const { inviteCodes } = await import("@waapi/db");
    const { eq } = await import("drizzle-orm");
    const { sha256 } = await import("./lib/crypto.js");
    await database.db
      .update(inviteCodes)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(inviteCodes.codeHash, sha256(code)));

    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: `expired-${crypto.randomUUID()}@example.test`,
        password: "correct-horse-battery-staple",
        inviteCode: code,
      },
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error.code).toBe("INVITE_INVALID");
    process.env.SIGNUPS_MODE = "open";
  });

  it("admin create invite requires secret; wrong secret is 403", async () => {
    const bad = await internal.inject({
      method: "POST",
      url: "/internal/admin/invites",
      headers: { "x-admin-secret": "wrong-secret-value!!" },
      payload: { expiresInHours: 1 },
    });
    expect(bad.statusCode).toBe(403);

    const ok = await internal.inject({
      method: "POST",
      url: "/internal/admin/invites",
      headers: { "x-admin-secret": adminSecret },
      payload: { expiresInHours: 1 },
    });
    expect(ok.statusCode).toBe(201);
    const body = ok.json<Record<string, unknown>>();
    expect(body.code).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("codeHash");
  });

  it("invite codes are never stored as plaintext in DB", async () => {
    const code = await createInvite(1);
    const { inviteCodes } = await import("@waapi/db");
    const rows = await database.db.select().from(inviteCodes);
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(code);
  });
});
