CREATE TABLE IF NOT EXISTS "invite_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL,
  "code_prefix" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "used_by_user_id" uuid,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invite_codes"
    ADD CONSTRAINT "invite_codes_used_by_user_id_users_id_fk"
    FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invite_codes_hash_uidx" ON "invite_codes" ("code_hash");
