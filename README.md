# wapidapi (waapi monorepo)

Commercial multi-tenant WhatsApp HTTP API (unofficial, Baileys-based).  
Display brand is driven by `BRAND_NAME` (production brand: **wapidapi**).

**Status:** Phases 1–4 Tier-1 complete on [`main`](https://github.com/SyedIsmail-47/waapi).  
**Start here:** [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) — full system + process guide.

## Stack

| Path | Role |
|------|------|
| `apps/api` | Fastify `/api/v1` + internal admin |
| `apps/worker` | Baileys / fake session worker |
| `apps/dashboard` | React + Vite operator UI |
| `apps/site` | Static marketing + legal |
| `packages/db` | Drizzle + migrations |
| `packages/shared` | Zod, plans, brand, errors |

## Quick start (local)

```bash
cp .env.example .env   # fill secrets from comments
pnpm install
pnpm docker:up
pnpm db:migrate && pnpm seed
pnpm dev:api
pnpm dev:worker
pnpm dev:dashboard     # http://127.0.0.1:5173
```

Production-shaped compose: `pnpm docker:up:prod` → http://127.0.0.1:8080

## Documentation

| Doc | Purpose |
|-----|---------|
| [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) | **Complete developer / system guide** |
| [docs/runbook.md](docs/runbook.md) | Ops, smoke, admin, Paddle, RAM, acceptance |
| [docs/reports/waapi-project-report.pdf](docs/reports/waapi-project-report.pdf) | Project status report |
| [docs/reports/waapi-source-code-documentation.pdf](docs/reports/waapi-source-code-documentation.pdf) | Source map |
| [docs/design/billing.md](docs/design/billing.md) | Billing design |

## CI

GitHub Actions on push/PR: **gitleaks**, **build** (lint/typecheck/test), **e2e (smoke + playwright)**.

## Deploy

Target: Hostinger VPS behind Cloudflare (`app` subdomain). Edge: [deploy/nginx.conf](deploy/nginx.conf).  
Step-by-step process is in the developer guide §9 and the runbook. **Never commit `.env` or live secrets.**

## Disclaimer

Unofficial client. Not affiliated with WhatsApp or Meta. Account ban risk applies.
