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

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# shellcheck source=scripts/nightly-common.sh
source "$(dirname "$0")/nightly-common.sh"
nightly_init pack
nightly_voice_service
nightly_env

if [ "$DRY" = 1 ]; then
  echo "✓ dry run: the voice service is up and .env loaded; skipping the render"
  exit 0
fi

# Without --force every clip whose article has not changed is reused, so a re-run of a day that is
# already published costs a minute rather than an hour. --notify pushes the outcome: listeners when
# the day is ready, admins either way.
echo "→ rendering today's pack"
if .venv/bin/python -m app pack --if-missing --notify; then
  echo "=== $(date '+%H:%M:%S') finished"
else
  echo "=== $(date '+%H:%M:%S') FAILED"
  exit 1
fi
