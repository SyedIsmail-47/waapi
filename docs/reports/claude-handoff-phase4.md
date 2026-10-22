# Claude / agent handoff — Phase 4 (WP-N complete)

**Branch tip:** `wp-n-reliability` → merge into `phase-4` when CI green.  
**Do not merge to `main` until the final PR.** Never `--admin`. Never print secrets.

## Status

| WP | Name | Status |
|----|------|--------|
| A–G, J, L, M | Prior Phase 4 | Merged on `phase-4` |
| N | Reliability + Paddle N1–N8 | **Implemented** on `wp-n-reliability` |
| H / I | Media / webhook parity | **Stopped** (out of scope for this handoff) |

## WP-N deliverables

| ID | Item | Notes |
|----|------|-------|
| Core | Disconnect alerts | 6h dedupe, opt-out, HTML+text `session_disconnect` |
| Core | Send limits + warm-up | `SESSION_SEND_LIMIT` 429 + Retry-After |
| Core | PHONE_IN_USE | Unique index → worker `lastError`; dashboard copy |
| Core | Billing sweeper | Trial/grace → expired; 5‑min timer |
| N1 | Paddle raw Buffer | `parseAs: buffer`; HMAC `ts:rawBody`; multi-h1; ±5m |
| N2 | Price allowlist + customer bind | Unknown price audit; customer id bind |
| N3 | Events | updated/paused/resumed/adjustment.* → manual review |
| N4 | Enforcement matrix | states × creds × actions; BILLING_EXPIRED 402 |
| N5 | Prod cookies | HttpOnly Secure Strict Path; CSRF; logout clears |
| N6 | Playwright CI | `e2e` job in `ci.yml` (smoke + fake driver) |
| N7 | ZAP | Triaged in `docs/reports/security-pass.md` |
| N8 | Docs | No Stripe; Paddle go-live checklist in runbook; packs + PDFs |

## Commands

```bash
pnpm lint && pnpm typecheck
CI=true pnpm test
# smoke + e2e:
docker compose -f docker-compose.yml -f docker-compose.smoke.yml --profile prod up -d --build
DASHBOARD_BASE_URL=http://127.0.0.1:8080 pnpm --filter @waapi/dashboard test:e2e
```

## Next for agent

1. Confirm CI `build` + `gitleaks` (+ `e2e` when stable) green on `wp-n-reliability`
2. Merge into `phase-4` only (not main)
3. Open ONE PR `phase-4` → `main`
4. Create empty branch `phase-5-parity` from `phase-4`
5. **STOP** — do not start WP-H/I
