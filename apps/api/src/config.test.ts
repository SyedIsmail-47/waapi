import { describe, expect, it } from "vitest";
import { validateConfigEnv } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://waapi:waapi@localhost:5432/waapi",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "production-grade-jwt-secret-value-32b!",
  ADMIN_API_SECRET: "production-admin-secret!!",
  WEBHOOK_SECRET_KEY: Buffer.alloc(32, 9).toString("base64"),
  PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  GLOBAL_MAX_SESSIONS: "50",
  EMAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_test_key",
  TURNSTILE_SECRET_KEY: "turnstile-test-secret",
  PUBLIC_APP_URL: "https://app.example.test",
};

describe("production config guards", () => {
  it("requires GLOBAL_MAX_SESSIONS in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        GLOBAL_MAX_SESSIONS: undefined,
      }),
    ).toThrow(/GLOBAL_MAX_SESSIONS/);
  });

  it("refuses EMAIL_DRIVER=console in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        EMAIL_DRIVER: "console",
      }),
    ).toThrow(/EMAIL_DRIVER/);
  });

  it("refuses DEV_RETURN_TOKENS in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        DEV_RETURN_TOKENS: "true",
      }),
    ).toThrow(/DEV_RETURN_TOKENS/);
  });

  it("refuses ALLOW_HTTP_WEBHOOKS in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        ALLOW_HTTP_WEBHOOKS: "true",
      }),
    ).toThrow(/ALLOW_HTTP_WEBHOOKS/);
  });

  it("refuses ENABLE_DOCS without ALLOW_DOCS_IN_PROD", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        ENABLE_DOCS: "true",
      }),
    ).toThrow(/ENABLE_DOCS/);
  });

  it("allows ENABLE_DOCS with ALLOW_DOCS_IN_PROD", () => {
    const cfg = validateConfigEnv({
      ...base,
      NODE_ENV: "production",
      ENABLE_DOCS: "true",
      ALLOW_DOCS_IN_PROD: "true",
    });
    expect(cfg.ENABLE_DOCS).toBe(true);
  });

  it("requires TURNSTILE_SECRET_KEY in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        TURNSTILE_SECRET_KEY: undefined,
      }),
    ).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it("allows TURNSTILE_DISABLED under SMOKE_MODE in production", () => {
    const cfg = validateConfigEnv({
      ...base,
      NODE_ENV: "production",
      SMOKE_MODE: "true",
      TURNSTILE_DISABLED: "true",
      TURNSTILE_SECRET_KEY: undefined,
      COOKIE_SECURE: "false",
    });
    expect(cfg.TURNSTILE_DISABLED).toBe(true);
    expect(cfg.COOKIE_SECURE).toBe(false);
  });

  it("rejects placeholder JWT_SECRET in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        JWT_SECRET: "ci-jwt-secret-at-least-32-characters-long",
      }),
    ).toThrow(/placeholder/);
  });

  it("rejects WEBHOOK_SECRET_KEY that is not 32 bytes", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "test",
        WEBHOOK_SECRET_KEY: "too-short",
      }),
    ).toThrow(/32 bytes/);
  });

  it("DEFAULT_ACCOUNT_MAX_SESSIONS defaults to 1", () => {
    const cfg = validateConfigEnv({ ...base, NODE_ENV: "test" });
    expect(cfg.DEFAULT_ACCOUNT_MAX_SESSIONS).toBe(1);
  });

  it("SIGNUPS_MODE defaults to invite", () => {
    const cfg = validateConfigEnv({ ...base, NODE_ENV: "test" });
    expect(cfg.SIGNUPS_MODE).toBe("invite");
  });

  it("accepts SIGNUPS_MODE open|invite|closed", () => {
    expect(validateConfigEnv({ ...base, NODE_ENV: "test", SIGNUPS_MODE: "open" }).SIGNUPS_MODE).toBe(
      "open",
    );
    expect(
      validateConfigEnv({ ...base, NODE_ENV: "test", SIGNUPS_MODE: "closed" }).SIGNUPS_MODE,
    ).toBe("closed");
  });

  it("requires PUBLIC_APP_URL in production", () => {
    expect(() =>
      validateConfigEnv({
        ...base,
        NODE_ENV: "production",
        PUBLIC_APP_URL: undefined,
      }),
    ).toThrow(/PUBLIC_APP_URL/);
  });

  it("defaults PUBLIC_APP_URL outside production", () => {
    const { PUBLIC_APP_URL: _drop, ...rest } = base;
    const cfg = validateConfigEnv({ ...rest, NODE_ENV: "test" });
    expect(cfg.PUBLIC_APP_URL).toMatch(/^http:\/\/127\.0\.0\.1:5173$/);
  });
});
