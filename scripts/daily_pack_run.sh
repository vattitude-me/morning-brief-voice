#!/usr/bin/env bash
# Runs the daily story pack generation with automated GCE GPU start and stop.
# This ensures the GPU instance runs ONLY for the ~12-14 minutes needed to render audio,
# costing ~$0.15/day (~$4.50/month) instead of $500/month 24/7.
set -euo pipefail

INSTANCE="morning-brief-voice"
ZONE="us-central1-c"
PROJECT="project-67937e0a-4d2d-43ea-9ba"
HEALTH_URL="http://34.61.73.242:8090/health"

cleanup() {
  echo "[$(date -u)] Ensuring GPU VM $INSTANCE is stopped..."
  gcloud compute instances stop "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --quiet || true
}
trap cleanup EXIT

echo "[$(date -u)] Starting GPU instance $INSTANCE..."
gcloud compute instances start "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --quiet

echo "[$(date -u)] Waiting for Chatterbox-Turbo voice service to be healthy..."
for i in {1..30}; do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[$(date -u)] Voice service is online and healthy!"
    break
  fi
  sleep 3
done

echo "[$(date -u)] Running story pack generation..."
python3 -m app pack

echo "[$(date -u)] Pack generation complete!"
