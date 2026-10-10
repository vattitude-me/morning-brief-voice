#!/usr/bin/env bash
# Setup Google Cloud Scheduler and Cloud Run Job to run the morning briefing daily at 05:00.
#
# Usage:
#   scripts/setup-scheduler.sh [PROJECT_ID] [REGION]
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null || echo 'project-67937e0a-4d2d-43ea-9ba')}"
REGION="${2:-us-central1}"
JOB_NAME="morning-brief-pack"
SCHEDULER_NAME="morning-brief-daily-5am"
TIMEZONE="${BRIEFING_TIMEZONE:-America/Toronto}"

echo "============================================================"
echo "  Setting up Daily 05:00 AM Google Cloud Scheduler          "
echo "  Project:   $PROJECT_ID"
echo "  Region:    $REGION"
echo "  Timezone:  $TIMEZONE"
echo "============================================================"

# Ensure required APIs are enabled
gcloud services enable cloudscheduler.googleapis.com run.googleapis.com --project="$PROJECT_ID"

# Read environment variables from .env
if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

VOICE_URL="${VOICE_SERVICE_URL:-}"
if [ -z "$VOICE_URL" ]; then
  echo "⚠ VOICE_SERVICE_URL is not set in .env. Please deploy the voice service first."
fi

# Build the worker Docker image
WORKER_TAG="${REGION}-docker.pkg.dev/${PROJECT_ID}/voice-service/morning-brief-worker:latest"
echo "→ Building worker image via Google Cloud Build..."
gcloud builds submit "$ROOT" \
  --tag="$WORKER_TAG" \
  --project="$PROJECT_ID"

# Create or update Cloud Run Job
echo "→ Creating/updating Cloud Run Job ($JOB_NAME)..."
gcloud run jobs deploy "$JOB_NAME" \
  --image="$WORKER_TAG" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --command="python" \
  --args="-m,app,pack,--notify" \
  --set-env-vars="^@^VOICE_SERVICE_URL=${VOICE_URL}@SUPABASE_URL=${SUPABASE_URL:-}@SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY:-}@GROQ_API_KEY=${GROQ_API_KEY:-}@TZ=${TIMEZONE}@BRIEFING_TIMEZONE=${TIMEZONE}@ADMIN_EMAILS=vatsakrish@gmail.com@GCP_PROJECT=${PROJECT_ID}@GCE_ZONE=us-central1-c@GCE_INSTANCE=morning-brief-voice@GCE_MANAGE_VM=true@STORY_VOICES=her_reference,him_reference,jerry_reference,c3po_reference" \
  --cpu=2 \
  --memory=2Gi \
  --task-timeout=30m \
  --max-retries=1

# Create or update Cloud Scheduler
echo "→ Creating/updating Cloud Scheduler ($SCHEDULER_NAME) for 05:00 AM..."
gcloud scheduler jobs delete "$SCHEDULER_NAME" --location="$REGION" --project="$PROJECT_ID" --quiet 2>/dev/null || true

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Grant roles/run.invoker to the service account
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/run.invoker" --condition=None --quiet >/dev/null 2>&1 || true

gcloud scheduler jobs create http "$SCHEDULER_NAME" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --schedule="0 5 * * *" \
  --time-zone="$TIMEZONE" \
  --description="Run Morning Brief pack daily at 5:00 AM" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method="POST" \
  --oauth-service-account-email="$SERVICE_ACCOUNT"

echo ""
echo "============================================================"
echo "✓ Scheduled successfully! The job will execute daily at 05:00 AM."
echo "  You can trigger a manual run right now with:"
echo "    gcloud run jobs execute $JOB_NAME --region=$REGION"
echo "============================================================"
