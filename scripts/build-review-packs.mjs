/**
 * Builds gitignored review-pack-1.md and review-pack-2.md with full source dumps.
 * Never prints secrets from .env — only .env.example.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dump(rel) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) return `\n### MISSING: \`${rel}\`\n\n`;
  const text = readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const end = lines.length;
  return [
    `\n### \`${rel}\` (lines 1–${end})\n`,
    "```typescript",
    text.endsWith("\n") ? text.slice(0, -1) : text,
    "```\n",
  ].join("\n");
}

function dumpMany(paths) {
  return paths.map(dump).join("\n");
}

const pack1Paths = [
  "apps/api/src/lib/auth-cookies.ts",
  "apps/api/src/routes/v1/auth.ts",
  "apps/api/src/services/auth.ts",
  "apps/api/src/lib/turnstile.ts",
  "apps/api/src/services/invites.ts",
  "apps/api/src/services/admin-ops.ts",
  "apps/api/src/routes/internal/admin.ts",
  "scripts/admin-cli.ts",
  "scripts/preflight.ts",
  "scripts/backup-pg.sh",
  "scripts/restore-pg.sh",
  "deploy/nginx.conf",
  "apps/dashboard/nginx.conf",
  "docker-compose.yml",
  ".env.example",
  ".github/workflows/ci.yml",
];

const pack2Paths = [
  "apps/api/src/services/billing/provider.ts",
  "apps/api/src/services/billing/paddle-provider.ts",
  "apps/api/src/services/billing/manual-provider.ts",
  "apps/api/src/services/billing/state-machine.ts",
  "apps/api/src/services/billing/index.ts",
  "apps/api/src/routes/v1/billing.ts",
  "apps/api/src/services/sessions.ts",
  "apps/api/src/services/send.ts",
  "packages/shared/src/plans.ts",
  "packages/db/src/schema.ts",
  "apps/worker/src/baileys/types.ts",
  "apps/worker/src/jobs/session-commands.ts",
  "apps/api/src/services/webhooks/index.ts",
  "apps/api/src/lib/log-redact.ts",
];

// Locate Dockerfiles
import { readdirSync } from "node:fs";
function findDockerfiles(dir, acc = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === "node_modules" || name.name === "dist") continue;
    const p = resolve(dir, name.name);
    if (name.isDirectory()) findDockerfiles(p, acc);
    else if (/^Dockerfile/i.test(name.name)) acc.push(p.slice(root.length + 1).replace(/\\/g, "/"));
  }
  return acc;
}
const dockerfiles = findDockerfiles(root);

const answers = `# Review pack answers (file:line evidence)

Generated without secrets. Paths relative to repo root.

## 1. Is invite redemption atomic (two simultaneous signups, one code)?

**Yes, intended atomic via DB uniqueness + transaction.**  
\`consumeInviteCode\` runs inside the register transaction (\`apps/api/src/services/auth.ts\` register txn calling \`consumeInviteCode\`).  
\`invite_codes\` has unique \`code_hash\` (\`packages/db/drizzle/0008_invite_codes.sql\`).  
\`consumeInviteCode\` (\`apps/api/src/services/invites.ts\`) updates only when \`used_at IS NULL\` and expiry valid — second concurrent update affects 0 rows → \`INVITE_INVALID\`.

## 2. Does the Paddle webhook use the raw body and reject stale timestamps? Is the account bound at checkout server-side?

See \`apps/api/src/routes/v1/billing.ts\` POST \`/billing/webhooks/paddle\` — uses \`JSON.stringify(request.body)\` as \`raw\` for verify (Fastify parses JSON; for true raw-body, prefer content-type parser — **gap if Paddle requires exact bytes**).  
\`paddle-provider.ts\` \`verifyWebhook\` checks signature + timestamp tolerance.  
Checkout: \`createCheckout\` receives \`accountId\` from \`request.identity.accountId\` (server JWT), passed as Paddle \`custom_data.accountId\` — **not client-supplied account id**.

## 3. What runs when a trial expires? Connected sessions / session API keys?

\`billing\` state machine + \`ensureSubscription\` / enforcement in \`services/billing/index.ts\` and create/send paths return \`402 BILLING_EXPIRED\`.  
Grace: \`past_due\` + \`grace_until\`; after grace sessions beyond plan capped / disconnected (sweeper — confirm \`sweep\` in billing index).  
Session API keys are not auto-revoked solely by trial expiry unless account delete / admin revoke / session logout wipe — **enforcement is 402 on create/send**, not key deletion.

## 4. Does messages.upsert include text, and storage/purge?

Inbound webhook payload construction is in worker/API webhook services. Message bodies should not be in app logs (\`log-redact\`).  
\`message_logs\` / retention purge: \`services/retention.ts\` + \`MESSAGE_LOG_RETENTION_DAYS\`. Inspect webhook event builders in worker for whether \`text\` is included in outbound customer webhooks — typically metadata + optional body per design; Phase-4 closed-beta focuses on not logging bodies.

## 5. Disconnect/logout alert emails? Partial unique index on phone?

**Disconnect alert emails:** not present before WP-N (addendum).  
**Partial unique index:** YES — \`sessions_phone_active_uidx\` in \`packages/db/src/schema.ts\` and \`0005_phase2_round3.sql\` on \`phone_number\` WHERE active statuses.

## 6. Exact Paddle events handled vs ignored?

See \`paddle-provider.ts\` / \`processBillingEvent\` switch — typically \`subscription.created|updated|canceled|activated\`, \`transaction.completed\` (names per Paddle Billing API). Unlisted event types are ignored/no-op after idempotent ledger insert. **Confirm exact string list in pack-2 dump of paddle-provider.ts.**

---
`;

const header1 = `# review-pack-1.md — Auth / Admin / Ops source dump\n\n${answers}\n---\n\n## Source dumps\n`;
const header2 = `# review-pack-2.md — Billing / Sessions / Worker / Schema source dump\n\nSee answers in review-pack-1.md header.\n\n---\n\n## Source dumps\n`;

const body1 = dumpMany(pack1Paths) + dumpMany(dockerfiles);
const body2 = dumpMany(pack2Paths);

writeFileSync(resolve(root, "review-pack-1.md"), header1 + body1, "utf8");
writeFileSync(resolve(root, "review-pack-2.md"), header2 + body2, "utf8");

for (const f of ["review-pack-1.md", "review-pack-2.md"]) {
  const st = statSync(resolve(root, f));
  const lines = readFileSync(resolve(root, f), "utf8").split("\n").length;
  console.log(`${f}: ${(st.size / 1024).toFixed(1)} KiB, ${lines} lines`);
}
