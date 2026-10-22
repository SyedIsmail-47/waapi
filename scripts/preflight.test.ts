import { describe, expect, it } from "vitest";
import { runPreflight } from "./preflight.js";

const goodKey = Buffer.alloc(32, 9).toString("base64");
const goodPayload = Buffer.alloc(32, 11).toString("base64");
const goodAuth = Buffer.alloc(32, 13).toString("base64");

const baseProd: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  BRAND_NAME: "waapi",
  DATABASE_URL: "postgresql://waapi:secret@localhost:5432/waapi",
  REDIS_URL: "redis://:secret@localhost:6379",
  JWT_SECRET: "production-grade-jwt-secret-value-32b!",
  ADMIN_API_SECRET: "production-admin-secret-value!!",
  WEBHOOK_SECRET_KEY: goodKey,
  PAYLOAD_ENCRYPTION_KEY: goodPayload,
  AUTH_STATE_ENCRYPTION_KEY: goodAuth,
  GLOBAL_MAX_SESSIONS: "100",
  EMAIL_DRIVER: "resend",
  RESEND_API_KEY: "re_live_not_a_real_key",
  TURNSTILE_SECRET_KEY: "turnstile-live-secret",
  PUBLIC_APP_URL: "https://app.example.com",
  EMAIL_FROM: "noreply@example.com",
};

describe("WP-L preflight", () => {
  it("passes a complete production env", () => {
    const result = runPreflight(baseProd);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when GLOBAL_MAX_SESSIONS is unset", () => {
    const { GLOBAL_MAX_SESSIONS: _, ...rest } = baseProd;
    const result = runPreflight(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/GLOBAL_MAX_SESSIONS/);
  });

  it("fails when EMAIL_DRIVER=console", () => {
    const result = runPreflight({ ...baseProd, EMAIL_DRIVER: "console" });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/EMAIL_DRIVER/);
  });

  it("fails on placeholder secrets", () => {
    const result = runPreflight({
      ...baseProd,
      JWT_SECRET: "change-me-change-me-change-me-change",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/placeholder|JWT_SECRET/i);
  });

  it("fails on wrong key length", () => {
    const result = runPreflight({
      ...baseProd,
      WEBHOOK_SECRET_KEY: "too-short",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/32 bytes|WEBHOOK_SECRET_KEY/i);
  });

  it("fails when AUTH_STATE_ENCRYPTION_KEY missing", () => {
    const { AUTH_STATE_ENCRYPTION_KEY: _, ...rest } = baseProd;
    const result = runPreflight(rest);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/AUTH_STATE_ENCRYPTION_KEY/);
  });

  it("never echoes secret values in errors", () => {
    const secret = "super-secret-value-never-print-me-32!!";
    const result = runPreflight({
      ...baseProd,
      JWT_SECRET: "change-me",
      ADMIN_API_SECRET: secret,
    });
    expect(result.ok).toBe(false);
    const blob = JSON.stringify(result);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain(goodKey);
  });
});
