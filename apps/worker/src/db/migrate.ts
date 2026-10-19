import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loadConfig } from "../config.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = postgres(cfg.databaseUrl, { max: 1 });
  const db = drizzle(client);
  const migrationsFolder = resolve(fileURLToPath(new URL("../..", import.meta.url)), "drizzle");
  await migrate(db, { migrationsFolder });
  await client.end();
  console.log(JSON.stringify({ ok: true, migrationsFolder }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
