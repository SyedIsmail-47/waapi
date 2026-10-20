# Supervisor Review Pack — waapi through Phase 2 (complete state)

**Audience:** Supervisor (Claude) conducting Phase 2 / post–round-2 review  
**Date:** 2026-10-20  
**Repo path:** `d:\Cursor\waapi`  
**Branch:** `phase-2-api` (Phase 2 + round-2 fixes largely **uncommitted** as of this report)  
**Brand placeholder:** `waapi` / `@waapi/*` (`BRAND_NAME` env + `@waapi/shared`)

---

## 1. Executive summary

| Item | Status |
|------|--------|
| Phase 1 — monorepo + Baileys session engine | **Done** (committed earlier on branch history) |
| Phase 2 — Fastify `/api/v1`, auth, sessions, send-text, webhooks | **Done** (code on working tree; round-1 + round-2 review fixes applied) |
| Automated tests (`CI=true`, real Postgres + Redis) | **85 passed / 0 failed / 0 skipped / 0 todo** (18 files) |
| Live local demo | **Verified:** QR link → WhatsApp connected → send text delivered (`status=sent`) |
| Phase 3 — production dashboard (shadcn, Turnstile, cookies, etc.) | **Not started** (only a temporary connect UI for local demo) |
| Phase 4–7 (media, billing, ops, growth) | **Not started** |
| Production deploy (Hostinger / Cloudflare) | **Not done** (local Docker Desktop only) |

**Bottom line for supervisor:** The product core works end-to-end locally: register/login → create session → scan QR → send text. Phase 2 API security fixes from rounds 1–2 are implemented and covered by unit/integration tests against real Postgres/Redis with `CI=true`. Remaining work starts at Phase 3 (real dashboard) and later phases per SUPERVISOR.md.

---

## 2. Git / workspace state

```
Branch: phase-2-api
Recent commits (already on branch):
  f5741e6 Fix Phase 1 supervisor review: leases, auth flush, reconnect, schema.
  7471b28 Add proprietary All rights reserved LICENSE.
  3c485e4 Implement Phase 1 session engine.
  aa3f595 Scaffold pnpm monorepo for Phase 1.

Working tree: large set of modified + untracked Phase 2 files (API, db package,
Dockerfiles, deploy/nginx, dashboard connect UI, review-phase2.txt, etc.).
Phase 2 is NOT fully committed yet — review against working tree + this doc.
```

**Companion artifact:** `review-phase2.txt` in repo root — concatenated source bundle prepared for paste-based review (large). Prefer this markdown as the narrative + test report; use the bundle for file-by-file reading if needed.

---

## 3. Product architecture (current)

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ apps/dashboard  │────▶│ apps/api         │────▶│ Postgres 16     │
│ Vite React      │     │ Fastify 5        │     │ (Docker)        │
│ (temp QR UI)    │     │ /api/v1 + /docs  │     └─────────────────┘
└─────────────────┘     │ internal :3001   │────▶┌─────────────────┐
                        │ BullMQ producers │     │ Redis 7         │
                        └────────┬─────────┘     │ (Docker)        │
                                 │               └─────────────────┘
                        ┌────────▼─────────┐
                        │ apps/worker      │  Baileys sessions, leases,
                        │ + api webhooks   │  send-text consumer,
                        │   process        │  webhook delivery worker
                        └──────────────────┘
```

| Package / app | Role |
|---------------|------|
| `apps/api` | Public Fastify API, auth, sessions, send, messages, webhook config, OpenAPI (optional), internal admin routes, email + webhook workers entrypoints |
| `apps/worker` | Baileys session manager, Redis leases/node lock, outbound send jobs, QR in Redis |
| `apps/dashboard` | **Temporary** connect UI (login + QR). **Not** Phase 3 product dashboard |
| `packages/db` | Shared Drizzle schema + migrations (`0000`–`0004`) |
| `packages/shared` | Zod schemas, types, brand helper, queue/event constants |
| `deploy/nginx.conf` | Cloudflare `real_ip` + hop guidance for `TRUST_PROXY_HOPS` / `TRUST_CLOUDFLARE` |
| `docker-compose.yml` | Postgres + Redis always; `prod` profile for migrate/api/webhooks/worker images |

**Hard rule observed:** API does not import Baileys / worker session internals; sessions are commanded via BullMQ.

---

## 4. Phase 1 — what was delivered

Scaffolded pnpm monorepo; worker session engine with:

- Encrypted `wa_auth_creds` / `wa_auth_keys` (AES-256-GCM + key ring)
- Redis session leases (`SET NX PX`, renew Lua, reclaim after kill -9)
- Per-node `WORKER_ID` lock
- Status machine: `need_scan` → `connecting` → `connected` / `disconnected` / `logged_out` / `error`
- Disconnect mapping (401 logout, 440 connection replaced, backoff + jitter)
- Account-scoped queries + tenant isolation test
- Caps: account `max_sessions`, node `MAX_SESSIONS_PER_NODE`
- CLI + RAM probe scripts; runbook acceptance checklist
- Metrics on worker (`WORKER_METRICS_PORT`)

Phase 1 supervisor fixes (committed): lease reclaim, auth flush races, reconnect behavior, schema cleanups.

---

## 5. Phase 2 — what was delivered

### 5.1 Auth & accounts

- Register / login (argon2id) / email verify / resend / forgot + reset password
- JWT access (HS256, iss/aud) + rotating refresh tokens; family revoke on reuse (commits before 401; ordered `FOR UPDATE` + deadlock retry)
- Logout-all
- PATs (account-level) and session API keys (hashed, revocable)
- Login timing hardening (dummy argon2 on unknown email)
- Brute-force / rate limits (global Redis + **per-auth-route buckets**)
- Security audit log events (e.g. refresh reuse)
- Roles modeled (`owner` / member path present; team invites later)

### 5.2 Sessions API

- `POST/GET /api/v1/sessions`
- `GET/DELETE /api/v1/sessions/:id`
- `GET /api/v1/sessions/:id/status` (QR when `need_scan`, from Redis)
- `POST .../connect|disconnect|logout`
- Session create uses **`SELECT … FOR UPDATE`** on account; global + account caps; rollback row if enqueue fails
- Session keys under `/sessions/:id/keys`

### 5.3 Messaging

- `POST /api/v1/send-message` — text only; E.164 or JID; **Idempotency-Key required**
- Claim via `idempotency_keys` (`ON CONFLICT DO NOTHING`) + row `FOR UPDATE` before creating outbound
- Worker `claimOutboundForSend`: `queued` → `sending` → `sent`/`failed`; message body redacted only after success/final fail
- `GET /api/v1/messages` — cursor pagination over `message_logs` (metadata; no bodies in logs)

### 5.4 Webhooks

- Per-session endpoint upsert/get/delete + test enqueue
- Events intended: `session.status`, `qrcode.updated`, `messages.upsert`, `message.sent`
- HMAC signing helpers; SSRF guards (ipaddr.js + pinned DNS/undici Agent); `ALLOW_HTTP_WEBHOOKS` gated
- Outbox + delivery worker (`apps/api` webhooks process)
- Encrypted webhook secrets at rest (`WEBHOOK_SECRET_KEY` 32 bytes)

### 5.5 Cross-cutting API

- Consistent error envelope + request IDs
- OpenAPI/Swagger **dynamically imported only when `ENABLE_DOCS=true`**
- `trustProxy` = **numeric hop count** (`TRUST_PROXY_HOPS`), not boolean `true`
- `clientIp()`: uses `CF-Connecting-IP` only if `TRUST_CLOUDFLARE=true`; else Fastify `request.ip`
- Production boot refuses: `DEV_RETURN_TOKENS`, `ALLOW_HTTP_WEBHOOKS`, docs without `ALLOW_DOCS_IN_PROD`, placeholder secrets
- Internal admin routes on loopback port (`INTERNAL_PORT`), separate from public API
- Dockerfiles for api/worker; compose `prod` profile; nginx real_ip sample

### 5.6 Round-2 supervisor items (explicit checklist)

| # | Requirement | Implementation |
|---|-------------|----------------|
| 1 | `trustProxy` hop NUMBER + `clientIp` + `TRUST_CLOUDFLARE` + nginx | `app.ts`, `lib/client-ip.ts`, `deploy/nginx.conf`, `.env.example` |
| 2 | Per-auth-route rate limit buckets | `lib/auth-rate-limit.ts`, auth routes, tests |
| 3 | Send-text idempotent; clear body only after success/final fail | `services/send.ts`, worker `send-text.ts`, claim tests, `0004_outbound_sending.sql` |
| 4 | Production config guards + secret validation | `config.ts` + `config.test.ts` |
| 5 | Dynamic swagger import | `app.ts` `ENABLE_DOCS` block |
| 6 | Docker production setup | `apps/api/Dockerfile`, `apps/worker/Dockerfile`, compose profiles |
| 7 | Review bundle + real PG/Redis tests (no false claims) | `review-phase2.txt`; this report; CI workflow services |

### 5.7 Extra fixes found during live/CI bring-up

- Worker `createSessionTransactional`: account `FOR UPDATE` (concurrency caps)
- Refresh family revoke: do not throw inside TX (would rollback); deadlock retry
- Webhook `DELETE`: 404 if session not owned (tenant isolation)
- `db:migrate` loads root `.env` via `tsx --env-file`
- API `config` loads monorepo-root `.env`
- Vitest raises rate limits in `vitest.setup.ts` so integration suites are not 429’d by `.env` caps
- Temporary dashboard connect UI + Vite proxy to API (demo only)

---

## 6. HTTP API surface (Phase 2)

Base: `http://127.0.0.1:3000`  
Docs (dev): `/docs` when `ENABLE_DOCS=true`  
Health: `GET /health`

### Auth (`/api/v1/auth`)

| Method | Path | Notes |
|--------|------|-------|
| POST | `/register` | Optional `verificationToken` if `DEV_RETURN_TOKENS` |
| POST | `/login` | |
| POST | `/refresh` | |
| POST | `/verify-email` | |
| POST | `/resend-verification` | |
| POST | `/forgot-password` | |
| POST | `/reset-password` | |
| POST | `/logout-all` | JWT |
| POST/GET/DELETE | `/tokens` … | PAT management; JWT only |

### Sessions (`/api/v1/sessions`)

| Method | Path |
|--------|------|
| GET, POST | `/` |
| GET, DELETE | `/:id` |
| GET | `/:id/status` |
| POST | `/:id/connect`, `/:id/disconnect`, `/:id/logout` |
| POST, DELETE | `/:id/keys`, `/:id/keys/:keyId` |
| PUT, GET, DELETE | `/:id/webhook` |
| POST | `/:id/webhook/test` |

### Messaging

| Method | Path |
|--------|------|
| POST | `/api/v1/send-message` (`Idempotency-Key` required) |
| GET | `/api/v1/messages` |

### Internal

- Admin routes under internal Fastify app bound to **loopback** (`INTERNAL_PORT`, default 3001), guarded by `ADMIN_API_SECRET`.

---

## 7. Database

**Migrations** (`packages/db/drizzle/`):

| Tag | Purpose |
|-----|---------|
| `0000_phase1` | Core accounts/sessions/auth-state/message_logs |
| `0001_phase1_fixes` | Phase 1 review schema fixes |
| `0002_phase2` | Users, tokens, webhooks, outbound, idempotency, etc. |
| `0003_phase2_review` | Review follow-ups |
| `0004_outbound_sending` | `outbound_messages.status` includes `sending` |

**Tables (Drizzle):**  
`accounts`, `users`, `sessions`, `wa_auth_creds`, `wa_auth_keys`, `message_logs`, `email_verification_tokens`, `password_reset_tokens`, `refresh_tokens`, `login_attempts`, `security_audit_log`, `personal_access_tokens`, `session_api_keys`, `idempotency_keys`, `outbound_messages`, `webhook_endpoints`, `webhook_deliveries`, `webhook_outbox`.

---

## 8. Automated test report

### 8.1 Command and environment

```bash
# Docker Desktop running; from repo root:
pnpm docker:up
pnpm db:migrate
CI=true DATABASE_URL=postgresql://waapi:waapi@localhost:5432/waapi \
  REDIS_URL=redis://localhost:6379 pnpm test
```

**CI workflow:** `.github/workflows/ci.yml` — Postgres 16 + Redis 7 service containers, `pnpm lint`, `typecheck`, `db:migrate`, `pnpm test`.

**Report run:** 2026-10-20, local Windows, Docker engine 29.9.1, `CI=true`, real services.

### 8.2 Totals

| Metric | Count |
|--------|------:|
| Test files | **18** |
| Tests total | **85** |
| Passed | **85** |
| Failed | **0** |
| Skipped / pending | **0** |
| Todo | **0** |
| Success | **true** |

Stability: also green on 3 consecutive `CI=true` runs after refresh-deadlock fix (same totals).

### 8.3 By file

| File | Passed | Focus |
|------|-------:|-------|
| `apps/api/src/config.test.ts` | 6 | Prod guards, placeholders, docs flag |
| `apps/api/src/lib/client-ip.test.ts` | 3 | CF IP trust + rate-limit bucket isolation |
| `apps/api/src/security-helpers.test.ts` | 20 | SSRF, HMAC, phone normalize, CF forge |
| `apps/api/src/phase-2.integration.test.ts` | 11 | Full API: auth, tenant 404s, PAT vs JWT, caps, idempotency, enqueue rollback |
| `apps/worker/src/crypto/aes.test.ts` | 3 | AES-GCM + AAD |
| `apps/worker/src/crypto/key-ring.test.ts` | 1 | Versioned decrypt |
| `apps/worker/src/logger.test.ts` | 2 | No message bodies in logs |
| `apps/worker/src/baileys/auth-state.test.ts` | 3 | Encrypt shape, closed/flush races |
| `apps/worker/src/baileys/logout-path.test.ts` | 1 | 401 → logged_out only |
| `apps/worker/src/db/caps.test.ts` | 3 | Account/node caps + concurrent FOR UPDATE |
| `apps/worker/src/db/sessions.test.ts` | 3 | logged_out terminal, boot load set, wipe |
| `apps/worker/src/db/tenant-isolation.test.ts` | 1 | Cross-account session read denied |
| `apps/worker/src/jobs/send-text.claim.test.ts` | 3 | queued/sent/sending claim |
| `apps/worker/src/redis/lease.test.ts` | 7 | Lease NX/reclaim/renew/release (+ real Redis) |
| `apps/worker/src/redis/node-lock.test.ts` | 3 | Node lock (+ real Redis) |
| `apps/worker/src/session/disconnect-reason.test.ts` | 9 | DisconnectReason mapping |
| `apps/worker/src/session/manager.test.ts` | 5 | Flush/wipe/serialize/lease held/dispose |
| `apps/worker/src/session/reconnect.test.ts` | 1 | Backoff bounds |

### 8.4 Full case list (status = passed)

#### `apps/api/src/config.test.ts`
- production config guards refuses DEV_RETURN_TOKENS in production
- production config guards refuses ALLOW_HTTP_WEBHOOKS in production
- production config guards refuses ENABLE_DOCS without ALLOW_DOCS_IN_PROD
- production config guards allows ENABLE_DOCS with ALLOW_DOCS_IN_PROD
- production config guards rejects placeholder JWT_SECRET in production
- production config guards rejects WEBHOOK_SECRET_KEY that is not 32 bytes

#### `apps/api/src/phase-2.integration.test.ts`
- never returns verificationToken when DEV_RETURN_TOKENS is false
- never returns verificationToken when NODE_ENV is production
- registers, rotates refresh, revokes family on reuse, logout-all
- allows exactly one success for concurrent refresh of the same token
- hides account A resources from account B with exactly 404
- fails if any account-scoped route is missing from the covered list
- enforces session-key scoping
- PAT cannot manage tokens; JWT can
- allows exactly two of six concurrent session creates at a cap of two
- 20 concurrent sends with one Idempotency-Key produce one outbound row
- createSession deletes row when enqueue fails

#### `apps/api/src/security-helpers.test.ts`
- SSRF rejects: `127.0.0.1`, `[::1]`, IPv4-mapped, decimal IP, hex IP, CGNAT, link-local metadata IP
- SSRF rejects DNS→private, multi-A rebinding stub, userinfo / non-https without allow flag
- `isBlockedAddress` reserved ranges; pinned agent validates before connect
- `assertPublicUrl` rejects loopback with http allowed
- HMAC signs and verifies exact signature only
- Phone: E.164 + JID ok; rejects garbage / short / empty / `++…`
- Rate-limit client IP ignores forged CF header when `TRUST_CLOUDFLARE=false`

#### `apps/api/src/lib/client-ip.test.ts`
- ignores forged CF-Connecting-IP and X-Forwarded-For when TRUST_CLOUDFLARE=false
- uses CF-Connecting-IP only when TRUST_CLOUDFLARE=true
- auth rate-limit buckets uses distinct keys per route

#### Worker suite (summarized titles)
- Logger safe payload allow/reject body keys  
- Auth-state encrypt/AAD; closed+wipe race; flush awaits saveCreds  
- Logout path 401 → logged_out only  
- AES round-trip / AAD mismatch / key encodings  
- Key ring versioned decrypt  
- Caps: max_sessions, node cap, Promise.all concurrency  
- Sessions: never overwrite logged_out; boot load excludes error/logged_out; wipe atomic  
- Tenant isolation cross-account  
- claimOutboundForSend: claim / skip sent / busy sending  
- Leases: NX, reclaim, CAD release, renew loss, Redis blips, releaseAll, real Redis reclaim  
- NodeLock: exclusive, stale TTL, real Redis  
- DisconnectReason pin + maps (401/515/440/403/500/411/backoff) + open-error helpers  
- SessionManager: flush before lease release; close before wipe; ordered status writes; SESSION_LEASE_HELD reconnect; disposeClient on open failure  
- nextBackoffMs within exponential cap  

---

## 9. Live verification (manual, 2026-10-20)

Environment: Docker Postgres/Redis healthy; `pnpm dev:api`, `dev:worker`, `dev:webhooks`; dashboard at `http://127.0.0.1:5173`.

| Step | Result |
|------|--------|
| `GET /health` | `{"status":"ok"}` |
| Register + verify + login | 201 / 204 / 200 |
| Create session | `need_scan` → worker QR |
| Scan / link | Session **connected**, phone `923294380247` |
| `POST /send-message` to `+923328421247` text `hi this is bot message` | HTTP **202** → DB `outbound_messages.status=sent`; row visible in `GET /messages` |
| Local `033…` without country code | Rejected (`INVALID_PHONE`); must use E.164 |

**Demo account used:** `live-1907371620@example.com` (local only; not for production).

---

## 10. Docker / ops current state

| Component | State |
|-----------|--------|
| Docker Desktop | Installed (winget failed; silent installer OK); engine 29.9.1 |
| `docker compose up` | `postgres:16-alpine`, `redis:7-alpine` healthy on 5432/6379 |
| Prod profile services | Defined (migrate/api/webhooks/worker); not required for local Phase 2 demo |
| Hostinger / domain / Cloudflare production | **Not deployed** |

---

## 11. Explicit gaps / not claiming done

Be precise for supervisor scoring:

1. **Phase 3 dashboard** (shadcn, Turnstile, httpOnly cookies, SSE/WS QR, delivery log UI, API quickstart, dark mode, ban-risk notice) — **not built**. Current UI is a thin local connect page.
2. **Customer inbound webhook E2E** with a public HTTPS URL — infrastructure exists; full curl-to-signed-delivery acceptance against a public catcher should be re-run on a deployed host (localhost SSRF blocks private callbacks by design).
3. **Media / groups / channels / contacts / location** — Phase 4.
4. **Billing** — Phase 5.
5. **Full admin panel, monitoring, backups, load test** — Phase 6.
6. **SDKs / n8n / public docs site** — Phase 7.
7. **Legal / payment-provider launch gate** — owner / business, not code-complete.
8. **Phase 2 git commit/push** — working tree still dirty; CI on GitHub not proven green from this machine’s `gh` push in this session.
9. **README** still partially Phase-1-worded; runbook has Phase 2 curl section — docs drift exists.
10. **Email** driver is `console` only (no SMTP provider yet).

---

## 12. Roadmap remaining (from SUPERVISOR.md)

| Phase | Scope | Status |
|------|--------|--------|
| 1 | Scaffold + session engine | Done |
| 2 | Accounts, API, webhooks | Done (pending commit) |
| 3 | React dashboard (Vite + Tailwind + shadcn/ui) | Next |
| 4 | Media + minimal admin/support | Pending |
| 5 | Billing (session-count plans) | Pending |
| 6 | Hardening / ops / full admin | Pending |
| 7 | Growth (docs, SDKs, n8n, MCP, …) | Pending |

**Launch gate (do not take money until):** Terms/Privacy/AUP, payment provider approval, backups+restore test, minimal admin+2FA, monitoring/disconnect alerts, measured session caps, Cloudflare WAF/Turnstile, pen-style self-review, support/status/refund policy, load test.

---

## 13. How supervisor should review

1. Read this document for scope and claims.  
2. Optionally open `review-phase2.txt` for concatenated sources.  
3. Prefer reading live tree on `phase-2-api` working copy for newest fixes (refresh deadlock, webhook DELETE tenant check, dashboard demo).  
4. Reproduce tests with §8.1 (`CI=true` + Docker).  
5. Score Phase 2 against SUPERVISOR Prompt 2 acceptance:  
   - curl signup → session → send  
   - tenant isolation  
   - concurrent caps + idempotency  
   - SSRF / signature helpers  
   - Do **not** require Phase 3 UI polish for Phase 2 pass  

---

## 14. Key file index (Phase 2 / round 2)

```
apps/api/src/app.ts
apps/api/src/config.ts
apps/api/src/config.test.ts
apps/api/src/lib/client-ip.ts
apps/api/src/lib/client-ip.test.ts
apps/api/src/lib/auth-rate-limit.ts
apps/api/src/lib/crypto.ts
apps/api/src/lib/phone.ts
apps/api/src/plugins/{auth,error-handler,rate-limit,request-id}.ts
apps/api/src/routes/v1/{auth,sessions,send,messages,webhooks,health}.ts
apps/api/src/routes/internal/admin.ts
apps/api/src/services/{auth,send,sessions,tokens,queues,email}.ts
apps/api/src/services/webhooks/{index,sign,ssrf}.ts
apps/api/src/workers/{outbox-poller,webhook-delivery}.ts
apps/api/src/phase-2.integration.test.ts
apps/api/src/security-helpers.test.ts
apps/api/Dockerfile
apps/worker/src/jobs/send-text.ts
apps/worker/src/jobs/send-text.claim.test.ts
apps/worker/src/jobs/session-commands.ts
apps/worker/src/db/sessions.ts
apps/worker/Dockerfile
packages/db/** (schema, migrate, drizzle 0000–0004)
packages/shared/src/schemas/{api,auth,commands,events}.ts
deploy/nginx.conf
docker-compose.yml
.env.example
vitest.setup.ts
vitest.config.ts
.github/workflows/ci.yml
docs/runbook.md
docs/supervisor-review-phase2-complete.md  ← this file
review-phase2.txt
apps/dashboard/**  ← temporary connect UI only
```

---

## 15. One-line status for supervisor header

> **Phase 1 complete; Phase 2 API complete with round-2 security/ops fixes; 85/85 tests green on real Postgres/Redis with CI=true; live QR + text send proven locally; Phase 3+ and production deploy remain.**

---

*End of report. Generated for supervisor paste/review. No secrets included.*
