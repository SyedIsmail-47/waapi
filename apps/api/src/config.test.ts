import { describe, expect, it } from "vitest";
import { validateConfigEnv } from "./config.js";

const base = {
  DATABASE_URL: "postgresql://waapi:waapi@localhost:5432/waapi",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "production-grade-jwt-secret-value-32b!",
  ADMIN_API_SECRET: "production-admin-secret!!",
  WEBHOOK_SECRET_KEY: Buffer.alloc(32, 9).toString("base64"),
};

describe("production config guards", () => {
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
});
