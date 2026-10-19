# Monorepo

Commercial multi-tenant WhatsApp API SaaS (unofficial, Baileys-based). Brand name is driven by `BRAND_NAME` (see `.env.example` and `@waapi/shared`).

## Stack

- `apps/api` — Fastify API (Phase 2; stub in Phase 1)
- `apps/worker` — Baileys session manager
- `apps/dashboard` — React + Vite + Tailwind (Phase 3; stub in Phase 1)
- `packages/shared` — types, zod schemas, brand helper
- Postgres + Redis via Docker Compose

## Prerequisites

- Node.js 20+
- pnpm 9.15
- Docker Desktop (Windows)

## Quick start

```bash
cp .env.example .env
# set AUTH_STATE_ENCRYPTION_KEY (32-byte base64)
pnpm install
pnpm docker:up
pnpm db:migrate
pnpm seed
pnpm dev:worker
```

CLI (after session engine is implemented):

```bash
pnpm cli -- create-session --name demo
pnpm cli -- send --session <id> --to 1234567890 --text hello
pnpm ram-probe
```

## Scripts

All scripts are cross-platform (`tsx` / `node`). No bash-only package scripts.

## Phase 1 status

Session engine is implemented in `apps/worker`. API and dashboard are stubs until later phases.

See [docs/runbook.md](docs/runbook.md) for acceptance checks, RAM probing, and the Phase 1 build summary.

## Deploy notes

Target: Hostinger VPS behind Cloudflare. Reverse proxy (Caddy/Nginx) is documented for later ops; local Phase 1 uses Compose for Postgres/Redis only.

