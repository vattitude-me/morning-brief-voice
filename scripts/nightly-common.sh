#!/usr/bin/env bash
# Plumbing shared by the two nightly jobs: nightly-pack.sh at 05:00 and nightly-report.sh at 06:00.
# Sourced, never run directly. Callers set DRY and `set -euo pipefail` first.

# launchd starts a job with almost no PATH, and colima, docker, ffmpeg and ffprobe all live in
# Homebrew's bin. Without this the run fails on the first command.
nightly_init() {   # $1 = job name, for the log file and the opening line
  local job="$1"
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  # HOME is set for a user agent, but a bare `env -i` test has none, and the logs live under it.
  export HOME="${HOME:-$(eval echo "~$(id -un)")}"
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  ROOT="$PWD"
  LOG_DIR="$HOME/Library/Logs/morning-brief"
  mkdir -p "$LOG_DIR"
  LOG="$LOG_DIR/$job-$(date +%Y-%m-%d).log"
  # One file per day per job: a week away leaves a week of readable logs.
  exec >>"$LOG" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') $job starting${DRY:+ (dry run)}"
  if [ ! -x .venv/bin/python ]; then
    echo "✗ No .venv in $ROOT. Create it with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    exit 1
  fi
}

nightly_env() {   # the Supabase and voice service settings the render reads
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  export VOICE_SERVICE_URL="${VOICE_SERVICE_URL:-http://localhost:8090}"
}

nightly_voice_service() {   # colima if it is down, the container, then a wait for the model
  if ! docker info >/dev/null 2>&1; then
    echo "→ starting colima"
    colima start --cpu 4 --memory 8 --disk 60 >>"$LOG" 2>&1 || { echo "✗ colima would not start"; return 1; }
  fi
  echo "→ starting the voice service"
  docker compose -f docker-compose.deploy.yml up -d voice
  # Loading the model takes a minute on CPU, so wait for it rather than racing it.
  echo "→ waiting for the voice service"
  local _
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 5 http://localhost:8090/health 2>/dev/null | grep -q '"loaded":true'; then
      echo "→ voice service ready"
      return 0
    fi
    sleep 5
  done
  echo "✗ The voice service did not become ready in 7 minutes"
  return 1
}
