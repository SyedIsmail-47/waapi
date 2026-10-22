#!/usr/bin/env bash
# Probe smoke/public nginx for WP-M(b) headers and hard blocks.
# Usage: BASE_URL=http://127.0.0.1:8080 ./scripts/nginx-security-curl.sh
set -euo pipefail
BASE="${BASE_URL:-http://127.0.0.1:8080}"

echo "== headers =="
hdrs="$(curl -sSI "$BASE/" || true)"
echo "$hdrs" | grep -qi 'x-content-type-options:.*nosniff' || { echo "missing nosniff"; exit 1; }
echo "$hdrs" | grep -qi 'content-security-policy:.*challenges.cloudflare.com' || { echo "missing CSP Turnstile"; exit 1; }
echo "$hdrs" | grep -qi 'referrer-policy:' || { echo "missing referrer-policy"; exit 1; }

echo "== block /internal =="
code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/internal/admin/users" || true)"
[[ "$code" == "404" || "$code" == "403" ]] || { echo "/internal exposed: $code"; exit 1; }

echo "== block /metrics =="
code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/metrics" || true)"
[[ "$code" == "404" || "$code" == "403" ]] || { echo "/metrics exposed: $code"; exit 1; }

echo "nginx-security-curl ok"
