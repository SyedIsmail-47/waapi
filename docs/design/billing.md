# Billing design (WP-F)

Closed-beta billing: plans, subscriptions, trials, enforcement, and a pluggable provider. **No card data is stored** — Paddle (or manual ops) is merchant of record for payments.

## Plans (shared config)

| code | max_sessions | sends_per_day | notes |
|------|--------------|---------------|-------|
| `trial` | 1 | 50 | Default on signup when `TRIAL_DAYS` > 0 |
| `starter` | 1 | 500 | Paid |
| `pro` | 5 | 5000 | Paid |
| `enterprise` | custom | custom | Manual / contact support |

Shared module: `packages/shared/src/plans.ts` — also drives `/pricing` on the public site.

## Env

- `TRIAL_DAYS` (default `3`) — trial length from account creation
- `BILLING_PROVIDER` = `manual` | `paddle` (default `manual`)
- Paddle sandbox: `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV=sandbox`, price IDs per plan

## Subscription states

`trialing` → `active` → `past_due` → `canceled` | `expired`

| state | meaning |
|-------|---------|
| `trialing` | Within trial window; 1 session |
| `active` | Paid / manually set plan in good standing |
| `past_due` | Payment failed; **grace period** (`BILLING_GRACE_DAYS`, default 3) still allows current sessions |
| `canceled` | User/ops canceled; access until period end then `expired` |
| `expired` | No access; create/send return **402** with code `BILLING_EXPIRED` |

Grace: when entering `past_due`, set `grace_until`. After grace, extra sessions beyond plan `max_sessions` are **disconnected** by a sweeper; create/send blocked with 402.

## Schema (additive)

- `plans` — optional DB mirror; runtime may use shared constants
- `subscriptions` — `account_id` unique, `plan_code`, `status`, `trial_ends_at`, `current_period_end`, `grace_until`, `provider`, `provider_customer_id`, `provider_subscription_id`
- `billing_events` — idempotent provider webhook ledger (`provider`, `event_id` unique, `payload_hash`, `processed_at`)

Accounts already have `plan_code` / `max_sessions` — keep them as **enforcement cache** updated when subscription changes.

## BillingProvider

```ts
interface BillingProvider {
  createCheckout(input: { accountId; planCode; successUrl; cancelUrl }): Promise<{ url: string }>;
  verifyWebhook(headers, rawBody): Promise<BillingEvent>;
  handleEvent(event): Promise<void>; // idempotent
}
```

- `manual`: checkout returns null / dashboard shows “contact support to upgrade”; admin CLI sets plan
- `paddle`: server-created checkout (sandbox), verified webhooks, replay-safe via `billing_events`

## Enforcement points

- `POST /sessions` — if expired → 402 `BILLING_EXPIRED`; if at cap → existing `ACCOUNT_SESSION_CAP`
- `POST /send-message` — if expired → 402 `BILLING_EXPIRED`
- Sweeper: sessions over `max_sessions` after grace → enqueue disconnect

## Dashboard

`/settings/billing` (or `/billing`): current plan, status, trial end, upgrade CTA (Paddle checkout or contact support). Never collect cards in-app.

## Tests

- Table-driven state machine transitions
- Webhook replay / idempotency
- 402 on create/send when expired
- Tenant isolation on billing routes
