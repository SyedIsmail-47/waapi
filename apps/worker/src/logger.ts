import { pino } from "pino";
import type { WorkerConfig } from "./config.js";

const FORBIDDEN_LOG_KEYS = new Set([
  "text",
  "body",
  "conversation",
  "messageBody",
  "token",
  "apiKey",
  "authorization",
  "creds",
  "authState",
  "ciphertext",
]);

export function createLogger(cfg: WorkerConfig) {
  return pino({
    level: cfg.logLevel,
    redact: {
      paths: [...FORBIDDEN_LOG_KEYS],
      remove: true,
    },
    transport:
      cfg.nodeEnv === "development"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** Assert a log object never includes message bodies / secrets. */
export function assertSafeLogPayload(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_LOG_KEYS.has(key)) {
      throw new Error(`Forbidden log key: ${key}`);
    }
  }
}
