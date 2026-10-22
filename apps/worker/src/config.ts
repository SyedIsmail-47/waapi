import { config as loadDotenv } from "dotenv";
import { hostname } from "node:os";
import { z } from "zod";
import {
  BRAND_NAME_ENV,
  DEFAULT_MAX_SESSIONS_PER_NODE,
  DEFAULT_SEED_ACCOUNT_ID,
} from "@waapi/shared";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKeyRing, type EncryptionKeyRing } from "./crypto/key-ring.js";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
loadDotenv({ path: resolve(rootDir, ".env") });

const PLACEHOLDER_SECRETS = new Set([
  "",
  "change-me",
  "changeme",
  "secret",
  "password",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
]);

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

function decodeKey32(value: string, name: string): Buffer {
  const decoded = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (decoded.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return decoded;
}

const envSchema = z.object({
  BRAND_NAME: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AUTH_STATE_ENCRYPTION_KEY: z.string().min(1),
  AUTH_STATE_KEY_VERSION: z.coerce.number().int().positive().default(1),
  /** Optional JSON map of version -> base64 or 64-char hex key for decrypting older rows. */
  AUTH_STATE_KEY_RING: z.string().optional(),
  PAYLOAD_ENCRYPTION_KEY: z.string().min(1),
  PAYLOAD_ENCRYPTION_KEY_VERSION: z.string().default("v1"),
  PAYLOAD_ENCRYPTION_KEY_RING: z.string().optional(),
  MAX_SESSIONS_PER_NODE: z.coerce.number().int().positive().default(DEFAULT_MAX_SESSIONS_PER_NODE),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9091),
  SEED_ACCOUNT_ID: z.string().uuid().default(DEFAULT_SEED_ACCOUNT_ID),
  MESSAGE_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  BOOT_CONNECT_STAGGER_MS: z.coerce.number().int().nonnegative().default(500),
  SESSION_LEASE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_ID: z.string().min(1).optional(),
  SEND_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(800),
  /** baileys (default) | fake — fake is for tests/smoke closed-beta automation. */
  WA_DRIVER: z.enum(["baileys", "fake"]).default("baileys"),
  FAKE_QR_DELAY_MS: z.coerce.number().int().nonnegative().default(50),
});

export type WorkerConfig = {
  brandName: string;
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  keyRing: EncryptionKeyRing;
  authStateKeyVersion: number;
  payloadEncryptionKey: string;
  payloadEncryptionKeyVersion: string;
  payloadEncryptionKeyRing?: string;
  maxSessionsPerNode: number;
  workerMetricsPort: number;
  seedAccountId: string;
  messageLogRetentionDays: number;
  bootConnectStaggerMs: number;
  sessionLeaseTtlMs: number;
  workerId: string;
  sendMinIntervalMs: number;
  waDriver: "baileys" | "fake";
  fakeQrDelayMs: number;
};

let cached: WorkerConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  if (cached && env === process.env) return cached;
  const parsed = envSchema.safeParse({
    ...env,
    [BRAND_NAME_ENV]: env[BRAND_NAME_ENV],
  });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  decodeKey32(parsed.data.PAYLOAD_ENCRYPTION_KEY, "PAYLOAD_ENCRYPTION_KEY");
  if (parsed.data.NODE_ENV === "production") {
    rejectPlaceholder("AUTH_STATE_ENCRYPTION_KEY", parsed.data.AUTH_STATE_ENCRYPTION_KEY);
    rejectPlaceholder("PAYLOAD_ENCRYPTION_KEY", parsed.data.PAYLOAD_ENCRYPTION_KEY);
    if (env.SMOKE_MODE === "true" || env.SMOKE_MODE === "1") {
      throw new Error("SMOKE_MODE must be false in production (use NODE_ENV=test for local smoke)");
    }
    if (parsed.data.WA_DRIVER === "fake") {
      throw new Error("WA_DRIVER=fake is forbidden in production");
    }
  }
  const keyRing = buildKeyRing({
    currentVersion: parsed.data.AUTH_STATE_KEY_VERSION,
    currentKeyRaw: parsed.data.AUTH_STATE_ENCRYPTION_KEY,
    ringJson: parsed.data.AUTH_STATE_KEY_RING,
  });
  const cfg: WorkerConfig = {
    brandName: parsed.data.BRAND_NAME,
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    keyRing,
    authStateKeyVersion: parsed.data.AUTH_STATE_KEY_VERSION,
    payloadEncryptionKey: parsed.data.PAYLOAD_ENCRYPTION_KEY,
    payloadEncryptionKeyVersion: parsed.data.PAYLOAD_ENCRYPTION_KEY_VERSION,
    payloadEncryptionKeyRing: parsed.data.PAYLOAD_ENCRYPTION_KEY_RING,
    maxSessionsPerNode: parsed.data.MAX_SESSIONS_PER_NODE,
    workerMetricsPort: parsed.data.WORKER_METRICS_PORT,
    seedAccountId: parsed.data.SEED_ACCOUNT_ID,
    messageLogRetentionDays: parsed.data.MESSAGE_LOG_RETENTION_DAYS,
    bootConnectStaggerMs: parsed.data.BOOT_CONNECT_STAGGER_MS,
    sessionLeaseTtlMs: parsed.data.SESSION_LEASE_TTL_MS,
    // Stable across restarts: explicit WORKER_ID, else hostname (not a random UUID).
    workerId: parsed.data.WORKER_ID ?? hostname(),
    sendMinIntervalMs: parsed.data.SEND_MIN_INTERVAL_MS,
    waDriver: parsed.data.WA_DRIVER,
    fakeQrDelayMs: parsed.data.FAKE_QR_DELAY_MS,
  };
  if (env === process.env) cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = null;
}
