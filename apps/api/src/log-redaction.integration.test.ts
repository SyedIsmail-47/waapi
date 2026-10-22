import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltApp } from "./app.js";
import { defaultPinoRedact } from "./lib/log-redact.js";

async function redisUp(): Promise<boolean> {
  try {
    const Redis = (await import("ioredis")).default;
    const r = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
      maxRetriesPerRequest: 1,
      connectTimeout: 800,
      lazyConnect: true,
    });
    await r.connect();
    await r.ping();
    r.disconnect();
    return true;
  } catch {
    return false;
  }
}

/**
 * WP-M(a) full flow — skipped when Redis/Postgres unavailable locally; CI always runs it.
 */
describe("WP-M log redaction flow", async () => {
  const ready = await redisUp();
  if (!ready) {
    it.skip("requires Redis (docker) for full signup→session log scan", () => undefined);
    return;
  }

  let app: BuiltApp;
  const lines: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.TURNSTILE_DISABLED = "true";
    process.env.LOG_LEVEL = "info";

    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const { buildApp } = await import("./app.js");
    app = await buildApp({
      logger: { level: "info", stream: sink, redact: defaultPinoRedact },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("signup→login→session does not leak tokens or message text in logs", async () => {
    lines.length = 0;
    const email = `logscan-${crypto.randomUUID()}@example.test`;
    const password = "correct-horse-battery-staple";
    const messageText = `SECRET_MESSAGE_BODY_${crypto.randomUUID()}`;

    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password, name: "LogScan", acceptTerms: true },
    });
    expect(reg.statusCode).toBe(201);
    const { verificationToken } = reg.json<{ verificationToken?: string }>();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: verificationToken },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken } = login.json<{
      accessToken: string;
      refreshToken: string;
    }>();

    await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "log-scan-session" },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: {
        authorization: `Bearer ${accessToken}`,
        cookie: `waapi_refresh=${refreshToken}; waapi_csrf=csrf-probe-token-value`,
        "x-csrf-token": "csrf-probe-token-value",
      },
      payload: { email, password, text: messageText },
    });

    const blob = lines.join("\n");
    for (const secret of [accessToken, refreshToken, password, messageText, verificationToken!]) {
      if (!secret) continue;
      expect(blob.includes(secret)).toBe(false);
    }
    expect(blob).not.toMatch(/Bearer\s+[A-Za-z0-9\-_]{20,}/);
    expect(blob.toLowerCase()).not.toContain("csrf-probe-token-value");
  }, 60_000);
});
