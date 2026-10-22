import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuiltApp } from "./app.js";

/**
 * WP-M(a): signup → verify → login → session → send → webhook with logs captured.
 * Assert secrets/tokens/message text never appear in log lines.
 */
describe("WP-M log redaction", () => {
  let app: BuiltApp;
  const lines: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.DEV_RETURN_TOKENS = "true";
    process.env.SIGNUPS_MODE = "open";
    process.env.TURNSTILE_DISABLED = "true";
    process.env.ALLOW_HTTP_WEBHOOKS = "true";
    process.env.LOG_LEVEL = "info";

    const { buildApp } = await import("./app.js");
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    app = await buildApp({
      logger: {
        level: "info",
        stream: sink,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "req.headers['set-cookie']",
            "req.headers['x-csrf-token']",
            "res.headers['set-cookie']",
            "*.token",
            "*.password",
            "*.accessToken",
            "*.refreshToken",
            "*.text",
            "body.text",
            "body.password",
            "body.token",
          ],
          censor: "[Redacted]",
        },
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("does not leak tokens, cookies, auth, or message text in logs", async () => {
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
    const { verificationToken, accountId } = reg.json<{
      verificationToken?: string;
      accountId: string;
    }>();
    expect(verificationToken).toBeTruthy();

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

    const setCookie = login.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "log-scan-session" },
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json<{ id: string }>().id;

    const keyRes = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${sessionId}/keys`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name: "sk-log" },
    });
    const sessionKey = keyRes.json<{ token: string }>().token;

    await app.inject({
      method: "PUT",
      url: `/api/v1/sessions/${sessionId}/webhook`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { url: "https://example.com/hook", secret: "webhook-secret-value-32chars!!" },
    });

    await app.inject({
      method: "POST",
      url: "/api/v1/send-message",
      headers: {
        authorization: `Bearer ${sessionKey}`,
        "idempotency-key": crypto.randomUUID(),
      },
      payload: { sessionId, to: "+14155552671", text: messageText },
    });

    // Force a request that would include cookie + CSRF if logged
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      headers: {
        cookie: cookieHeader,
        "x-csrf-token": "csrf-probe-token-value",
      },
      payload: {},
    });

    const blob = lines.join("\n");
    const forbidden = [
      accessToken,
      refreshToken,
      sessionKey,
      password,
      messageText,
      verificationToken!,
      "csrf-probe-token-value",
      "Bearer ",
    ].filter(Boolean);

    for (const secret of forbidden) {
      expect(blob.includes(secret), `log leaked sensitive value`).toBe(false);
    }
    expect(blob).not.toMatch(/authorization["']?\s*:\s*["']?Bearer\s+[A-Za-z0-9._\-]+/i);
    expect(blob.toLowerCase()).not.toContain("wa_auth");
    void accountId;
  }, 60_000);
});
