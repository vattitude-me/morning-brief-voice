# ☀️ Morning Brief Voice

Your daily news on cards, **read aloud every morning by a natural neural voice**. Pick topics (top stories, world,
business, tech, health, science, sports, entertainment), local news for your city, people and teams to follow,
and any link. Each user gets their own briefing and a phone notification every morning.

![Morning Brief on desktop](docs/screenshots/archived/desktop.png)

| Mobile (dark) | Swipe deck | Voice picker |
|---|---|---|
| ![](docs/screenshots/archived/mobile-dark.png) | ![](docs/screenshots/archived/mobile-swipe.png) | ![](docs/screenshots/archived/settings.png) |

**Android app**

| Today | Following along | Sources | Dark |
|---|---|---|---|
| ![](docs/screenshots/android-today-light.png) | ![](docs/screenshots/android-playing-dark.png) | ![](docs/screenshots/android-sources-light.png) | ![](docs/screenshots/android-today-dark.png) |

## Architecture

```
 Browser / PWA (static, Vercel)  ──►  Supabase (auth, tables, MP3 storage)  ◄──  Worker (Docker)
                                                                                  fetch → rank → summarize (Groq)
 ◄──────────────────────────── Web Push "Your brief is ready" ────────────────  → Kokoro voice → upload
```

- **Web app** (`web/`): static files only, no secrets.
- **Supabase**: row-level security keeps each user to their own data.
- **Worker** (`app/`): makes outbound calls only, and never fetches private-network addresses from user links.
- **Android app** (`android/`): builds and voices the briefing on the phone, with no worker needed. See [`android/README.md`](android/README.md).
- **Voice service** (`voice_service/`): the optional Chatterbox-Turbo "cloned narrator". A separate PyTorch service for Apple Silicon (or a GPU host) that the worker can call over the LAN, keeping the model out of the worker image. See [`voice_service/README.md`](voice_service/README.md).

Each morning the worker:
1. Fetches every feed once.
2. Ranks and deduplicates stories per user, skipping stories from their last two briefings.
3. Summarizes each story once with Groq, falling back to a built-in summarizer.
4. Records each user's MP3.
5. Notifies each user.

After the admin's briefing is built, a copy is published as the landing-page demo (falling back to `web/sample/`).

## Setup

**Supabase**
1. Create a project and run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor. It's safe to re-run.
2. **Authentication → Providers → Email**: enabled. Turn "Allow new users to sign up" off to make it invite-only.
3. **Authentication → URL Configuration**: set the Site URL and Redirect URLs to your web app's address.
4. Optional: set up custom SMTP and add `{{ .Token }}` to the Magic Link template. The email then includes a code,
   which lets installed iOS apps sign in.
5. Put the *publishable* key in [`web/config.js`](web/config.js). The *secret* key goes only in the worker's `.env`.

**Web app**: deploy `web/` to any static host. On Vercel, set the root directory to `web`, with no build step.

**Worker**
```bash
cp .env.example .env              # Supabase URL + secret key, Groq key, admin emails
docker compose up -d --build
docker compose exec worker python -m app check
```

## Operations

- **Build now:** `./scripts/run-now.sh [--user you@example.com] [--no-push]` clears today's brief, rebuilds it and prints the result.
- **Missed runs:** if the host was asleep at `BATCH_TIME`, the worker catches up when it wakes (until noon).
- **Admin alerts:** problems are pushed to admins, including Groq rate limits, retired models, unreadable links and voice or upload failures.
  Users see a short note only when their briefing is affected.

## Configuration

| Variable | Default | |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | | Secret key is server-only |
| `GROQ_API_KEY` | | Optional; without it, summaries are built-in |
| `GROQ_MODELS` | `openai/gpt-oss-120b,openai/gpt-oss-20b` | Tried in order |
| `BRIEFING_TIMEZONE` | `America/Toronto` | |
| `BATCH_TIME` | `07:05` | 24-hour clock |
| `KEEP_DAYS` | `2` | Older briefings are deleted |
| `ADMIN_EMAILS` | | Comma-separated |
| `ADMIN_NOTIFY` | `issues` | `issues`, `always` or `off` |
| `VAPID_SUBJECT` | | `mailto:` address for push |
| `MAX_CUSTOM_SOURCES` | `15` | Links per user each day |

## Voice service (optional)

`voice_service/` is a self-contained Chatterbox-Turbo "cloned narrator" API for
Apple Silicon or a GPU host. The worker calls it over the LAN, so PyTorch stays
out of the worker image. Full guide: [`voice_service/README.md`](voice_service/README.md).

**Setup & run** (Python 3.11):

```sh
cd voice_service
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e .
mkdir -p data/voices && cp your_voice.wav data/voices/reference.wav
.venv/bin/uvicorn --app-dir . api.app:app --host 0.0.0.0 --port 8090
```

**Endpoints**

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | device, sample rate, reference status |
| GET | `/voices` | — | reference clips on disk |
| POST | `/synthesize` | `{"text": "...", "voice": "her_reference"}` | `audio/wav` |
| POST | `/news/sample` | `{"text": "..."}` or `{}` | JSON: base64 audio, timing marks |

Each clip's filename (without extension) becomes a selectable voice. Interactive
docs (Swagger UI) are at `/docs`.

## Development

```bash
pip install -r requirements.txt pytest && pytest -q
```
