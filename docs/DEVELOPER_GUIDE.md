# wapidapi / waapi — Developer Guide

Complete orientation for engineers (and future AI chats). Brand display name is env-driven (`BRAND_NAME`); product domain for production is **wapidapi.tech**.

**Repo:** https://github.com/SyedIsmail-47/waapi  
**Default branch:** `main` (Phase 4 closed-beta complete)  
**Companion docs:** [runbook.md](./runbook.md) · [reports/](./reports/) · [design/billing.md](./design/billing.md)

---

## 1. What this system is

Multi-tenant **unofficial** WhatsApp HTTP API:

- Customers manage sessions (QR / Baileys), send text, receive webhook deliveries.
- Dashboard SPA + public marketing site + internal admin CLI.
- Billing: **manual** (trial/admin) or **Paddle** (optional; not required for closed beta).

**Not affiliated with WhatsApp/Meta.** Ban risk is real; disclosed on the site.

---

## 2. Monorepo map

```
waapi/
├── apps/
│   ├── api/          # Fastify public :3000 + internal admin :3001
│   ├── worker/       # Baileys or fake driver, send jobs, QR
│   ├── dashboard/    # React/Vite SPA (operator UI)
│   └── site/         # Static marketing + legal (Cloudflare Pages)
├── packages/
│   ├── db/           # Drizzle schema + migrations 0000–0011
│   └── shared/       # Zod, plans, errors, brand
├── deploy/           # nginx Origin CA edge config
├── docs/             # This guide, runbook, reports
├── scripts/          # admin, preflight, backup, ram-probe, CLI
└── .github/workflows/ci.yml   # build + gitleaks + e2e
```

| Package | Role |
|---------|------|
| `@waapi/api` | Auth (JWT/PAT/session key), sessions, send, webhooks, billing, admin |
| `@waapi/worker` | Session lifecycle, QR, outbound send, disconnect alerts |
| `@waapi/dashboard` | Signup/login, sessions, billing UI, settings |
| `@waapi/site` | Pricing/legal/docs static pages |
| `@waapi/db` | Postgres schema |
| `@waapi/shared` | Shared types/plans/error codes |

---

## 3. Architecture (runtime)

```
Browser → Cloudflare → nginx (TLS Origin CA)
              ├─ /api,/health → API :3000 (loopback)
              └─ /            → dashboard :8080 (loopback)
API ↔ Postgres + Redis
API → BullMQ → Worker (Baileys sockets)
API → webhook outbox → signed HTTPS deliveries
Internal admin :3001 (NOT on public nginx; x-admin-secret)
```

Compose prod profile binds API/dashboard to **127.0.0.1** only; nginx is the public edge.

---

## 4. Local development

**Need:** Node 22+, pnpm 9.15, Docker Desktop.

```bash
git clone https://github.com/SyedIsmail-47/waapi.git
cd waapi
cp .env.example .env
# fill 32-byte keys (see comments in .env.example)
pnpm install
pnpm docker:up          # Postgres + Redis (dev ports)
pnpm db:migrate
pnpm seed
pnpm dev:api            # :3000
pnpm dev:worker
pnpm dev:dashboard      # :5173 proxies /api
```

Smoke-shaped stack:

```bash
pnpm docker:up:prod     # profile prod — dashboard http://127.0.0.1:8080
```

### Useful scripts

| Command | Purpose |
|---------|---------|
| `pnpm test` / `CI=true pnpm test` | Vitest (API/worker/scripts) |
| `pnpm lint` / `pnpm typecheck` | Quality gates |
| `pnpm preflight` | Production env gate (no secret echo) |
| `pnpm admin -- …` | Internal admin CLI |
| `pnpm ram-probe` | In-memory RSS estimate (numbers in runbook) |
| `pnpm build:site` | Marketing site → `apps/site/dist` |

Playwright e2e: see runbook (smoke compose + `ADMIN_API_SECRET`).

---

## 5. Phase delivery status

| Phase | Content | Status |
|-------|---------|--------|
| 1 | Worker, encrypted auth state | Done |
| 2 | API auth, send, webhooks, rate limits | Done |
| 3 | Dashboard, cookies/CSRF, Turnstile | Done |
| 4 Tier-1 | Fake driver, invites, email/account/session UX, billing, admin, site, go-live, security, reliability (WP A–G, J, L, M, N) | **Done on `main`** |
| 4 Tier-2 | WP-H media/groups, WP-I webhook parity | Not started |
| 5 | `phase-5-parity` branch exists | Empty / future |

PR #4 (`phase-4` → `main`) is **merged**.

---

## 6. Core product flows

### Auth & tenancy
- Register (invite gate + terms), verify email, login, refresh cookie + CSRF.
- PATs and per-session API keys; all data scoped by `account_id`.

### Sessions
- Create → connect → QR → connected; disconnect / logout / delete / rename.
- `PHONE_IN_USE` when phone already bound; disconnect email alerts (opt-out).

### Send
- Text send + idempotency; plan send limits + warm-up → `429 SESSION_SEND_LIMIT`.

### Webhooks
- Customer HTTPS endpoints; SSRF checks; HMAC signatures; encrypted outbox.

### Billing
- Default `BILLING_PROVIDER=manual`, trial days.
- Expired → `402 BILLING_EXPIRED` on create/send; billing GET + delete-account always allowed.
- Paddle: raw-body signature, price allowlist, customer bind, manual-review for refunds/pauses (see runbook checklist).

### Admin
- `INTERNAL_PORT` + `ADMIN_API_SECRET`: find user, suspend, plan, invites, force-logout, manual-review.
- Never expose `:3001` on the public internet.

---

## 7. Database migrations

Sequential under `packages/db/drizzle/`:

| Migration | Topic |
|-----------|--------|
| 0000–0007 | Core sessions/auth/webhooks/outbox |
| 0008 | Invite codes |
| 0009 | Billing |
| 0010 | Terms acceptance |
| 0011 | Manual review, disconnect alerts, send counters |

Never rewrite applied SQL; only add new numbers.

---

## 8. Testing & CI

- **Vitest:** ~306 passed / 2 skipped (backup age tools optional).
- **Playwright:** smoke + fake driver job in CI.
- **Jobs:** `gitleaks`, `build`, `e2e (smoke + playwright)`.
- **Required check** on `main`: e2e (when branch protection enforced).

Skipped tests: `scripts/backup-restore.test.ts` needs `age`/`gzip` (and optional live DB).

---

## 9. Production deploy process (Hostinger + Cloudflare)

High level (details: private ops pack on maintainer machine + [runbook.md](./runbook.md)):

1. **Rotate** any secrets that were ever pasted into chat.
2. Cloudflare DNS: `app` → VPS IP, proxied; SSL Full (strict); Origin CA cert.
3. VPS: Docker, clone repo to `/opt/waapi`, fill `.env` **on the server only**.
4. Install nginx from `deploy/nginx.conf` with `server_name app.wapidapi.tech` + Origin CA paths.
5. `docker compose --profile prod up -d --build`.
6. Verify `https://app…/health` and dashboard; mint invites via admin.
7. Email: `EMAIL_DRIVER=resend` + verified `EMAIL_FROM`.
8. Turnstile: production keys; `TURNSTILE_DISABLED=false`.
9. Backups: `scripts/backup-pg.sh` with age + rclone (private keys off-server).
10. Paddle: optional later (`BILLING_PROVIDER=paddle` + keys).

**Same VPS as Leadgensystem:** share carefully — only one process should own 80/443 unless you route by hostname.

---

## 10. Environment cheat sheet

Critical production vars (see `.env.example` for full list):

| Area | Keys |
|------|------|
| Brand / URL | `BRAND_NAME`, `PUBLIC_APP_URL` |
| Crypto | `JWT_SECRET`, `WEBHOOK_SECRET_KEY`, `AUTH_STATE_ENCRYPTION_KEY`, `PAYLOAD_ENCRYPTION_KEY` |
| Admin | `ADMIN_API_SECRET` |
| Data | `POSTGRES_*`, `REDIS_PASSWORD`, compose URLs |
| Email | `EMAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` |
| Bot protect | `TURNSTILE_SECRET_KEY`, `VITE_TURNSTILE_SITE_KEY` |
| Edge | `TRUST_CLOUDFLARE=true`, `COOKIE_SECURE=true` |
| Caps | `GLOBAL_MAX_SESSIONS`, `DEFAULT_ACCOUNT_MAX_SESSIONS` |
| Billing | `BILLING_PROVIDER`, optional `PADDLE_*` |

`EMAIL_DRIVER=console` and placeholder keys are **refused** in production boot / preflight.

---

## 11. Security rules (non-negotiable)

- Never commit `.env`, review packs, or live keys.
- Never log message bodies, tokens, or auth state.
- Public nginx must 404 `/internal` and `/metrics`.
- Gitleaks runs in CI; do not weaken allowlists for real secrets.

Private maintainer materials (security triage, Claude handoff, review packs, Hostinger notes) live **outside** this git repo in a local `waapi-private-ops/` folder.

---

## 12. Where to read next

1. This guide (you are here)
2. [runbook.md](./runbook.md) — ops, acceptance, Paddle checklist, RAM table
3. [reports/waapi-project-report.pdf](./reports/waapi-project-report.pdf) — status / WP table
4. [reports/waapi-source-code-documentation.pdf](./reports/waapi-source-code-documentation.pdf) — module tree
5. [design/billing.md](./design/billing.md)
6. Code entry: `apps/api/src/app.ts` → `routes/v1/*` → `apps/worker/src/session/manager.ts`

---

## 13. Continuing in a new AI chat (free tier)

Paste something like:

> Continue wapidapi. Repo `SyedIsmail-47/waapi` on `main`. Read `docs/DEVELOPER_GUIDE.md` and `docs/runbook.md`. Deploy target: Hostinger + `app.wapidapi.tech`. Do not ask me to paste secrets.

That restores context without replaying this entire thread.
