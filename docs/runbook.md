# Runbook

## Local services

```bash
cp .env.example .env
# set AUTH_STATE_ENCRYPTION_KEY and PAYLOAD_ENCRYPTION_KEY to 32 random bytes, base64
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm seed
pnpm dev:api
pnpm dev:worker
pnpm dev:dashboard
```

### Dashboard (Phase 3)

- Dev: Vite on `http://127.0.0.1:5173` proxies `/api` and `/health` to the API (same-origin paths, CORS stays closed).
- Prod compose: `dashboard` service on `127.0.0.1:8080` serves the SPA and proxies `/api` → `api:3000`.
- Auth: access token in memory only; refresh in `HttpOnly; Secure; SameSite=Strict` cookie `Path=/api/v1/auth`; CSRF double-submit cookie + `X-CSRF-Token` on cookie-mode refresh/logout.
- Turnstile: set `TURNSTILE_SECRET_KEY` + `VITE_TURNSTILE_SITE_KEY`. Tests/smoke use `TURNSTILE_DISABLED=true` (with `SMOKE_MODE=true` only for the smoke overlay).
- Brand: `BRAND_NAME` / `VITE_BRAND_NAME` via `@waapi/shared` + `apps/dashboard/src/brand.ts`.
- Signups: `SIGNUPS_MODE=open|invite|closed` (default `invite`). Invite mode requires a single-use code at register; dashboard shows the field via `GET /api/v1/auth/signup-config`. Mint codes (plaintext once):

```bash
curl -sS -X POST "http://127.0.0.1:3001/internal/admin/invites" \
  -H "x-admin-secret: $ADMIN_API_SECRET" \
  -H "content-type: application/json" \
  -d '{"expiresInHours":168}'
```

Smoke overlay sets `SIGNUPS_MODE=open` so Playwright can register without invites.

### Account lifecycle (Phase 4 WP-D)

- `POST /api/v1/auth/change-password` — JWT; revokes other refresh tokens.
- `POST /api/v1/auth/resend-verification` — public with `{email}` or JWT with empty body.
- `POST /api/v1/auth/delete-account` — JWT + password; enqueues WA logout per session, wipes `wa_auth_*`, revokes keys/webhooks/PATs, deletes message logs, then deletes the account.

### Email links (Phase 4 WP-C)

Set `PUBLIC_APP_URL` to the absolute dashboard origin (no trailing slash), e.g. `https://app.example.com`. Verify and reset emails include HTML + text with links to `/verify-email?token=…` and `/reset-password?token=…`. Brand text uses `BRAND_NAME`. Production refuses boot without `PUBLIC_APP_URL`.


### Playwright e2e against smoke stack

```bash
docker compose -f docker-compose.yml -f docker-compose.smoke.yml --profile prod up -d --build
pnpm --filter @waapi/dashboard exec playwright install chromium
DASHBOARD_BASE_URL=http://127.0.0.1:8080 pnpm --filter @waapi/dashboard test:e2e
```

### Fake WhatsApp driver (Phase 4 WP-A)

Set `WA_DRIVER=fake` on the worker (smoke overlay sets this; production forbids unless `SMOKE_MODE=true`).

Simulate QR scan (worker must be subscribed to Redis `waapi:fake:control`):

```bash
curl -sS -X POST "http://127.0.0.1:3001/internal/admin/fake/sessions/$SESSION_ID/scan" \
  -H "x-admin-secret: $ADMIN_API_SECRET" \
  -H "content-type: application/json" \
  -d '{"phoneNumber":"+15550001111"}'
```

Also: `.../inbound`, `.../ban`. Contract tests: `apps/worker/src/baileys/wa-client.contract.test.ts`.  
Playwright: `apps/dashboard/e2e/fake-driver.spec.ts` (needs `ADMIN_API_SECRET`).

### Email / production env

`EMAIL_DRIVER=console` is **refused** when `NODE_ENV=production` (API and workers will not boot).
For production, use a **separate env file that is never committed** (for example `.env.production`, loaded by your host/orchestrator — not checked into git). Set:

- `EMAIL_DRIVER=smtp` and `SMTP_URL=...`, or
- `EMAIL_DRIVER=resend` and `RESEND_API_KEY=...`

Also set `EMAIL_FROM` to a verified sender. Local/dev may keep `EMAIL_DRIVER=console`.

Metrics: `http://localhost:9091/metrics`

### Windows note

Docker Desktop must be installed and `docker` available on PATH. If `pnpm docker:up` fails, start Docker Desktop first, then retry.

## CLI

```bash
pnpm cli -- create-session --name demo
pnpm cli -- wait-qr --session <id>
pnpm cli -- status --session <id>
pnpm cli -- send --session <id> --to 15551234567 --text hello
pnpm ram-probe
```

## Manual acceptance checks

1. **Restart without rescan** — create session, scan QR, stop worker, start worker; status stays `connected`.
2. **Send/receive** — CLI send + reply from phone; `message_logs` has metadata only (`notify` upserts).
3. **Network drop** — disable network briefly; session `disconnected` then reconnects with backoff + jitter.
4. **Phone logout** — unlink device; status `logged_out`; `wa_auth_*` rows wiped; no reconnect timer.
5. **Logs** — no message bodies, tokens, or auth state.
6. **kill -9 worker recovery** — with a `connected` session, `kill -9` the worker PID, restart worker; session reloads (staggered) under a Redis lease (`waapi:lease:<sessionId>`), status returns to `connected` without QR rescan.
7. **440 connectionReplaced** — open the same WhatsApp account in another client/device so Baileys gets status `440`; worker must stop reconnect, mark session `error` with reason `connection_replaced`, and not thrash reconnect.
8. **Node cap enforcement** — set `MAX_SESSIONS_PER_NODE=1`, create/open a second session on the same worker; expect `NODE_SESSION_CAP` and no additional live socket.
9. **RAM probe table** — run `pnpm ram-probe` (or equivalent) and record RSS:

| Connected sessions | Worker RSS (approx) | Notes |
|---|---|---|
| 1 | | fill after probe |
| 3 | | |
| 5 | | |
| 10 | | |

Use the table to set `MAX_SESSIONS_PER_NODE` with headroom for Postgres/Redis/API (launch ceiling often ~8–20 depending on VPS RAM).

## Phase 2 curl acceptance

Run the API and worker, then use this development flow. Registration returns
`verificationToken` outside production; in production, take the token from the
verification email instead. The webhook URL must be a public HTTP(S) address.

```bash
BASE=http://localhost:3000/api/v1
EMAIL_A="phase2-a-$(date +%s)@example.com"
EMAIL_B="phase2-b-$(date +%s)@example.com"
PASSWORD='correct-horse-battery-staple'

REGISTER_A=$(curl -sS -X POST "$BASE/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PASSWORD\",\"name\":\"Account A\"}")
VERIFY_A=$(printf '%s' "$REGISTER_A" | jq -r .verificationToken)
curl -i -X POST "$BASE/auth/verify-email" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$VERIFY_A\"}"
LOGIN_A=$(curl -sS -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_A\",\"password\":\"$PASSWORD\"}")
ACCESS_A=$(printf '%s' "$LOGIN_A" | jq -r .accessToken)

SESSION=$(curl -sS -X POST "$BASE/sessions" \
  -H "authorization: Bearer $ACCESS_A" \
  -H 'content-type: application/json' \
  -d '{"name":"curl-acceptance"}')
SESSION_ID=$(printf '%s' "$SESSION" | jq -r .id)

# Point this at a public catcher (webhook.site, requestbin, etc.). Deliveries are
# signed with X-Waapi-Signature / X-Waapi-Timestamp / X-Waapi-Delivery-Id.
curl -sS -X PUT "$BASE/sessions/$SESSION_ID/webhook" \
  -H "authorization: Bearer $ACCESS_A" \
  -H 'content-type: application/json' \
  -d '{"url":"https://webhook.site/replace-with-your-public-id","secret":"acceptance-webhook-secret"}'

curl -sS -X POST "$BASE/sessions/$SESSION_ID/connect" \
  -H "authorization: Bearer $ACCESS_A"
# Poll until status is need_scan and qr.value is present (worker must be running).
curl -sS "$BASE/sessions/$SESSION_ID/status" \
  -H "authorization: Bearer $ACCESS_A" | jq .
# Optional synthetic delivery (also exercises HMAC + outbox path):
curl -sS -X POST "$BASE/sessions/$SESSION_ID/webhook/test" \
  -H "authorization: Bearer $ACCESS_A"

REGISTER_B=$(curl -sS -X POST "$BASE/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PASSWORD\",\"name\":\"Account B\"}")
VERIFY_B=$(printf '%s' "$REGISTER_B" | jq -r .verificationToken)
curl -sS -X POST "$BASE/auth/verify-email" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$VERIFY_B\"}"
LOGIN_B=$(curl -sS -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL_B\",\"password\":\"$PASSWORD\"}")
ACCESS_B=$(printf '%s' "$LOGIN_B" | jq -r .accessToken)

# Expect 404 (403 is also acceptable for an explicit authorization policy).
curl -i "$BASE/sessions/$SESSION_ID" \
  -H "authorization: Bearer $ACCESS_B"
```

## `delivery_unknown` (outbound send)

When the WhatsApp client returns an ambiguous send error (timeout / unknown ack),
the worker marks the outbound row `failed` with `error: "delivery_unknown"` and
does **not** auto-retry (a retry could double-send).

- **GET `/api/v1/messages`** — items may include `"error": "delivery_unknown"`.
- **Webhook `message.failed`** — `data.error` is `"delivery_unknown"` (no message body).
- **Deduping** — treat `(sessionId, outboundId)` or `(sessionId, messageId)` as the
  idempotency key. If you later see a `message.sent` / inbound echo for the same
  conversation, reconcile client-side; do not re-call send with a new Idempotency-Key
  unless you intend a second message.

## CORS plan

- Default: CORS is **disabled** (`origin: false`). The API is for server-side / mobile
  clients and same-origin reverse proxies, not open browser cross-origin access.
- When a first-party dashboard needs browser access, set `CORS_ORIGINS` to an explicit
  comma-separated allowlist (e.g. `https://app.example.com`). Do not use `*` in production.
- Helmet is enabled globally (CSP off so OpenAPI/docs remain usable when enabled).
- All source files and HTTP bodies are UTF-8 without BOM.

## RAM / caps

Run `pnpm ram-probe` and fill the table above. Set `MAX_SESSIONS_PER_NODE` with headroom for Postgres/Redis/API.
`GLOBAL_MAX_SESSIONS` is required in production (no code default). New accounts get
`DEFAULT_ACCOUNT_MAX_SESSIONS` (default 1).

## Worker node lock (`WORKER_ID`)

On boot the worker takes Redis key `waapi:node:<WORKER_ID>` with a random `bootId` and renews it for the process lifetime (`SESSION_LEASE_TTL_MS`, default **30s**).

- Two live processes with the same `WORKER_ID` → second boot fails with `NODE_LOCK_HELD`.
- After `kill -9` / crash, the lock is **not** released; wait up to the TTL (**max wait = `SESSION_LEASE_TTL_MS`**, default 30s) for expiry, then restart — or set a unique `WORKER_ID`.
- Compose worker service uses `stop_grace_period: 30s` so graceful shutdown (flush → close, parallel dispose capped at 25s) can finish before SIGKILL.

### Dispose order

| Path | Order |
|---|---|
| Normal shutdown | `disconnect({ flush: true })` (flush ≤5s) → `dispose` → release session lease → release node lock |
| Logout (401) | `closeAuth` → wipe+`logged_out` (one txn) → `disconnect({ flush: false })` → `dispose` → release lease |

## Failure modes

| Failure | Expected |
|---|---|
| Redis down | Worker/jobs fail; restore Redis |
| Postgres down | Boot/migrate fails; restore DB |
| Worker crash (`kill -9`) | Restart process; wait ≤ node-lock TTL if same `WORKER_ID`; sessions reload with stagger + Redis lease |
| Duplicate `WORKER_ID` (live) | Boot refuses with `NODE_LOCK_HELD` |
| 440 connection replaced | Status `error` / `connection_replaced`; no reconnect loop |
| WhatsApp logout (401) | Status `logged_out`; auth wiped; no reconnect timer |
| Node session cap | `NODE_SESSION_CAP`; no extra live client |

## Phase 1 summary

### Built

- pnpm monorepo (`@waapi/api`, `@waapi/worker`, `@waapi/dashboard`, `@waapi/shared`)
- Brand via `BRAND_NAME` env + `@waapi/shared` helpers
- Docker Compose (Postgres 16 + Redis 7)
- Drizzle schema/migrations: accounts, sessions, wa_auth_creds, wa_auth_keys, message_logs
- Seeded local account (no auth API)
- AES-256-GCM Postgres auth-state adapter (no multi-file auth)
- Baileys 6.7.24 behind `WAClient` interface
- Session manager: QR Redis pub/sub, statuses, reconnect backoff+jitter, logout wipe, boot reload, caps, graceful shutdown, Prometheus metrics
- BullMQ `send-text` jobs + metadata message logs
- Cross-platform CLI + RAM probe (`tsx`)
- Vitest unit/integration tests + GitHub Actions CI
- `.cursor/rules/project.mdc` (alwaysApply)

### Skipped / deferred

- Customer auth, PAT/API keys, Fastify `/api/v1`, webhooks (Phase 2)
- Dashboard features (Phase 3)
- Billing (Phase 5)
- Cloudflare / reverse proxy production lockdown (Phase 6)
- Message retention purge job (schema retention env present; job later)
- Live Docker acceptance on this machine if Docker Desktop not on PATH

### Known risks

- Unofficial WhatsApp (Baileys) ban/protocol breakage
- Unofficial Baileys ecosystem may introduce future transitive CVEs; Fastify stub is 5.12.5, drizzle-orm 0.45.2; `pnpm audit --prod` was clean at Phase 1 cut
- Multi-session RAM must be measured on the VPS before selling caps
