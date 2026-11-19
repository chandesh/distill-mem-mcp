#!/usr/bin/env bash
# Capture a Claude Code hook event and POST it to distill-mem-mcp /ingest.
# Always exits 0; fails silently if the server is down.
set -u
URL="${DISTILL_URL:-http://127.0.0.1:8787/ingest}"
payload="$(cat)"
printf '%s' "$payload" | curl -s --max-time 2 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  --data-binary @- >/dev/null 2>&1 || true
exit 0