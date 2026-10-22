import { relations, sql } from "drizzle-orm";
import {
  boolean,
  integer,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { MEMBER_ROLES, SESSION_STATUSES, WEBHOOK_EVENT_TYPES } from "@waapi/shared";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  maxSessions: integer("max_sessions").notNull().default(1),
  planCode: text("plan_code").notNull().default("dev"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  /** Set on refund/chargeback — admin CLI lists for manual review (no auto-suspend). */
  manualReviewAt: timestamp("manual_review_at", { withTimezone: true }),
  manualReviewReason: text("manual_review_reason"),
  disconnectAlertsOptOut: boolean("disconnect_alerts_opt_out").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    role: text("role", { enum: MEMBER_ROLES }).notNull().default("owner"),
    isAdmin: boolean("is_admin").notNull().default(false),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    /** Legal terms version accepted at signup (e.g. "2026-10-22"). */
    termsVersion: text("terms_version"),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailLowerUidx: uniqueIndex("users_email_lower_uidx").using("btree", sql`lower(${t.email})`),
    accountIdx: index("users_account_id_idx").on(t.accountId),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status", { enum: SESSION_STATUSES }).notNull().default("need_scan"),
    phoneNumber: text("phone_number"),
    lastError: text("last_error"),
    authKeyVersion: integer("auth_key_version").notNull().default(1),
    nodeId: text("node_id"),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastDisconnectAlertAt: timestamp("last_disconnect_alert_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdIdx: index("sessions_account_id_idx").on(t.accountId),
    phoneActiveUidx: uniqueIndex("sessions_phone_active_uidx")
      .on(t.phoneNumber)
      .where(sql`${t.phoneNumber} is not null and ${t.status} not in ('logged_out', 'error')`),
  }),
);

/** Per-session send rate counters (minute + day buckets). */
export const sessionSendCounters = pgTable("session_send_counters", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  dayKey: text("day_key").notNull(),
  dayCount: integer("day_count").notNull().default(0),
  minuteKey: text("minute_key").notNull(),
  minuteCount: integer("minute_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const waAuthCreds = pgTable("wa_auth_creds", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  ciphertext: bytea("ciphertext").notNull(),
  iv: bytea("iv").notNull(),
  authTag: bytea("auth_tag").notNull(),
  keyVersion: integer("key_version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const waAuthKeys = pgTable(
  "wa_auth_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    keyType: text("key_type").notNull(),
    keyId: text("key_id").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionKeyUnique: uniqueIndex("wa_auth_keys_session_type_id_uidx").on(
      t.sessionId,
      t.keyType,
      t.keyId,
    ),
  }),
);

export const messageLogs = pgTable(
  "message_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
    remoteJid: text("remote_jid").notNull(),
    messageId: text("message_id").notNull(),
    fromMe: boolean("from_me").notNull(),
    messageType: text("message_type").notNull(),
    /** Stable failure code e.g. delivery_unknown — never message body text. */
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionMsgFromUnique: uniqueIndex("message_logs_session_msg_from_uidx").on(
      t.sessionId,
      t.messageId,
      t.fromMe,
    ),
    sessionCreatedIdx: index("message_logs_session_created_idx").on(t.sessionId, t.createdAt),
  }),
);

export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUidx: uniqueIndex("email_verification_tokens_hash_uidx").on(t.tokenHash),
  }),
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUidx: uniqueIndex("password_reset_tokens_hash_uidx").on(t.tokenHash),
  }),
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    familyId: uuid("family_id").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    replacedBy: uuid("replaced_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUidx: uniqueIndex("refresh_tokens_hash_uidx").on(t.tokenHash),
    userIdx: index("refresh_tokens_user_id_idx").on(t.userId),
    familyIdx: index("refresh_tokens_family_id_idx").on(t.familyId),
  }),
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ip: text("ip").notNull(),
    email: text("email").notNull(),
    succeeded: boolean("succeeded").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ipCreatedIdx: index("login_attempts_ip_created_idx").on(t.ip, t.createdAt),
    emailCreatedIdx: index("login_attempts_email_created_idx").on(t.email, t.createdAt),
  }),
);

export const securityAuditLog = pgTable(
  "security_audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    ip: text("ip"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountCreatedIdx: index("security_audit_log_account_created_idx").on(t.accountId, t.createdAt),
  }),
);

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
  "paused",
] as const;

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    planCode: text("plan_code").notNull().default("trial"),
    status: text("status", { enum: SUBSCRIPTION_STATUSES }).notNull().default("trialing"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    provider: text("provider").notNull().default("manual"),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountUidx: uniqueIndex("subscriptions_account_id_uidx").on(t.accountId),
  }),
);

export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    accountId: uuid("account_id").references(() => accounts.id, { onDelete: "set null" }),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerEventUidx: uniqueIndex("billing_events_provider_event_uidx").on(t.provider, t.eventId),
  }),
);

/** Single-use closed-beta invite codes (plaintext returned once at creation; only hash stored). */
export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    codeHash: text("code_hash").notNull(),
    codePrefix: text("code_prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByUserId: uuid("used_by_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeHashUidx: uniqueIndex("invite_codes_hash_uidx").on(t.codeHash),
  }),
);

export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'["account"]'::jsonb`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUidx: uniqueIndex("personal_access_tokens_hash_uidx").on(t.tokenHash),
    accountIdx: index("personal_access_tokens_account_id_idx").on(t.accountId),
  }),
);

export const sessionApiKeys = pgTable(
  "session_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hashUidx: uniqueIndex("session_api_keys_hash_uidx").on(t.tokenHash),
    sessionIdx: index("session_api_keys_session_id_idx").on(t.sessionId),
  }),
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    accountKeyUidx: uniqueIndex("idempotency_keys_account_key_uidx").on(t.accountId, t.key),
  }),
);

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    toJid: text("to_jid").notNull(),
    status: text("status", {
      enum: ["queued", "sending", "sent", "failed"],
    })
      .notNull()
      .default("queued"),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key"),
    bodyText: text("body_text"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountCreatedIdx: index("outbound_messages_account_created_idx").on(t.accountId, t.createdAt),
    sessionCreatedIdx: index("outbound_messages_session_created_idx").on(t.sessionId, t.createdAt),
    accountIdempotencyUidx: uniqueIndex("outbound_messages_account_idempotency_uidx")
      .on(t.accountId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  }),
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionUidx: uniqueIndex("webhook_endpoints_session_id_uidx").on(t.sessionId),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventType: text("event_type", { enum: WEBHOOK_EVENT_TYPES }).notNull(),
    /** Encrypted envelope `{ __enc: "vN...." }` or null after retention purge. */
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", {
      enum: ["pending", "success", "retrying", "dead", "skipped"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    responseCode: integer("response_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusNextIdx: index("webhook_deliveries_status_next_idx").on(t.status, t.nextAttemptAt),
    sessionCreatedIdx: index("webhook_deliveries_session_created_idx").on(t.sessionId, t.createdAt),
  }),
);

/** Outbox written by worker; consumed by API webhook delivery worker. */
export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventType: text("event_type", { enum: WEBHOOK_EVENT_TYPES }).notNull(),
    /** Encrypted envelope; null after dead-letter purge of body. */
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    status: text("status", { enum: ["pending", "dead"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unprocessedIdx: index("webhook_outbox_unprocessed_idx").on(t.processedAt, t.createdAt),
    claimIdx: index("webhook_outbox_claim_idx").on(t.status, t.nextAttemptAt, t.createdAt),
  }),
);

export const accountsRelations = relations(accounts, ({ many }) => ({
  sessions: many(sessions),
  users: many(users),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  account: one(accounts, {
    fields: [sessions.accountId],
    references: [accounts.id],
  }),
  messageLogs: many(messageLogs),
}));

export const usersRelations = relations(users, ({ one }) => ({
  account: one(accounts, {
    fields: [users.accountId],
    references: [accounts.id],
  }),
}));
