#!/usr/bin/env bash
# Print memory context for session-start injection. Prints nothing on failure.
set -u
URL="${DISTILL_URL:-http://127.0.0.1:8787/context}"
project="${DISTILL_PROJECT:-}"
budget="${DISTILL_BUDGET:-1200}"
if [ -n "$project" ]; then
  query="project=${project}&budget=${budget}"
else
  # derive project from cwd basename
  base="$(basename "$PWD")"
  query="project=${base}&budget=${budget}"
fi
curl -s --max-time 2 "${URL}?${query}" 2>/dev/null || true
exit 0