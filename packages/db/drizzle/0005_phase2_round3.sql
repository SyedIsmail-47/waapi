-- Phase 2 round 3: caps, phone uniqueness, outbound idempotency, session soft-delete helpers

ALTER TABLE "accounts" ALTER COLUMN "max_sessions" SET DEFAULT 1;

-- One active phone number across all accounts (not logged_out / error)
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_phone_active_uidx"
  ON "sessions" ("phone_number")
  WHERE "phone_number" IS NOT NULL
    AND "status" NOT IN ('logged_out', 'error');

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

-- Exactly one outbound row per (account, idempotency_key) when key present
CREATE UNIQUE INDEX IF NOT EXISTS "outbound_messages_account_idempotency_uidx"
  ON "outbound_messages" ("account_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

ALTER TABLE "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;

-- Cleared after final send/fail so sweeper can re-enqueue lost jobs
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "body_text" text;
