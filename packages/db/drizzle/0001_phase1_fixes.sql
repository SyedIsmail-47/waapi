CREATE UNIQUE INDEX "message_logs_session_msg_from_uidx" ON "message_logs" USING btree ("session_id","message_id","from_me");--> statement-breakpoint
CREATE INDEX "message_logs_session_created_idx" ON "message_logs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "sessions" USING btree ("account_id");