#!/usr/bin/env bash
# Encrypted Postgres backup for off-box storage.
# Never prints DATABASE_URL or the passphrase.
#
# Usage:
#   BACKUP_DEST=/mnt/offbox/waapi BACKUP_PASSPHRASE_FILE=/root/.waapi-backup-pass \
#     ./scripts/backup-pg.sh
#   ./scripts/backup-pg.sh --input fixture.sql --output out.sql.gz.enc --passphrase 'x' --skip-pg-dump
set -euo pipefail

DEST="${BACKUP_DEST:-}"
PASSPHRASE="${BACKUP_PASSPHRASE:-}"
PASSPHRASE_FILE="${BACKUP_PASSPHRASE_FILE:-}"
INPUT=""
OUTPUT=""
SKIP_PG_DUMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --passphrase) PASSPHRASE="$2"; shift 2 ;;
    --skip-pg-dump) SKIP_PG_DUMP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PASSPHRASE" && -n "$PASSPHRASE_FILE" ]]; then
  PASSPHRASE="$(cat "$PASSPHRASE_FILE")"
fi
if [[ -z "$PASSPHRASE" ]]; then
  echo "BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE required" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$OUTPUT" ]]; then
  if [[ -z "$DEST" ]]; then
    echo "BACKUP_DEST (off-box directory) or --output required" >&2
    exit 1
  fi
  mkdir -p "$DEST"
  OUTPUT="${DEST}/waapi-${stamp}.sql.gz.enc"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
plain="${tmpdir}/dump.sql"

if [[ "$SKIP_PG_DUMP" -eq 1 ]]; then
  if [[ -z "$INPUT" ]]; then
    echo "--input required with --skip-pg-dump" >&2
    exit 1
  fi
  cp "$INPUT" "$plain"
else
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL required" >&2
    exit 1
  fi
  # pg_dump via URL; do not echo the URL
  pg_dump --no-owner --format=plain --file="$plain" "$DATABASE_URL"
fi

gzip -c "$plain" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass pass:"$PASSPHRASE" -out "$OUTPUT"
echo "wrote encrypted backup to off-box path: ${OUTPUT}"
