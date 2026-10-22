ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "manual_review_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "manual_review_reason" text;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "disconnect_alerts_opt_out" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_disconnect_alert_at" timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_send_counters" (
  "session_id" uuid PRIMARY KEY REFERENCES "sessions"("id") ON DELETE cascade,
  "day_key" text NOT NULL,
  "day_count" integer NOT NULL DEFAULT 0,
  "minute_key" text NOT NULL,
  "minute_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
