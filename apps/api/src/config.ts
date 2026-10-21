import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getBrandTokens } from "@waapi/shared";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
loadDotenv({ path: resolve(rootDir, ".env") });
loadDotenv({ path: resolve(process.cwd(), ".env"), override: false });

const bool = (fallback: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value) => {
      if (typeof value === "boolean") return value;
      if (value == null) return fallback;
      return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    });

const PLACEHOLDER_SECRETS = new Set([
  "",
  "change-me",
  "changeme",
  "secret",
  "password",
  "ci-jwt-secret-at-least-32-characters-long",
  "ci-admin-secret",
  "test-jwt-secret-that-is-at-least-32-bytes",
  "test-admin-api-secret",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
]);

function decodeKey32(value: string, name: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return decoded;
}

function rejectPlaceholder(name: string, value: string): string {
  const trimmed = value.trim();
  if (PLACEHOLDER_SECRETS.has(trimmed) || PLACEHOLDER_SECRETS.has(trimmed.toLowerCase())) {
    throw new Error(`${name} is a placeholder or empty; set a real secret`);
  }
  if (/^A{16,}=*$/i.test(trimmed) || /^0{32,}$/.test(trimmed)) {
    throw new Error(`${name} looks like a placeholder; set a real secret`);
  }
  return trimmed;
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_ISSUER: z.string().default("waapi"),
  JWT_AUDIENCE: z.string().default("waapi-api"),
  REFRESH_TTL: z.string().default("30d"),
  ADMIN_API_SECRET: z.string().min(16),
  EMAIL_DRIVER: z.enum(["console", "resend", "smtp"]).default("console"),
  RESEND_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  WEBHOOK_SECRET_KEY: z.string().min(1),
  /** AES-GCM key for webhook_outbox payloads at rest (32 bytes base64|hex). */
  PAYLOAD_ENCRYPTION_KEY: z.string().min(1),
  PAYLOAD_ENCRYPTION_KEY_VERSION: z.string().default("v1"),
  /** Optional JSON map of older outbox keys: {"v0":"<base64|hex>"} */
  PAYLOAD_ENCRYPTION_KEY_RING: z.string().optional(),
  BRAND_NAME: z.string().default("waapi"),
  /** Generous pre-auth per-IP ceiling (all routes). */
  RATE_LIMIT_IP_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  /** Failed bearer/auth attempts per IP before 429. */
  RATE_LIMIT_FAILED_AUTH_MAX: z.coerce.number().int().positive().default(30),
  /** Authenticated requests per account (plan default). */
  RATE_LIMIT_ACCOUNT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_LOGIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_REGISTER: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_REFRESH: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_FORGOT_PASSWORD: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_RESET_PASSWORD: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_VERIFY_EMAIL: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_RESEND_VERIFICATION: z.coerce.number().int().positive().default(5),
  RESEND_VERIFICATION_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  /** Per-account send-message ceiling (stricter than account default). */
  SEND_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  /** No default — required in production; optional elsewhere for tests. */
  GLOBAL_MAX_SESSIONS: z.coerce.number().int().positive().optional(),
  DEFAULT_ACCOUNT_MAX_SESSIONS: z.coerce.number().int().positive().default(1),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(15),
  WEBHOOK_DEAD_AFTER_CONSECUTIVE: z.coerce.number().int().positive().default(15),
  /** AES-GCM key version prefix for webhook_deliveries.payload at rest. */
  WEBHOOK_PAYLOAD_KEY_VERSION: z.string().default("v1"),
  /** Optional JSON map of older payload keys: {"v0":"<base64|hex>"} */
  WEBHOOK_PAYLOAD_KEY_RING: z.string().optional(),
  /** Purge encrypted payload body 72h after success (metadata row kept). */
  WEBHOOK_PAYLOAD_PURGE_SUCCESS_HOURS: z.coerce.number().int().positive().default(72),
  /** Purge encrypted payload body 7d after failed/dead (metadata row kept). */
  WEBHOOK_PAYLOAD_PURGE_FAILED_DAYS: z.coerce.number().int().positive().default(7),
  DEV_RETURN_TOKENS: bool(false),
  ENABLE_DOCS: bool(false),
  ALLOW_DOCS_IN_PROD: bool(false),
  ALLOW_HTTP_WEBHOOKS: bool(false),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  TRUST_CLOUDFLARE: bool(false),
  CORS_ORIGINS: z.string().optional(),
});

export type Config = z.infer<typeof envSchema> & {
  GLOBAL_MAX_SESSIONS: number;
  brand: ReturnType<typeof getBrandTokens>;
};

function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  decodeKey32(parsed.WEBHOOK_SECRET_KEY, "WEBHOOK_SECRET_KEY");
  decodeKey32(parsed.PAYLOAD_ENCRYPTION_KEY, "PAYLOAD_ENCRYPTION_KEY");

  let globalMax = parsed.GLOBAL_MAX_SESSIONS;
  if (parsed.NODE_ENV === "production") {
    if (globalMax == null) {
      throw new Error("GLOBAL_MAX_SESSIONS is required in production");
    }
    rejectPlaceholder("JWT_SECRET", parsed.JWT_SECRET);
    rejectPlaceholder("ADMIN_API_SECRET", parsed.ADMIN_API_SECRET);
    rejectPlaceholder("WEBHOOK_SECRET_KEY", parsed.WEBHOOK_SECRET_KEY);
    rejectPlaceholder("PAYLOAD_ENCRYPTION_KEY", parsed.PAYLOAD_ENCRYPTION_KEY);
    if (parsed.DEV_RETURN_TOKENS) {
      throw new Error("DEV_RETURN_TOKENS must be false in production");
    }
    if (parsed.ALLOW_HTTP_WEBHOOKS) {
      throw new Error("ALLOW_HTTP_WEBHOOKS must be false in production");
    }
    if (parsed.ENABLE_DOCS && !parsed.ALLOW_DOCS_IN_PROD) {
      throw new Error("ENABLE_DOCS requires ALLOW_DOCS_IN_PROD=true in production");
    }
    if (parsed.EMAIL_DRIVER === "console") {
      throw new Error("EMAIL_DRIVER=console is forbidden in production; use resend or smtp");
    }
    if (parsed.EMAIL_DRIVER === "resend" && !parsed.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when EMAIL_DRIVER=resend");
    }
    if (parsed.EMAIL_DRIVER === "smtp" && !parsed.SMTP_URL) {
      throw new Error("SMTP_URL is required when EMAIL_DRIVER=smtp");
    }
  }
  globalMax ??= 100;

  return {
    ...parsed,
    GLOBAL_MAX_SESSIONS: globalMax,
    brand: getBrandTokens(parsed.BRAND_NAME),
  };
}

export const config = loadConfig();

export const isDevTokenReturnEnabled = (): boolean => {
  const env = process.env.NODE_ENV ?? config.NODE_ENV;
  const raw = process.env.DEV_RETURN_TOKENS;
  const flag =
    raw == null
      ? config.DEV_RETURN_TOKENS
      : ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  return env !== "production" && flag;
};

export const validateConfigEnv = loadConfig;
