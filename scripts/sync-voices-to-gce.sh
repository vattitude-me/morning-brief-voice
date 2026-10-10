#!/usr/bin/env bash
# Sync local voice reference files to the GCE GPU VM (Chatterbox-Turbo).
# Starts the instance if stopped, copies the WAV files into the voice-service container,
# and stops the instance afterwards to halt billing.
set -euo pipefail

INSTANCE="morning-brief-voice"
ZONE="us-central1-c"
PROJECT="project-67937e0a-4d2d-43ea-9ba"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "============================================================"
echo "  Syncing Voice Reference Clips to GCE GPU VM ($INSTANCE)   "
echo "============================================================"

# Check VM status
STATUS=$(gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --format="value(status)" 2>/dev/null || echo "UNKNOWN")
WAS_STOPPED=false

cleanup() {
  if [ "$WAS_STOPPED" = true ]; then
    echo "→ Stopping GPU VM $INSTANCE to prevent idle charges..."
    gcloud compute instances stop "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --quiet || true
    echo "✓ GPU VM stopped (billing halted)."
  fi
}
trap cleanup EXIT

if [ "$STATUS" != "RUNNING" ]; then
  WAS_STOPPED=true
  echo "→ Starting GPU VM $INSTANCE..."
  gcloud compute instances start "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --quiet
fi

# Wait for SSH to be ready
echo "→ Waiting for SSH readiness..."
for i in {1..25}; do
  if gcloud compute ssh "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --command="echo ok" --quiet >/dev/null 2>&1; then
    echo "✓ SSH is ready."
    break
  fi
  sleep 3
done

# Copy voice files to /tmp/ on VM
echo "→ Copying voice reference files to VM..."
gcloud compute scp "$ROOT/voice_service/data/voices/"*.wav "$INSTANCE:/tmp/" --zone="$ZONE" --project="$PROJECT" --quiet

# Copy into voice-service Docker container and persistent host directory
echo "→ Copying voices into Docker container /app/data/voices/..."
gcloud compute ssh "$INSTANCE" --zone="$ZONE" --project="$PROJECT" --command="
  sudo mkdir -p /var/lib/voice-service/voices
  sudo cp /tmp/*.wav /var/lib/voice-service/voices/
  sudo docker cp /tmp/c3po_reference.wav voice-service:/app/data/voices/ 2>/dev/null || true
  sudo docker cp /tmp/jerry_reference.wav voice-service:/app/data/voices/ 2>/dev/null || true
  echo 'Current container voices:'
  sudo docker exec voice-service ls -la /app/data/voices/ || true
"

echo "✓ Voice reference files successfully synced to GCE!"
