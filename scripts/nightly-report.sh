#!/usr/bin/env bash
# The 6am check: an hour after the pack, say whether the day is whole and try once to fix it.
#
#   scripts/nightly-report.sh              # the check launchd calls
#   scripts/nightly-report.sh --dry-run    # readiness only: no retry, no voice service, no report
#
# Installed as a LaunchAgent at 06:00 (see docs/nightly.md). The hour gap is the point: a transient
# failure at 05:00 has time to clear before the retry, and the admin hears about a day that is still
# broken, which the 05:00 run on its own would never tell them.
#
# The readiness check runs first and needs nothing but Python, so a morning that worked costs no
# container start. Only a missing narrator brings the voice service up.
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# shellcheck source=scripts/nightly-common.sh
source "$(dirname "$0")/nightly-common.sh"
nightly_init report
nightly_env

if [ "$DRY" = 1 ]; then
  echo "→ dry run: readiness check only"
  .venv/bin/python -m app pack --check || echo "→ (incomplete; a real run would retry it)"
  echo "✓ dry run finished"
  exit 0
fi

if .venv/bin/python -m app pack --check && .venv/bin/python -m app pack --report; then
  # Complete, and the report went out: one line per narrator, which is the success notification.
  echo "=== $(date '+%H:%M:%S') complete"
  exit 0
fi

# A slow morning can still be recording at 06:00 on this machine. Wait for it rather than starting a
# second pack against the same voice service, then look again.
if pgrep -f '[-]m app pack' >/dev/null 2>&1; then
  echo "→ the 05:00 pack is still running; waiting up to 30 minutes for it"
  for _ in $(seq 1 120); do
    pgrep -f '[-]m app pack' >/dev/null 2>&1 || break
    sleep 15
  done
  if .venv/bin/python -m app pack --check && .venv/bin/python -m app pack --report; then
    echo "=== $(date '+%H:%M:%S') complete, late"
    exit 0
  fi
  if pgrep -f '[-]m app pack' >/dev/null 2>&1; then
    echo "→ still rendering after 30 minutes; reporting without a retry"
    .venv/bin/python -m app pack --report || true
    echo "=== $(date '+%H:%M:%S') still running"
    exit 0
  fi
fi

echo "→ incomplete; one retry"
if ! nightly_voice_service; then
  # No voice service, so the retry is pointless: report the failure as it stands.
  .venv/bin/python -m app pack --report || true
  echo "=== $(date '+%H:%M:%S') voice service down"
  exit 1
fi

if .venv/bin/python -m app pack --report --retry; then
  echo "=== $(date '+%H:%M:%S') recovered"
else
  echo "=== $(date '+%H:%M:%S') INCOMPLETE"
  exit 1
fi
