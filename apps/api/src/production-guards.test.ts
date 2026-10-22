import { describe, expect, it } from "vitest";
import { validateConfigEnv } from "./config.js";
import { runPreflight } from "../../../scripts/preflight.js";

const goodKey = Buffer.alloc(32, 9).toString("base64");
const goodPayload = Buffer.alloc(32, 11).toString("base64");
const goodAuth = Buffer.alloc(32, 13).toString("base64");

const prodBase = {
  DATABASE_URL: "postgresql://waapi:secret@localhost:5432/waapi",
  REDIS_URL: "redis://:secret@localhost:6379",
  JWT_SECRET: "production-grade-jwt-secret-value-32b!",
  ADMIN_API_SECRET: "production-admin-secret-value!!",
  WEBHOOK_SECRET_KEY: goodKey,
  PAYLOAD_ENCRYPTION_KEY: goodPayload,
  GLOBAL_MAX_SESSIONS: "100",
  EMAIL_DRIVER: "resend" as const,
  RESEND_API_KEY: "re_live_not_a_real_key",
  TURNSTILE_SECRET_KEY: "turnstile-live-secret",
  PUBLIC_APP_URL: "https://app.example.com",
  BRAND_NAME: "waapi",
  NODE_ENV: "production" as const,
};

const preflightBase: NodeJS.ProcessEnv = {
  ...prodBase,
  AUTH_STATE_ENCRYPTION_KEY: goodAuth,
  EMAIL_FROM: "noreply@example.com",
  WA_DRIVER: "baileys",
  TURNSTILE_DISABLED: "false",
  SMOKE_MODE: "false",
  DEV_RETURN_TOKENS: "false",
  ALLOW_HTTP_WEBHOOKS: "false",
};

describe("WP-M(d) production guards — app boot", () => {
  it("refuses WA_DRIVER=fake", () => {
    expect(() =>
      validateConfigEnv({ ...prodBase, WA_DRIVER: "fake" } as NodeJS.ProcessEnv),
    ).toThrow(/WA_DRIVER/);
  });

  it("refuses TURNSTILE_DISABLED", () => {
    expect(() =>
      validateConfigEnv({ ...prodBase, TURNSTILE_DISABLED: "true" }),
    ).toThrow(/TURNSTILE_DISABLED/);
  });

  it("refuses SMOKE_MODE", () => {
    expect(() => validateConfigEnv({ ...prodBase, SMOKE_MODE: "true" })).toThrow(/SMOKE_MODE/);
  });

  it("refuses EMAIL_DRIVER=console", () => {
    expect(() =>
      validateConfigEnv({ ...prodBase, EMAIL_DRIVER: "console" }),
    ).toThrow(/EMAIL_DRIVER/);
  });

  it("refuses DEV_RETURN_TOKENS", () => {
    expect(() =>
      validateConfigEnv({ ...prodBase, DEV_RETURN_TOKENS: "true" }),
    ).toThrow(/DEV_RETURN_TOKENS/);
  });

  it("refuses ALLOW_HTTP_WEBHOOKS", () => {
    expect(() =>
      validateConfigEnv({ ...prodBase, ALLOW_HTTP_WEBHOOKS: "true" }),
    ).toThrow(/ALLOW_HTTP_WEBHOOKS/);
  });

  it("refuses placeholder secrets", () => {
    expect(() =>
      validateConfigEnv({
        ...prodBase,
        JWT_SECRET: "ci-jwt-secret-at-least-32-characters-long",
      }),
    ).toThrow(/placeholder/);
  });
});

describe("WP-M(d) production guards — preflight", () => {
  it("passes a clean production env", () => {
    expect(runPreflight(preflightBase).ok).toBe(true);
  });

  it.each([
    ["WA_DRIVER", { WA_DRIVER: "fake" }],
    ["TURNSTILE_DISABLED", { TURNSTILE_DISABLED: "true" }],
    ["SMOKE_MODE", { SMOKE_MODE: "true" }],
    ["EMAIL_DRIVER", { EMAIL_DRIVER: "console" }],
    ["DEV_RETURN_TOKENS", { DEV_RETURN_TOKENS: "true" }],
    ["ALLOW_HTTP_WEBHOOKS", { ALLOW_HTTP_WEBHOOKS: "true" }],
    ["placeholder", { JWT_SECRET: "change-me-change-me-change-me-change" }],
  ] as const)("refuses %s", (_label, patch) => {
    const result = runPreflight({ ...preflightBase, ...patch });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n").length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(goodKey);
  });
});
