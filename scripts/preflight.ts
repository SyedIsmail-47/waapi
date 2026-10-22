/**
 * Production go-live preflight — fails closed on missing/placeholder/wrong-length env.
 * Never prints secret values.
 *
 * Usage: NODE_ENV=production pnpm preflight
 */
import { config as loadDotenv } from "dotenv";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(root, ".env") });
loadDotenv({ path: resolve(root, ".env.production"), override: true });

const PLACEHOLDERS = new Set([
  "",
  "change-me",
  "changeme",
  "secret",
  "password",
  "ci-jwt-secret-at-least-32-characters-long",
  "ci-admin-secret",
  "test-jwt-secret-that-is-at-least-32-bytes",
  "test-admin-api-secret",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
]);

function decodeKey32(value: string | undefined, name: string, errors: string[]): void {
  if (!value?.trim()) {
    errors.push(`${name} is required`);
    return;
  }
  try {
    const decoded = /^[0-9a-f]{64}$/i.test(value)
      ? Buffer.from(value, "hex")
      : Buffer.from(value, "base64");
    if (decoded.length !== 32) {
      errors.push(`${name} must decode to exactly 32 bytes`);
    }
  } catch {
    errors.push(`${name} is not valid base64/hex`);
  }
}

function rejectPlaceholder(name: string, value: string | undefined, errors: string[]): void {
  if (value == null) {
    errors.push(`${name} is required`);
    return;
  }
  const trimmed = value.trim();
  if (PLACEHOLDERS.has(trimmed) || PLACEHOLDERS.has(trimmed.toLowerCase())) {
    errors.push(`${name} is a placeholder or empty; set a real secret`);
    return;
  }
  if (/^A{16,}=*$/i.test(trimmed) || /^0{32,}$/.test(trimmed) || /^change-me/i.test(trimmed)) {
    errors.push(`${name} looks like a placeholder; set a real secret`);
  }
}

export type PreflightResult = { ok: boolean; errors: string[] };

/** Pure checker — safe for unit tests; never includes secret values in errors. */
export function runPreflight(env: NodeJS.ProcessEnv = process.env): PreflightResult {
  const errors: string[] = [];
  const nodeEnv = env.NODE_ENV ?? "development";

  if (nodeEnv !== "production") {
    errors.push("NODE_ENV must be production for go-live preflight");
  }

  for (const key of [
    "BRAND_NAME",
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "ADMIN_API_SECRET",
    "PUBLIC_APP_URL",
    "TURNSTILE_SECRET_KEY",
  ] as const) {
    if (!env[key]?.trim()) errors.push(`${key} is required`);
  }

  if (!env.GLOBAL_MAX_SESSIONS?.trim()) {
    errors.push("GLOBAL_MAX_SESSIONS is required (must be set intentionally for capacity)");
  }

  if ((env.EMAIL_DRIVER ?? "console") === "console") {
    errors.push("EMAIL_DRIVER=console is forbidden in production; use resend or smtp");
  }
  if (env.EMAIL_DRIVER === "resend" && !env.RESEND_API_KEY?.trim()) {
    errors.push("RESEND_API_KEY is required when EMAIL_DRIVER=resend");
  }
  if (env.EMAIL_DRIVER === "smtp" && !env.SMTP_URL?.trim()) {
    errors.push("SMTP_URL is required when EMAIL_DRIVER=smtp");
  }

  rejectPlaceholder("JWT_SECRET", env.JWT_SECRET, errors);
  rejectPlaceholder("ADMIN_API_SECRET", env.ADMIN_API_SECRET, errors);
  rejectPlaceholder("WEBHOOK_SECRET_KEY", env.WEBHOOK_SECRET_KEY, errors);
  rejectPlaceholder("PAYLOAD_ENCRYPTION_KEY", env.PAYLOAD_ENCRYPTION_KEY, errors);
  rejectPlaceholder("AUTH_STATE_ENCRYPTION_KEY", env.AUTH_STATE_ENCRYPTION_KEY, errors);

  decodeKey32(env.WEBHOOK_SECRET_KEY, "WEBHOOK_SECRET_KEY", errors);
  decodeKey32(env.PAYLOAD_ENCRYPTION_KEY, "PAYLOAD_ENCRYPTION_KEY", errors);
  decodeKey32(env.AUTH_STATE_ENCRYPTION_KEY, "AUTH_STATE_ENCRYPTION_KEY", errors);

  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters");
  }

  if (env.DEV_RETURN_TOKENS === "true" && env.SMOKE_MODE !== "true") {
    errors.push("DEV_RETURN_TOKENS must be false in production");
  }
  if (env.ALLOW_HTTP_WEBHOOKS === "true") {
    errors.push("ALLOW_HTTP_WEBHOOKS must be false in production");
  }
  if (env.WA_DRIVER === "fake" && env.SMOKE_MODE !== "true") {
    errors.push("WA_DRIVER=fake is forbidden outside SMOKE_MODE");
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function main() {
  const result = runPreflight(process.env);
  if (result.ok) {
    console.log("preflight ok");
    process.exit(0);
  }
  console.error("preflight failed:");
  for (const err of result.errors) {
    console.error(` - ${err}`);
  }
  process.exit(1);
}

const thisFile = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const isCli =
  !process.env.VITEST &&
  entry.length > 0 &&
  (entry === thisFile || basename(entry).startsWith("preflight."));

if (isCli) {
  main();
}
