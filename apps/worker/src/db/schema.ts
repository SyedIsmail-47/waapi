import { relations } from "drizzle-orm";
import {
  boolean,
  integer,
  customType,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { SESSION_STATUSES } from "@waapi/shared";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  maxSessions: integer("max_sessions").notNull().default(10),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status", { enum: SESSION_STATUSES }).notNull().default("need_scan"),
  phoneNumber: text("phone_number"),
  lastError: text("last_error"),
  authKeyVersion: integer("auth_key_version").notNull().default(1),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

export const messageLogs = pgTable("message_logs", {
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accountsRelations = relations(accounts, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  account: one(accounts, {
    fields: [sessions.accountId],
    references: [accounts.id],
  }),
  messageLogs: many(messageLogs),
}));
