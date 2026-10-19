import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Queue, QueueEvents } from "bullmq";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Redis } from "ioredis";
import {
  DEFAULT_SEED_ACCOUNT_ID,
  QUEUE_SEND_TEXT,
  REDIS_CHANNEL,
  sendTextJobSchema,
  type SendTextJob,
} from "@waapi/shared";
import { eq } from "drizzle-orm";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(root, ".env") });

function usage(): never {
  console.log(`Usage:
  pnpm cli -- create-session --name <name>
  pnpm cli -- status --session <id>
  pnpm cli -- send --session <id> --to <e164|jid> --text <message>
  pnpm cli -- wait-qr --session <id>
`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) usage();

  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error("DATABASE_URL and REDIS_URL required");
  const accountId = process.env.SEED_ACCOUNT_ID ?? DEFAULT_SEED_ACCOUNT_ID;

  const { sessions } = await import("../apps/worker/src/db/schema.js");
  const { createSessionTransactional } = await import("../apps/worker/src/db/sessions.js");
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  if (cmd === "create-session") {
    const name = arg("--name") ?? "demo";
    const row = await createSessionTransactional(db, {
      accountId,
      name,
      maxSessionsPerNode: Number(process.env.MAX_SESSIONS_PER_NODE ?? 10),
      currentNodeSessionCount: 0,
    });
    const { publishOpenSession } = await import("../apps/worker/src/redis/commands.js");
    const redis = new Redis(redisUrl);
    await publishOpenSession(redis, row.accountId, row.id);
    await redis.quit();
    console.log(JSON.stringify({ sessionId: row.id, accountId: row.accountId, status: row.status }));
    console.log("If worker is running: pnpm cli -- wait-qr --session", row.id);
    await client.end();
    return;
  }

  if (cmd === "status") {
    const sessionId = arg("--session");
    if (!sessionId) usage();
    const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row || row.accountId !== accountId) {
      console.error(JSON.stringify({ error: "SESSION_NOT_FOUND_FOR_ACCOUNT" }));
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        sessionId: row.id,
        accountId: row.accountId,
        status: row.status,
        phoneNumber: row.phoneNumber,
        lastError: row.lastError,
      }),
    );
    await client.end();
    return;
  }

  if (cmd === "wait-qr") {
    const sessionId = arg("--session");
    if (!sessionId) usage();
    const redis = new Redis(redisUrl);
    const qrcode = await import("qrcode-terminal");
    console.log("Waiting for QR on", REDIS_CHANNEL.qr(sessionId));
    await redis.subscribe(REDIS_CHANNEL.qr(sessionId));
    redis.on("message", (_ch, message) => {
      const parsed = JSON.parse(message) as { qr: string };
      console.log("QR received — scan with WhatsApp Linked Devices");
      qrcode.default.generate(parsed.qr, { small: true });
    });
    await client.end();
    return;
  }

  if (cmd === "send") {
    const sessionId = arg("--session");
    const to = arg("--to");
    const text = arg("--text");
    if (!sessionId || !to || !text) usage();
    const payload = sendTextJobSchema.parse({
      accountId,
      sessionId,
      to,
      text,
    } satisfies SendTextJob);
    const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue<SendTextJob>(QUEUE_SEND_TEXT, { connection });
    const events = new QueueEvents(QUEUE_SEND_TEXT, { connection: connection.duplicate() });
    await events.waitUntilReady();
    const job = await queue.add("send", payload);
    const result = await job.waitUntilFinished(events, 60_000);
    console.log(JSON.stringify({ ok: true, result }));
    await queue.close();
    await events.close();
    await connection.quit();
    await client.end();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
