# Phase 3 summary

## Built

- Branch `phase-3-dashboard` from `phase-2-final`
- React dashboard (`apps/dashboard`): Vite, Tailwind, shadcn-style Radix UI, TanStack Query, React Router
- Pages: signup/login (Turnstile), verify email, forgot/reset password, sessions list, session detail (QR modal + 2.5s status poll, ban-risk notice, session keys, webhook + test + delivery log), messages, settings, PATs
- Access token in memory (+ BroadcastChannel); refresh httpOnly cookie; CSRF double-submit; no auth secrets in localStorage
- API: `@fastify/cookie`, login/refresh cookies, `POST /auth/logout`, `GET /auth/me`, Turnstile verify, ~10s Redis refresh-reuse grace, `GET .../keys`, `GET .../webhook/deliveries`
- Dashboard Docker image + nginx same-origin proxy; compose `dashboard` service; edge `deploy/nginx.conf` updated
- Component Vitest tests; Playwright smoke e2e spec; CI runs dashboard unit tests

## Skipped / not built

- Billing, admin UI, media
- SSE/WebSockets for session status
- OAuth / multi-member invites
- Opening CORS for a separate dashboard origin
- Playwright job in CI (documented as local against smoke stack)

## Known risks

- Unofficial WhatsApp ban risk (surfaced in connect UI)
- Refresh grace stores successor plaintext in Redis for 10s (keyed by old hash)
- `SMOKE_MODE` relaxes Turnstile / cookie Secure / DEV_RETURN_TOKENS under `NODE_ENV=production` — must never be set on a customer host
- Production requires `TURNSTILE_SECRET_KEY` and dashboard rebuild with `VITE_TURNSTILE_SITE_KEY`
