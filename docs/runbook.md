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
2. **Send/receive** — CLI send + reply from phone; `message_logs` has metadata only.
3. **Network drop** — disable network briefly; session `disconnected` then reconnects with backoff.
4. **Phone logout** — unlink device; status `logged_out`; `wa_auth_*` rows wiped.
5. **Logs** — no message bodies, tokens, or auth state.

## RAM / caps

Run `pnpm ram-probe` and compare worker RSS with 0 vs 1 connected session. Set `MAX_SESSIONS_PER_NODE` with headroom for Postgres/Redis/API (launch ceiling ~8–20).

## Failure modes

| Failure | Expected |
|---|---|
| Redis down | Worker/jobs fail; restore Redis |
| Postgres down | Boot/migrate fails; restore DB |
| Worker crash | Restart process; sessions reload from encrypted auth |
| WhatsApp logout | Status `logged_out`; re-scan required |

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
