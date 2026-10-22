/**
 * Internal admin CLI — talks to INTERNAL_BASE_URL with x-admin-secret.
 * Never prints message bodies or secrets from responses.
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
loadDotenv({ path: resolve(root, ".env") });

function usage(): never {
  console.log(`Usage (internal only):
  pnpm admin -- find-user --q <email|id>
  pnpm admin -- suspend --account <uuid>
  pnpm admin -- unsuspend --account <uuid>
  pnpm admin -- set-plan --account <uuid> --plan <trial|starter|pro|enterprise>
  pnpm admin -- revoke-keys --account <uuid>
  pnpm admin -- force-logout --session <uuid>
  pnpm admin -- failing-webhooks [--limit 50]
  pnpm admin -- create-invite [--hours 168] [--note text]
`);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

async function admin(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const base = (process.env.INTERNAL_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  const secret = process.env.ADMIN_API_SECRET;
  if (!secret) throw new Error("ADMIN_API_SECRET required");
  const res = await fetch(`${base}/internal/admin${path}`, {
    method,
    headers: {
      "x-admin-secret": secret,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  if (!res.ok) {
    console.error(JSON.stringify({ status: res.status, error: json }));
    process.exit(1);
  }
  return json;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) usage();

  if (cmd === "find-user") {
    const q = arg("--q");
    if (!q) usage();
    console.log(JSON.stringify(await admin("GET", `/users?q=${encodeURIComponent(q)}`), null, 2));
    return;
  }
  if (cmd === "suspend") {
    const account = arg("--account");
    if (!account) usage();
    await admin("POST", `/accounts/${account}/suspend`);
    console.log(JSON.stringify({ ok: true, action: "suspend", account }));
    return;
  }
  if (cmd === "unsuspend") {
    const account = arg("--account");
    if (!account) usage();
    await admin("POST", `/accounts/${account}/unsuspend`);
    console.log(JSON.stringify({ ok: true, action: "unsuspend", account }));
    return;
  }
  if (cmd === "set-plan") {
    const account = arg("--account");
    const plan = arg("--plan");
    if (!account || !plan) usage();
    await admin("POST", `/accounts/${account}/plan`, { planCode: plan });
    console.log(JSON.stringify({ ok: true, action: "set-plan", account, plan }));
    return;
  }
  if (cmd === "revoke-keys") {
    const account = arg("--account");
    if (!account) usage();
    await admin("POST", `/accounts/${account}/revoke-keys`);
    console.log(JSON.stringify({ ok: true, action: "revoke-keys", account }));
    return;
  }
  if (cmd === "force-logout") {
    const session = arg("--session");
    if (!session) usage();
    console.log(JSON.stringify(await admin("POST", `/sessions/${session}/force-logout`)));
    return;
  }
  if (cmd === "failing-webhooks") {
    const limit = arg("--limit") ?? "50";
    console.log(
      JSON.stringify(await admin("GET", `/webhooks/failing?limit=${encodeURIComponent(limit)}`), null, 2),
    );
    return;
  }
  if (cmd === "create-invite") {
    const hours = Number(arg("--hours") ?? "168");
    const note = arg("--note");
    const created = (await admin("POST", "/invites", {
      expiresInHours: hours,
      note: note ?? undefined,
    })) as { code: string; expiresAt: string };
    // Print invite code once (intentional); never log hashes.
    console.log(JSON.stringify({ code: created.code, expiresAt: created.expiresAt }));
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
