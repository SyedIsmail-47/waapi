#!/usr/bin/env bash
# Encrypted Postgres backup: pg_dump → gzip → age (public-key) → sha256 → rclone.
# Private age identity NEVER lives on the backup server — only AGE_RECIPIENTS.
# Never prints DATABASE_URL or keys.
#
# Usage:
#   AGE_RECIPIENTS=age1... BACKUP_RCLONE_REMOTE=b2:waapi-backups \
#     ./scripts/backup-pg.sh
#   ./scripts/backup-pg.sh --input fixture.sql --output out.sql.gz.age \
#     --recipient-file recipients.txt --skip-pg-dump --skip-rclone
set -euo pipefail

DEST="${BACKUP_DEST:-}"
INPUT=""
OUTPUT=""
RECIPIENT_FILE="${AGE_RECIPIENTS_FILE:-}"
RECIPIENTS="${AGE_RECIPIENTS:-}"
SKIP_PG_DUMP=0
SKIP_RCLONE=0
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input) INPUT="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --recipient-file) RECIPIENT_FILE="$2"; shift 2 ;;
    --skip-pg-dump) SKIP_PG_DUMP=1; shift ;;
    --skip-rclone) SKIP_RCLONE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$RECIPIENTS" && -n "$RECIPIENT_FILE" ]]; then
  RECIPIENTS="$(grep -v '^#' "$RECIPIENT_FILE" | grep -v '^$' | tr '\n' ' ')"
fi
if [[ -z "$RECIPIENTS" ]]; then
  echo "AGE_RECIPIENTS or --recipient-file required (public keys only)" >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -z "$OUTPUT" ]]; then
  if [[ -z "$DEST" ]]; then
    echo "BACKUP_DEST or --output required" >&2
    exit 1
  fi
  mkdir -p "$DEST"
  OUTPUT="${DEST}/waapi-${stamp}.sql.gz.age"
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
plain="${tmpdir}/dump.sql"

if [[ "$SKIP_PG_DUMP" -eq 1 ]]; then
  [[ -n "$INPUT" ]] || { echo "--input required with --skip-pg-dump" >&2; exit 1; }
  cp "$INPUT" "$plain"
else
  [[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL required" >&2; exit 1; }
  pg_dump --no-owner --format=plain --file="$plain" "$DATABASE_URL"
fi

# shellcheck disable=SC2086
gzip -c "$plain" | age -r $RECIPIENTS -o "$OUTPUT"
checksum="${OUTPUT}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUTPUT" > "$checksum"
else
  shasum -a 256 "$OUTPUT" > "$checksum"
fi

echo "wrote age-encrypted backup (+ sha256)"

if [[ "$SKIP_RCLONE" -eq 0 ]]; then
  if [[ -z "$RCLONE_REMOTE" ]]; then
    echo "BACKUP_RCLONE_REMOTE unset — skipping upload (local file kept)" >&2
  else
    # Write-only credentials recommended on the backup host.
    rclone copy "$OUTPUT" "$RCLONE_REMOTE/" --checksum
    rclone copy "$checksum" "$RCLONE_REMOTE/" --checksum
    echo "uploaded via rclone"
  fi
fi
