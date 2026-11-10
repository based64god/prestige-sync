#!/usr/bin/env bash
# Cron entry point: single-instance lock, loads .env, appends to sync.log.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
NODE="${NODE:-$(command -v node || true)}"
[ -x "$NODE" ] || { echo "node not found; set NODE=/path/to/node in the crontab line" >&2; exit 1; }
exec flock -n .sync.lock "$NODE" --env-file-if-exists=.env sync.ts "$@" >>sync.log 2>&1
