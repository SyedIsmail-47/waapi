export const SESSION_STATUSES = [
  "need_scan",
  "connecting",
  "connected",
  "disconnected",
  "logged_out",
  "error",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const MEMBER_ROLES = ["owner", "member"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const DEFAULT_MAX_SESSIONS_PER_ACCOUNT = 1;
export const DEFAULT_MAX_SESSIONS_PER_NODE = 10;
export const DEFAULT_AUTH_KEY_VERSION = 1;
export const QR_TTL_SECONDS = 60;

export const QUEUE_SEND_TEXT = "send-text";
export const QUEUE_SESSION_COMMANDS = "session-commands";
export const QUEUE_WEBHOOK_DELIVERY = "webhook-delivery";
export const QUEUE_EMAIL = "email";

export const REDIS_CHANNEL = {
  qr: (sessionId: string) => `session:${sessionId}:qr`,
  status: (sessionId: string) => `session:${sessionId}:status`,
} as const;

export const REDIS_KEY = {
  qr: (sessionId: string) => `waapi:qr:${sessionId}`,
} as const;

/** Fixed local seed account for Phase 1 (no auth yet). */
export const DEFAULT_SEED_ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

export const WEBHOOK_EVENT_TYPES = [
  "session.status",
  "qrcode.updated",
  "messages.upsert",
  "message.sent",
  "message.failed",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
