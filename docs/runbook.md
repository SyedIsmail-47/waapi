# Runbook (Phase 1)

## Local services

```bash
cp .env.example .env
# set AUTH_STATE_ENCRYPTION_KEY to 32 random bytes, base64
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm seed
pnpm dev:worker
```

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

## RAM / caps

Run `pnpm ram-probe` and fill the table above. Set `MAX_SESSIONS_PER_NODE` with headroom for Postgres/Redis/API.

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
