export const SESSION_STATUSES = [
  "need_scan",
  "connecting",
  "connected",
  "disconnected",
  "logged_out",
  "error",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const DEFAULT_MAX_SESSIONS_PER_ACCOUNT = 10;
export const DEFAULT_MAX_SESSIONS_PER_NODE = 10;
export const DEFAULT_AUTH_KEY_VERSION = 1;

export const QUEUE_SEND_TEXT = "send-text";

export const REDIS_CHANNEL = {
  qr: (sessionId: string) => `session:${sessionId}:qr`,
  status: (sessionId: string) => `session:${sessionId}:status`,
} as const;

/** Fixed local seed account for Phase 1 (no auth yet). */
export const DEFAULT_SEED_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
