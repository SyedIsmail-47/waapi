-- Phase 2 round 4: encrypted webhook payloads (nullable after purge), message log error

ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload" DROP NOT NULL;

ALTER TABLE "message_logs" ADD COLUMN IF NOT EXISTS "error" text;
