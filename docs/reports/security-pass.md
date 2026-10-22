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

Ran against smoke (`http://host.docker.internal:8080`). Result: **FAIL-NEW: 0**, WARN-NEW: 7, PASS: 60. Log: `docs/reports/zap-baseline-latest.txt` (gitignored if present).

| Alert | Risk | Status | Reason |
|-------|------|--------|--------|
| CSP: Wildcard Directive [10055] | Low | **Accepted** | SPA nginx CSP; ZAP noise on robots/sitemap |
| Server Leaks Version (`Server` header) [10036] | Low | **Deferred** | Hide at TLS terminator; low risk closed beta |
| Storable and Cacheable Content [10049] | Info | **Accepted** | Static SPA assets intentionally cacheable |
| Permissions-Policy missing [10063] | Low | **Deferred** | Add at edge nginx pre-launch if needed |
| Modern Web Application [10109] | Info | **Accepted** | Informational SPA detection |
| Sub Resource Integrity missing [90003] | Low | **Accepted** | Same-origin bundled assets; SRI optional |
| Cross-Origin-Embedder-Policy missing [90004] | Low | **Deferred** | Not required for this product surface yet |
| Absence of Anti-CSRF Tokens | Info | **Accepted** (PASS in this run) | Cookie refresh uses double-submit CSRF |
| Strict-Transport-Security | — | **Fixed** (PASS) | Edge nginx HSTS (M-2) |

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
