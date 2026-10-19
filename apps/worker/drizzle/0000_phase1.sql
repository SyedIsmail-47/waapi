CREATE TABLE IF NOT EXISTS "accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "max_sessions" integer DEFAULT 10 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'need_scan' NOT NULL,
  "phone_number" text,
  "last_error" text,
  "auth_key_version" integer DEFAULT 1 NOT NULL,
  "last_connected_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "wa_auth_creds" (
  "session_id" uuid PRIMARY KEY NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "key_version" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "wa_auth_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "key_type" text NOT NULL,
  "key_id" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "key_version" integer NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "message_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "direction" text NOT NULL,
  "remote_jid" text NOT NULL,
  "message_id" text NOT NULL,
  "from_me" boolean NOT NULL,
  "message_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "wa_auth_creds" ADD CONSTRAINT "wa_auth_creds_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "wa_auth_keys" ADD CONSTRAINT "wa_auth_keys_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "wa_auth_keys_session_type_id_uidx" ON "wa_auth_keys" USING btree ("session_id","key_type","key_id");
