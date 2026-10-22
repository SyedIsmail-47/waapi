# Monorepo

Commercial multi-tenant WhatsApp API SaaS (unofficial, Baileys-based). Brand name is driven by `BRAND_NAME` (see `.env.example` and `@waapi/shared`).

## Stack

- `apps/api` — Fastify `/api/v1` (auth, sessions, send, webhooks)
- `apps/worker` — Baileys session manager
- `apps/dashboard` — React + Vite + Tailwind + shadcn (Phase 3)
- `packages/shared` — types, zod schemas, brand helper
- Postgres + Redis via Docker Compose

## Prerequisites

- Node.js 22+
- pnpm 9.15
- Docker Desktop (Windows)

## Quick start

```bash
cp .env.example .env
# set secrets from .env.example comments
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm seed
pnpm dev:api          # terminal 1
pnpm dev:worker       # terminal 2
pnpm dev:dashboard    # terminal 3 — http://127.0.0.1:5173 (proxies /api)
```

Production-shaped stack (API + worker + dashboard nginx same-origin):

```bash
pnpm docker:up:prod
# dashboard: http://127.0.0.1:8080  (proxies /api to api:3000)
```

## Scripts

All scripts are cross-platform (`tsx` / `node`). No bash-only package scripts.

Dashboard component tests: `pnpm --filter @waapi/dashboard test`  
Playwright e2e (smoke stack): see [docs/runbook.md](docs/runbook.md).

## Status

Phases 1–2 (worker + API) and Phase 3 (dashboard) are implemented. Billing/admin/media are out of scope.

See [docs/runbook.md](docs/runbook.md) for ops, smoke, and acceptance checks.

## Deploy notes

Target: Hostinger VPS behind Cloudflare. Edge nginx ([deploy/nginx.conf](deploy/nginx.conf)) terminates TLS and routes `/api` + `/health` to the API and `/` to the dashboard container so the browser stays same-origin (CORS closed).

