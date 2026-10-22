/**
 * Build + boot prod profile with Mailpit SMTP, then:
 * register → verify via Mailpit → login → create session → GET /health
 */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

loadDotenv({ path: resolve(process.cwd(), ".env") });

const COMPOSE = [
  "compose",
  "-f",
  "docker-compose.yml",
  "-f",
  "docker-compose.smoke.yml",
  "--profile",
  "prod",
];

function run(cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    // Avoid PowerShell eating docker --format {{.Names}} templates.
    const useShell = process.platform === "win32" && cmd !== "docker";
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: useShell,
      env: { ...process.env, ...opts?.env },
    });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url: string, ok: (status: number, body: string) => boolean, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      last = `${res.status} ${body.slice(0, 200)}`;
      if (ok(res.status, body)) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2_000);
  }
  throw new Error(`Timeout waiting for ${url}: ${last}`);
}

async function mailpitToken(email: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const res = await fetch("http://127.0.0.1:8025/api/v1/messages");
    if (!res.ok) {
      await sleep(1_500);
      continue;
    }
    const data = (await res.json()) as {
      messages?: Array<{ ID: string; To?: Array<{ Address?: string }> }>;
    };
    const match = (data.messages ?? []).find((m) =>
      (m.To ?? []).some((t) => (t.Address ?? "").toLowerCase() === email.toLowerCase()),
    );
    if (match) {
      const detail = await fetch(`http://127.0.0.1:8025/api/v1/message/${match.ID}`);
      const body = (await detail.json()) as { Text?: string; HTML?: string };
      const text = `${body.Text ?? ""}\n${body.HTML ?? ""}`;
      const m =
        /verification token:\s*([A-Za-z0-9_-]+)/i.exec(text) ??
        /token[:\s]+([A-Za-z0-9_-]{20,})/i.exec(text);
      if (m?.[1]) return m[1];
    }
    await sleep(1_500);
  }
  throw new Error(`No Mailpit verification email for ${email}`);
}

async function main() {
  console.log("== smoke:prod check-compose ==");
  const check = await run("powershell", [
    "-NoProfile",
    "-File",
    "scripts/check-compose-prod.ps1",
  ]);
  if (check !== 0) process.exit(check);

  console.log("== smoke:prod build + up ==");
  const up = await run("docker", [...COMPOSE, "up", "-d", "--build"], {
    env: {
      NODE_ENV: "production",
      EMAIL_DRIVER: "smtp",
      SMTP_URL: "smtp://mailpit:1025",
      DEV_RETURN_TOKENS: "false",
      // Avoid parallel api+worker tsc OOMing the host during bake
      COMPOSE_PARALLEL_LIMIT: "1",
      BUILDKIT_MAX_PARALLELISM: "1",
    },
  });
  if (up !== 0) process.exit(up);

  try {
    console.log("== wait /health ==");
    await waitFor("http://127.0.0.1:3000/health", (s) => s === 200);

    const email = `smoke-${Date.now()}@example.test`;
    const password = "correct-horse-battery-staple";
    console.log("== register ==");
    const reg = await fetch("http://127.0.0.1:3000/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "smoke", acceptTerms: true }),
    });
    const regBody = await reg.text();
    console.log("register", reg.status, regBody.slice(0, 200));
    if (reg.status !== 201) throw new Error("register failed");
    if (regBody.includes("verificationToken")) {
      throw new Error("DEV_RETURN_TOKENS leaked verificationToken in production smoke");
    }

    console.log("== verify via Mailpit ==");
    const token = await mailpitToken(email);
    const ver = await fetch("http://127.0.0.1:3000/api/v1/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    console.log("verify", ver.status);
    if (ver.status !== 204) throw new Error("verify failed");

    console.log("== login ==");
    const login = await fetch("http://127.0.0.1:3000/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = (await login.json()) as { accessToken?: string };
    console.log("login", login.status);
    if (login.status !== 200 || !loginBody.accessToken) throw new Error("login failed");

    console.log("== create session ==");
    const sess = await fetch("http://127.0.0.1:3000/api/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({ name: "smoke-session" }),
    });
    const sessBody = await sess.text();
    console.log("session", sess.status, sessBody.slice(0, 200));
    if (sess.status !== 201) throw new Error("create session failed");

    console.log("== /health again ==");
    const health = await fetch("http://127.0.0.1:3000/health");
    console.log("health", health.status, await health.text());
    if (!health.ok) throw new Error("health failed");

    console.log("SMOKE_PROD_OK");
  } finally {
    console.log("== docker ps ==");
    await run("docker", ["ps", "--format", "table {{.Names}}\t{{.Ports}}"]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
