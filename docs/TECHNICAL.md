# 🛠️ Morning Brief — Technical & Architecture Guide

This document contains full technical specifications, architecture diagrams, backend service setup, Docker environments, operations, and deployment guides for developers and self-hosters running **Morning Brief**.

For an overview of user-facing features, web, and mobile app usage, see the main [README.md](../README.md).

---

## 🏗️ System Architecture

```text
 Browser / PWA (static, Vercel)  ──►  Supabase (auth, tables, MP3 storage)  ◄──  Worker (Docker)
                                                                                  fetch → rank → summarize (Groq / Gemini)
 ◄──────────────────────────── Web Push "Your brief is ready" ────────────────  → Chatterbox-Turbo voice → upload
```

- **Web app** (`web/`): Pure static vanilla HTML/CSS/JS progressive web app. Zero client secrets, frosted-glass design system with light/dark themes.
- **Supabase**: PostgreSQL database, Row-Level Security (RLS) keeping each user's preferences private, Magic Link & Google Auth, and audio storage buckets.
- **Worker** (`app/`): Nightly Python batch engine. Outbound connections only; fetches feeds, ranks and deduplicates stories per user, summarizes via Groq or Gemini, coordinates voice rendering, and dispatches Web Push notifications.
- **Voice Service** (`voice_service/`): A dedicated, high-fidelity neural narration service hosting Chatterbox-Turbo (stateless FastAPI service hosting Alice, Mike, and promo voices). Scales to zero when idle.
- **Android App** (`android/`): Native Kotlin / Jetpack Compose application that builds and voices briefings on-device or streams cloud packs. See [`android/README.md`](../android/README.md).

### The Nightly Ingestion Pipeline
Each morning the worker:
1. **Fetches**: Reads every configured RSS and custom news feed once.
2. **Ranks & Deduplicates**: Personalizes the story queue per user, skipping stories covered in their previous two briefings.
3. **Summarizes**: Generates audio-ready concise summaries using Groq (or Gemini AI Studio), with graceful fallback to a local extractive summarizer.
4. **Voices**: Synthesizes the master audio package using the Chatterbox-Turbo voice service.
5. **Publishes & Notifies**: Stores audio clips in Supabase Storage and dispatches Web Push notifications when the brief is ready.

---

## 🚀 Setup & Deployment

### 1. Supabase Backend
1. Create a Supabase project and execute [`supabase/schema.sql`](../supabase/schema.sql) in the SQL Editor (safe to re-run idempotent schema).
2. **Authentication → Providers → Email**: Enable Email provider. Toggle *"Allow new users to sign up"* off if you prefer an invite-only setup.
3. **Authentication → URL Configuration**: Set the Site URL and Redirect URLs to your web app's address (and `me.vattitude.morningbrief://auth` for Android auth).
4. **Keys**:
   - Place your Supabase *publishable key* and *project URL* in [`web/config.js`](../web/config.js).
   - Place your Supabase *service role secret key* exclusively in the server worker's `.env`.

### 2. Web App Deployment
Deploy the `web/` directory to any static CDN or hosting provider (Vercel, Cloudflare Pages, Netlify, or Nginx).
- **Vercel**: Set root directory to `web/` with no build command needed.

### 3. Worker (Docker)
```bash
cp .env.example .env              # Fill in Supabase URL + secret key, Groq/Gemini key, admin emails
docker compose up -d --build
docker compose exec worker python -m app check
```

---

## 💻 Local Development with Docker

[`docker-compose.deploy.yml`](../docker-compose.deploy.yml) provides a multi-service local environment mimicking production:

| Service | Role | Local Address |
| :--- | :--- | :--- |
| `voice` | Chatterbox-Turbo Neural TTS API | `http://localhost:8090` |
| `web` | Static Web App / PWA | `http://localhost:8080` |
| `worker` | Nightly batch generation engine | profile `worker` |

### Running the Stack:
```bash
# Start Voice Service + Web App
docker compose -f docker-compose.deploy.yml up --build

# Run a test batch pack
docker compose -f docker-compose.deploy.yml --profile worker up -d worker
docker compose -f docker-compose.deploy.yml run --rm worker python -m app pack
```

---

## ⚙️ Environment Configuration

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SUPABASE_URL` | — | Supabase project endpoint URL |
| `SUPABASE_SECRET_KEY` | — | Supabase service-role secret key (server-only) |
| `GROQ_API_KEY` | — | API key for Groq inference (optional) |
| `GROQ_MODELS` | `openai/gpt-oss-120b,openai/gpt-oss-20b` | Model fallback order |
| `GEMINI_API_KEY` | — | Optional Google Gemini AI Studio key |
| `BRIEFING_TIMEZONE` | `America/Toronto` | Primary timezone for scheduling |
| `BATCH_TIME` | `07:05` | Target build time (24-hour clock) |
| `KEEP_DAYS` | `2` | Retention window for historical briefing audio |
| `ADMIN_EMAILS` | — | Comma-separated admin accounts |
| `ADMIN_NOTIFY` | `issues` | Alerting level: `issues`, `always`, or `off` |
| `VAPID_SUBJECT` | — | Contact email for Web Push notifications |
| `MAX_CUSTOM_SOURCES` | `15` | Per-user custom link/RSS limit |

---

## 🎙️ Voice Service (Chatterbox-Turbo)

The voice service in `voice_service/` synthesizes daily news stories into audio using custom neural cloned narrators (Alice & Mike).

- **Full Voice Documentation**: See [`voice_service/README.md`](../voice_service/README.md).
- **Voice Roadmap & Styles**: See [`docs/CUSTOM_VOICE_ROADMAP.md`](CUSTOM_VOICE_ROADMAP.md).

### Local Native Run (Apple Silicon / CUDA):
```bash
cd voice_service
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e .
mkdir -p data/voices && cp your_voice.wav data/voices/reference.wav
.venv/bin/uvicorn --app-dir . api.app:app --host 0.0.0.0 --port 8090
```

### Core API Endpoints:
- `GET /health`: Engine status, compute device (`mps`, `cuda`, or `cpu`), sample rate.
- `GET /voices`: Available reference voice profiles.
- `POST /synthesize`: Synthesizes raw text to WAV/MP3 with customizable pause beats.
- `POST /news/sample`: Returns audio base64, chapter spans, and timing marks.

---

## 🛠️ Operations & Maintenance

- **Manual Trigger**: Run `./scripts/run-now.sh [--user you@example.com] [--no-push]` to immediately rebuild today's brief.
- **Nightly Automation**: See [`docs/nightly.md`](nightly.md) for LaunchAgent / cron setup for `scripts/nightly-pack.sh` and `scripts/nightly-report.sh`.
- **Admin Diagnostics**: Failures and system logs are written to the `run_log` table and viewable in the Web App's built-in Admin panel.

---

## 🧪 Testing

```bash
# Backend worker unit tests
pip install -r requirements.txt pytest
pytest -q

# Android unit tests
cd android && ./gradlew testDebugUnitTest
```
