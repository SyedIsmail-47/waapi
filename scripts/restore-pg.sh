#!/usr/bin/env bash
# Decrypt an off-box encrypted pg_dump and optionally restore.
# Never prints DATABASE_URL or the passphrase.
#
# Usage:
#   BACKUP_PASSPHRASE_FILE=/root/.waapi-backup-pass \
#     ./scripts/restore-pg.sh --input /mnt/offbox/waapi-....sql.gz.enc
#   ./scripts/restore-pg.sh --input enc --output out.sql --passphrase 'x' --skip-psql
set -euo pipefail

PASSPHRASE="${BACKUP_PASSPHRASE:-}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
INPUT=""
OUTPUT=""
SKIP_PSQL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --skip-psql) SKIP_PSQL=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$INPUT" ]]; then
  echo "--input required" >&2
  exit 1
fi
if [[ -z "$PASSPHRASE" && -n "$PASSPHRASE_FILE" ]]; then
  PASSPHRASE="$(cat "$PASSPHRASE_FILE")"
fi
if [[ -z "$PASSPHRASE" ]]; then
  echo "BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE required" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
plain="${OUTPUT:-$tmpdir/restored.sql}"

openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"$PASSPHRASE" -in "$INPUT" | gzip -dc > "$plain"

if [[ "$SKIP_PSQL" -eq 1 ]]; then
  echo "decrypted dump written (skip-psql)"
  exit 0
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL required to restore (or pass --skip-psql)" >&2
  exit 1
fi

echo "Restoring into DATABASE_URL (URL not printed). Confirm the target is empty/staging."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$plain"
echo "restore complete"
