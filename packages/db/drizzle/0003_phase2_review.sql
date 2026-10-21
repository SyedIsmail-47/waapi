ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX IF EXISTS "users_email_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uidx" ON "users" (lower("email"));--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "qr_payload";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "qr_updated_at";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "qr_expires_at";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_status_check";--> statement-breakpoint
-- allow skipped status (no check constraint in drizzle default)
UPDATE "personal_access_tokens" SET "scopes" = '["account"]'::jsonb WHERE "scopes" = '[]'::jsonb OR "scopes" = '["*"]'::jsonb;
