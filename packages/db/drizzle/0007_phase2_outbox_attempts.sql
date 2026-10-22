-- Outbox retry / dead-letter: never delete poison rows on decrypt failure.
ALTER TABLE "webhook_outbox" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "webhook_outbox" ADD COLUMN IF NOT EXISTS "last_error" text;
ALTER TABLE "webhook_outbox" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz;
ALTER TABLE "webhook_outbox" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "webhook_outbox" ALTER COLUMN "payload" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "webhook_outbox_claim_idx"
  ON "webhook_outbox" ("status", "next_attempt_at", "created_at");
