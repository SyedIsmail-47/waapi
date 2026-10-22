# WP-M Security pass — triage

Generated as part of Phase 4 WP-M. **No secrets** in this file.

## Tooling runs

| Step | Result | Evidence / notes |
|------|--------|------------------|
| Log redaction (pino paths + flow test) | Implemented | `apps/api/src/lib/log-redact.ts`, `log-redaction.integration.test.ts` |
| nginx HSTS/CSP/blocks/body/redirect | Implemented | `deploy/nginx.conf`, `apps/dashboard/nginx.conf`, `deploy/nginx-security.test.ts`, `scripts/nginx-security-curl.sh` |
| Backups → `age` + sha256 + rclone | Implemented | `scripts/backup-pg.sh`, `restore-pg.sh`, runbook key custody |
| Production guards (boot + preflight) | Implemented | `config.ts`, `preflight.ts`, `production-guards.test.ts`; smoke uses `NODE_ENV=test` |
| Site legal/price placeholder guard | Implemented | `apps/site/scripts/build.mjs`, `placeholder-guard.test.ts` |
| `pnpm audit` | Triaged below | Run in CI/local; record date |
| gitleaks | CI job | `.github/workflows/ci.yml` `gitleaks` job |
| Rate-limit probe | Script present | `scripts/rate-limit-probe.ps1` (live smoke) |
| OWASP ZAP baseline | Ran (WP-N) | See ZAP triage table below; command: `docker run --rm -t ghcr.io/zaproxy/zaproxy:stable zap-baseline.py -t http://host.docker.internal:8080` against smoke |

## Findings

| ID | Finding | Status | Notes |
|----|---------|--------|-------|
| M-1 | Auth headers/cookies could appear in request logs | **Fixed** | pino `redact` paths for authorization, cookie, set-cookie, x-csrf-token, token, password, text |
| M-2 | Public nginx lacked HSTS/CSP/frame-ancestors | **Fixed** | Edge + dashboard nginx updated; `/internal` + `/metrics` → 404 |
| M-3 | Backup used shared passphrase AES-CBC | **Fixed** | Replaced with age public-key; private key off-server |
| M-4 | `SMOKE_MODE` relaxed production boot | **Fixed** | Production refuses SMOKE_MODE / fake / Turnstile-off; smoke compose → `NODE_ENV=test` |
| M-5 | Site could ship LEGAL_NAME placeholders | **Fixed** | Fail closed when `NODE_ENV=production` or `MERCHANT_OF_RECORD=true` |
| M-6 | `pnpm audit` advisories (transitive) | **Accepted** | Review on each release; no known critical in direct deps at last pass |
| M-7 | ZAP baseline noise on SPA routes | **Triaged (WP-N)** | See ZAP table — SPA catch-all / CSP report-only accepted where applicable |
| M-8 | Unrelated Cursor rules in parent workspace | **Accepted / N/A** | `waapi/.cursor/rules` contains only `project.mdc`. `gmb-scraper` / `deadletter` live under parent `d:/Cursor/.cursor/rules` (multi-project workspace), not this git repo |

## OWASP ZAP baseline triage (WP-N)

Run against smoke stack (`docker compose …smoke…` on `:8080`). Update rows after each run.

| Alert | Risk | Status | Reason |
|-------|------|--------|--------|
| CSP: Wildcard Directive / missing directives | Low/Info | **Accepted** | Edge nginx ships a restrictive CSP; ZAP flags SPA `script-src`/'self' patterns and report-only noise |
| Absence of Anti-CSRF Tokens (API JSON) | Info | **Accepted** | Cookie-mode refresh/logout use double-submit CSRF; Bearer PAT/JWT APIs are not browser form posts |
| Cookie No HttpOnly Flag (`waapi_csrf`) | Low | **Accepted** | CSRF double-submit cookie must be readable by JS; refresh cookie is HttpOnly |
| Application Error Disclosure / 404 on unknown SPA paths | Info | **Accepted** | Dashboard history-fallback returns index.html; API 404s are generic JSON |
| Strict-Transport-Security | Low | **Fixed** | Edge nginx sets HSTS (see M-2); validate behind real TLS terminator |
| X-Content-Type-Options / X-Frame-Options | Low | **Fixed** | Set in nginx (M-2) |
| Server Leaks Version Information | Low | **Deferred** | Prefer hide `Server` at TLS terminator; low risk on closed beta |
| Timestamp Disclosure | Info | **Accepted** | Standard `Date` / build metadata; no secrets |

## Rules confirmation

```
waapi/.cursor/rules/
  project.mdc    ← only this project's rules
```

Unrelated product rules must not be committed into this repository.

## Manual pre-launch checklist

1. `NODE_ENV=production pnpm preflight`
2. `pnpm audit --prod`
3. Smoke stack up → `./scripts/nginx-security-curl.sh`
4. `pwsh scripts/rate-limit-probe.ps1`
5. Optional ZAP baseline against smoke URL
6. Confirm age recipients on backup host; identity offline
