#!/usr/bin/env bash
# Deploy the Morning Brief Chatterbox-Turbo voice service on a Google Compute Engine GPU VM (NVIDIA L4).
#
# Usage:
#   scripts/deploy-gce.sh [PROJECT_ID] [ZONE]
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

INSTANCE_NAME="morning-brief-voice"
ZONE="${2:-us-central1-a}"
REGION="us-central1"
PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null || echo 'project-67937e0a-4d2d-43ea-9ba')}"
IMAGE_TAG="us-central1-docker.pkg.dev/${PROJECT_ID}/voice-service/morning-brief-voice:latest"

echo "============================================================"
echo "  Deploying Morning Brief Voice Service to GCE GPU VM       "
echo "  Project:  $PROJECT_ID"
echo "  Zone:     $ZONE"
echo "  Hardware: g2-standard-4 (1x NVIDIA L4 GPU, 24GB VRAM)"
echo "============================================================"

# Ensure firewall rule allows port 8090
echo "→ Ensuring firewall rule for port 8090..."
gcloud compute firewall-rules describe allow-voice-service --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create allow-voice-service \
    --allow=tcp:8090 \
    --target-tags=voice-service \
    --description="Allow inbound 8090 for Voice Service" \
    --project="$PROJECT_ID"

# Check if instance already exists
if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "✓ Instance $INSTANCE_NAME already exists."
  # Check if running
  STATUS=$(gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --format="value(status)")
  if [ "$STATUS" != "RUNNING" ]; then
    echo "→ Starting instance $INSTANCE_NAME..."
    gcloud compute instances start "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT_ID"
  fi
else
  echo "→ Creating GPU VM instance ($INSTANCE_NAME)..."
  gcloud compute instances create "$INSTANCE_NAME" \
    --zone="$ZONE" \
    --project="$PROJECT_ID" \
    --machine-type=g2-standard-4 \
    --maintenance-policy=TERMINATE \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=60GB \
    --tags=voice-service,http-server \
    --scopes=cloud-platform \
    --metadata=install-nvidia-driver=True,startup-script="#!/bin/bash
set -e
exec > /var/log/voice-startup.log 2>&1
echo \"Starting voice service setup at \$(date)...\"

# Wait for NVIDIA driver
for i in \$(seq 1 60); do
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    echo \"NVIDIA driver is ready.\"
    break
  fi
  echo \"Waiting for NVIDIA driver (\$i/60)...\"
  sleep 5
done

# Install nvidia-container-toolkit if missing
if ! command -v nvidia-ctk &>/dev/null; then
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
    sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
    tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
  apt-get update && apt-get install -y nvidia-container-toolkit
  nvidia-ctk runtime configure --runtime=docker
  systemctl restart docker
fi

# Configure Docker credentials
gcloud auth configure-docker us-central1-docker.pkg.dev -q

IMAGE=\"$IMAGE_TAG\"
echo \"Pulling image \$IMAGE...\"
docker pull \"\$IMAGE\"

docker rm -f voice-service || true

echo \"Running voice service container on GPU...\"
docker run -d \
  --name voice-service \
  --gpus all \
  --restart always \
  -p 8090:8090 \
  -e PRELOAD_VOICE=1 \
  -e PORT=8090 \
  \"\$IMAGE\"

echo \"Voice service launched at \$(date).\"
"
fi

# Get External IP
IP=$(gcloud compute instances describe "$INSTANCE_NAME" \
  --zone="$ZONE" \
  --project="$PROJECT_ID" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)")

SERVICE_URL="http://${IP}:8090"

echo ""
echo "============================================================"
echo "✓ VM is running!"
echo "  External IP: $IP"
echo "  Voice Service URL: $SERVICE_URL"
echo "============================================================"

# Update .env
if [ -f "$ROOT/.env" ]; then
  if grep -q "^VOICE_SERVICE_URL=" "$ROOT/.env"; then
    sed -i '' "s|^VOICE_SERVICE_URL=.*|VOICE_SERVICE_URL=${SERVICE_URL}|" "$ROOT/.env"
  else
    echo "VOICE_SERVICE_URL=${SERVICE_URL}" >> "$ROOT/.env"
  fi
  echo "✓ Updated .env with VOICE_SERVICE_URL=${SERVICE_URL}"
fi

echo ""
echo "→ Checking service readiness at $SERVICE_URL/health (this may take 1-2 minutes while drivers initialize)..."
for i in $(seq 1 36); do
  if curl -fsS --max-time 5 "$SERVICE_URL/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "✓ Voice service is healthy and responding!"
    curl -s "$SERVICE_URL/health" | jq . || curl -s "$SERVICE_URL/health"
    exit 0
  fi
  sleep 5
done

echo "⚠ Service not yet answering on HTTP. You can inspect startup logs on the VM with:"
echo "  gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --command='sudo cat /var/log/voice-startup.log'"
