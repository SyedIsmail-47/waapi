import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  BRAND_NAME_ENV,
  DEFAULT_MAX_SESSIONS_PER_ACCOUNT,
  DEFAULT_SEED_ACCOUNT_ID,
  getBrandName,
} from "@waapi/shared";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(root, ".env") });

async function main(): Promise<void> {
  const brand = getBrandName(process.env);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const accountId = process.env.SEED_ACCOUNT_ID ?? DEFAULT_SEED_ACCOUNT_ID;

  const { accounts } = await import("../apps/worker/src/db/schema.js");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const existing = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (existing[0]) {
    console.log(JSON.stringify({ ok: true, accountId, created: false }));
  } else {
    await db.insert(accounts).values({
      id: accountId,
      name: `${brand} Local Dev`,
      maxSessions: DEFAULT_MAX_SESSIONS_PER_ACCOUNT,
    });
    console.log(JSON.stringify({ ok: true, accountId, created: true, brandEnv: BRAND_NAME_ENV }));
  }
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
