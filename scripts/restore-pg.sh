#!/usr/bin/env bash
# Decrypt an age-encrypted backup (identity file — offline / restore host only).
# Never prints DATABASE_URL or the private key.
#
# Usage:
#   AGE_IDENTITY=/secure/age-identity.txt \
#     ./scripts/restore-pg.sh --input backup.sql.gz.age
#   ./scripts/restore-pg.sh --input enc --output out.sql --identity key.txt --skip-psql
set -euo pipefail

IDENTITY="${AGE_IDENTITY:-}"
INPUT=""
OUTPUT=""
SKIP_PSQL=0
VERIFY_SHA=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --skip-psql) SKIP_PSQL=1; shift ;;
    --skip-sha) VERIFY_SHA=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$INPUT" ]] || { echo "--input required" >&2; exit 1; }
[[ -n "$IDENTITY" ]] || { echo "AGE_IDENTITY or --identity required" >&2; exit 1; }

if [[ "$VERIFY_SHA" -eq 1 && -f "${INPUT}.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "${INPUT}.sha256"
  else
    expected="$(awk '{print $1}' "${INPUT}.sha256")"
    actual="$(shasum -a 256 "$INPUT" | awk '{print $1}')"
    [[ "$expected" == "$actual" ]] || { echo "sha256 mismatch" >&2; exit 1; }
  fi
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
plain="${OUTPUT:-$tmpdir/restored.sql}"

age -d -i "$IDENTITY" -o /dev/stdout "$INPUT" | gzip -dc > "$plain"

if [[ "$SKIP_PSQL" -eq 1 ]]; then
  echo "decrypted dump written (skip-psql)"
  exit 0
fi

[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL required (or --skip-psql)" >&2; exit 1; }
echo "Restoring into DATABASE_URL (URL not printed). Target should be empty/scratch."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$plain"
echo "restore complete"
