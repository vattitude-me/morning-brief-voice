#!/usr/bin/env bash
# Deploy the Chatterbox-Turbo voice service to Google Cloud Run with an NVIDIA L4 GPU.
#
# Usage:
#   scripts/deploy-cloudrun.sh [GCP_PROJECT_ID] [REGION]
#
# Examples:
#   scripts/deploy-cloudrun.sh
#   scripts/deploy-cloudrun.sh my-gcp-project-123 us-central1
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

SERVICE_NAME="morning-brief-voice"
REPO_NAME="voice-service"
DEFAULT_REGION="us-central1"

echo "============================================================"
echo "  Deploying Morning Brief Voice Service to Google Cloud Run "
echo "============================================================"

# 1. Verify gcloud is installed
if ! command -v gcloud >/dev/null 2>&1; then
  echo "✗ gcloud CLI not found. Please install it with: brew install --cask gcloud-cli"
  exit 1
fi

# 2. Check gcloud authentication
ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null || true)
if [ -z "$ACTIVE_ACCOUNT" ]; then
  echo "→ No active Google Cloud account found. Logging in..."
  gcloud auth login
  ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)")
fi
echo "✓ Authenticated as: $ACTIVE_ACCOUNT"

# 3. Project ID
PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
  echo ""
  echo "Available GCP Projects:"
  gcloud projects list --format="table(projectId,name,projectNumber)" || true
  echo ""
  read -rp "Enter your Google Cloud Project ID: " PROJECT_ID
fi

if [ -z "$PROJECT_ID" ]; then
  echo "✗ No project ID provided. Exiting."
  exit 1
fi

gcloud config set project "$PROJECT_ID" --quiet
echo "✓ Using GCP Project: $PROJECT_ID"

# 4. Region (default us-central1 for NVIDIA L4 GPU support)
REGION="${2:-$DEFAULT_REGION}"
echo "✓ Using Region: $REGION (NVIDIA L4 GPU supported)"

# 5. Enable required APIs and grant Cloud Build permissions
echo "→ Enabling required GCP APIs (Cloud Run, Artifact Registry, Cloud Build)..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  compute.googleapis.com \
  --project="$PROJECT_ID"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
echo "→ Ensuring Cloud Build service account has required permissions..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.admin" --condition=None --quiet >/dev/null 2>&1 || true
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/artifactregistry.writer" --condition=None --quiet >/dev/null 2>&1 || true
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/logging.logWriter" --condition=None --quiet >/dev/null 2>&1 || true

# 6. Ensure Artifact Registry repository exists
REPO_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}"
if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "→ Creating Artifact Registry repository '$REPO_NAME' in $REGION..."
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="Morning Brief Voice Docker Images" \
    --project="$PROJECT_ID"
fi
echo "✓ Artifact Registry repository ready: $REPO_URI"

# 7. Build image using Google Cloud Build
# Using Cloud Build avoids building x86_64 CUDA images on Apple Silicon Macs.
IMAGE_TAG="${REPO_URI}/${SERVICE_NAME}:latest"
echo "→ Submitting build to Google Cloud Build (this bakes the model weights & code)..."
gcloud builds submit "$ROOT/voice_service" \
  --tag="$IMAGE_TAG" \
  --machine-type=E2_HIGHCPU_8 \
  --timeout=35m \
  --project="$PROJECT_ID"

echo "✓ Image built and pushed to: $IMAGE_TAG"

# 8. Deploy to Cloud Run with GPU (NVIDIA L4)
echo "→ Deploying to Google Cloud Run with 1x NVIDIA L4 GPU..."
gcloud beta run deploy "$SERVICE_NAME" \
  --image="$IMAGE_TAG" \
  --region="$REGION" \
  --platform=managed \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --cpu=4 \
  --memory=16Gi \
  --no-cpu-throttling \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=1 \
  --timeout=300 \
  --port=8090 \
  --allow-unauthenticated \
  --project="$PROJECT_ID"

# 9. Get the Service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(status.url)')

echo ""
echo "============================================================"
echo "✓ Deployment succeeded!"
echo "  Cloud Run Service URL: $SERVICE_URL"
echo "============================================================"

# 10. Test health check
echo "→ Testing health endpoint..."
if curl -fsS --max-time 30 "$SERVICE_URL/health"; then
  echo ""
  echo "✓ Health check passed!"
else
  echo ""
  echo "⚠ Initial health check timed out (model might still be warming up). Test manually with: curl $SERVICE_URL/health"
fi

# 11. Offer to update .env
if [ -f "$ROOT/.env" ]; then
  if grep -q "^VOICE_SERVICE_URL=" "$ROOT/.env"; then
    # Replace existing
    sed -i '' "s|^VOICE_SERVICE_URL=.*|VOICE_SERVICE_URL=${SERVICE_URL}|" "$ROOT/.env"
  else
    echo "VOICE_SERVICE_URL=${SERVICE_URL}" >> "$ROOT/.env"
  fi
  echo "✓ Updated .env with VOICE_SERVICE_URL=${SERVICE_URL}"
fi

echo ""
echo "Next steps:"
echo "1. Run a sample synthesis to test voice generation:"
echo "   curl -X POST '${SERVICE_URL}/synthesize?format=mp3' -H 'Content-Type: application/json' -d '{\"text\":\"Hello world from Google Cloud!\"}' --output test.mp3"
echo "2. Run today's morning briefing pack using your new GPU service:"
echo "   python -m app pack --notify"
echo ""
