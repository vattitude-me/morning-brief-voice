#!/usr/bin/env bash
# The 5am run: bring the voice service up, voice the day's stories, log what happened.
#
#   scripts/nightly-pack.sh                # the run itself, exactly what launchd calls
#   scripts/nightly-pack.sh --dry-run      # everything except the render, for testing plumbing
#
# Installed as a LaunchAgent at 05:00 (see docs/nightly.md). Nothing here needs a terminal:
# it starts colima if it is down, waits for the voice model to load, then runs `python -m app pack`.
# Every run appends to ~/Library/Logs/morning-brief/pack-YYYY-MM-DD.log.
set -euo pipefail

# launchd starts a job with almost no PATH, and colima, docker, ffmpeg and ffprobe all live in
# Homebrew's bin. Without this the run fails on the first command.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# HOME is set for a user agent, but a bare `env -i` test has none, and the logs live under it.
export HOME="${HOME:-$(eval echo "~$(id -un)")}"

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG_DIR="$HOME/Library/Logs/morning-brief"
mkdir -p "$LOG_DIR"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# One file per day: a week away should leave a week of readable logs.
LOG="$LOG_DIR/pack-$(date +%Y-%m-%d).log"
exec >>"$LOG" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') nightly pack starting${DRY:+ (dry run)}"

if [ ! -x .venv/bin/python ]; then
  echo "✗ No .venv in $ROOT. Create it with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

# 1. The voice service is a container, and colima itself can be stopped. Both come back on their own.
if ! docker info >/dev/null 2>&1; then
  echo "→ starting colima"
  colima start --cpu 4 --memory 8 --disk 60 >>"$LOG" 2>&1 || { echo "✗ colima would not start"; exit 1; }
fi
echo "→ starting the voice service"
docker compose -f docker-compose.deploy.yml up -d voice

# 2. Loading the model takes a minute on CPU, so wait for it rather than racing it.
echo "→ waiting for the voice service"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS --max-time 5 http://localhost:8090/health 2>/dev/null | grep -q '"loaded":true'; then
    ready=1
    break
  fi
  sleep 5
done
if [ "$ready" != 1 ]; then
  echo "✗ The voice service did not become ready in 7 minutes"
  exit 1
fi
echo "→ voice service ready"

# 3. The render. Without --force every clip whose article has not changed is reused, so a re-run
#    of a day that is already published costs a minute rather than an hour.
set -a
# shellcheck disable=SC1091
source .env
set +a
export VOICE_SERVICE_URL="${VOICE_SERVICE_URL:-http://localhost:8090}"

if [ "$DRY" = 1 ]; then
  echo "✓ dry run: the voice service is up and .env loaded; skipping the render"
  exit 0
fi

echo "→ rendering today's pack"
if .venv/bin/python -m app pack --if-missing; then
  echo "=== $(date '+%H:%M:%S') finished"
else
  echo "=== $(date '+%H:%M:%S') FAILED"
  exit 1
fi
