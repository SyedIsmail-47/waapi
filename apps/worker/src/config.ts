import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import {
  BRAND_NAME_ENV,
  DEFAULT_MAX_SESSIONS_PER_NODE,
  DEFAULT_SEED_ACCOUNT_ID,
} from "@waapi/shared";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
loadDotenv({ path: resolve(rootDir, ".env") });

function parseEncryptionKey(raw: string): Buffer {
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("AUTH_STATE_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
  }
  return buf;
}

const envSchema = z.object({
  BRAND_NAME: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AUTH_STATE_ENCRYPTION_KEY: z.string().min(1),
  AUTH_STATE_KEY_VERSION: z.coerce.number().int().positive().default(1),
  MAX_SESSIONS_PER_NODE: z.coerce.number().int().positive().default(DEFAULT_MAX_SESSIONS_PER_NODE),
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9091),
  SEED_ACCOUNT_ID: z.string().uuid().default(DEFAULT_SEED_ACCOUNT_ID),
  MESSAGE_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
});

export type WorkerConfig = {
  brandName: string;
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  authStateEncryptionKey: Buffer;
  authStateKeyVersion: number;
  maxSessionsPerNode: number;
  workerMetricsPort: number;
  seedAccountId: string;
  messageLogRetentionDays: number;
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
  const cfg: WorkerConfig = {
    brandName: parsed.data.BRAND_NAME,
    nodeEnv: parsed.data.NODE_ENV,
    logLevel: parsed.data.LOG_LEVEL,
    databaseUrl: parsed.data.DATABASE_URL,
    redisUrl: parsed.data.REDIS_URL,
    authStateEncryptionKey: parseEncryptionKey(parsed.data.AUTH_STATE_ENCRYPTION_KEY),
    authStateKeyVersion: parsed.data.AUTH_STATE_KEY_VERSION,
    maxSessionsPerNode: parsed.data.MAX_SESSIONS_PER_NODE,
    workerMetricsPort: parsed.data.WORKER_METRICS_PORT,
    seedAccountId: parsed.data.SEED_ACCOUNT_ID,
    messageLogRetentionDays: parsed.data.MESSAGE_LOG_RETENTION_DAYS,
  };
  if (env === process.env) cached = cfg;
  return cfg;
}

export function resetConfigCache(): void {
  cached = null;
}
