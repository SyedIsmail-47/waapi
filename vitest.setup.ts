import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

// Load project .env first so Redis password / DB URL win over bare defaults.
loadDotenv({ path: resolve(process.cwd(), ".env"), override: true });

process.env.NODE_ENV ??= "test";
process.env.BRAND_NAME ??= "waapi-test";
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-at-least-32-bytes";
process.env.ADMIN_API_SECRET ??= "test-admin-api-secret";
process.env.WEBHOOK_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.PAYLOAD_ENCRYPTION_KEY ??= Buffer.alloc(32, 11).toString("base64");
process.env.PAYLOAD_ENCRYPTION_KEY_VERSION ??= "v1";
process.env.AUTH_STATE_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
process.env.DATABASE_URL ??= "postgresql://waapi:waapi@localhost:5432/waapi";
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = process.env.REDIS_PASSWORD
    ? `redis://:${process.env.REDIS_PASSWORD}@localhost:6379`
    : "redis://localhost:6379";
}
process.env.DEV_RETURN_TOKENS ??= "true";
process.env.ALLOW_HTTP_WEBHOOKS ??= "true";
process.env.ENABLE_DOCS ??= "false";
// Integration suites register many times from one IP; avoid .env prod-ish caps.
process.env.RATE_LIMIT_IP_MAX = "10000";
process.env.RATE_LIMIT_FAILED_AUTH_MAX = "10000";
process.env.RATE_LIMIT_REGISTER = "10000";
process.env.RATE_LIMIT_LOGIN = "10000";
process.env.RATE_LIMIT_REFRESH = "10000";
process.env.RATE_LIMIT_FORGOT_PASSWORD = "10000";
process.env.RATE_LIMIT_RESET_PASSWORD = "10000";
process.env.RATE_LIMIT_VERIFY_EMAIL = "10000";
process.env.RATE_LIMIT_RESEND_VERIFICATION = "10000";
process.env.SEND_RATE_LIMIT_MAX = "10000";
process.env.RATE_LIMIT_ACCOUNT_MAX = "10000";
process.env.GLOBAL_MAX_SESSIONS ??= "1000";
process.env.DEFAULT_ACCOUNT_MAX_SESSIONS ??= "1";
process.env.EMAIL_DRIVER ??= "console";
process.env.TURNSTILE_DISABLED ??= "true";
process.env.COOKIE_SECURE ??= "false";
process.env.REFRESH_REUSE_GRACE_SECONDS ??= "10";
// Existing suites register freely; invite-gate tests flip SIGNUPS_MODE at runtime.
process.env.SIGNUPS_MODE ??= "open";
