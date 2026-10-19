# Runbook (Phase 1)

## Local services

```bash
pnpm docker:up
pnpm db:migrate
pnpm seed
pnpm dev:worker
```

Metrics: `http://localhost:9091/metrics` (when worker is running).

## Manual acceptance checks

1. **Restart without rescan** — create session, scan QR, stop worker, start worker; status stays `connected`.
2. **Send/receive** — `pnpm cli -- send ...`; reply from phone; check `message_logs` (metadata only).
3. **Network drop** — disable network briefly; session goes `disconnected` then reconnects.
4. **Phone logout** — unlink device; status `logged_out`; auth rows wiped.
5. **Logs** — confirm no message bodies, tokens, or auth state in logs.

## RAM / caps

Run `pnpm ram-probe` and record RSS for 0 / need_scan N / 1 connected session. Set `MAX_SESSIONS_PER_NODE` from measured memory with headroom for Postgres/Redis/API.

## Failure modes

| Failure | Expected |
|---|---|
| Redis down | Worker fails boot or jobs stall; restart Redis |
| Postgres down | Boot fails; restore DB |
| Worker crash | systemd/PM2 restart; sessions reload from encrypted auth |
| WhatsApp logout | Status `logged_out`; user must re-scan |

## Phase 1 summary placeholder

Filled at end of Phase 1 implementation.
