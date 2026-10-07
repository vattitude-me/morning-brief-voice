# Morning Brief v2 — voice service

Server-side **Chatterbox-Turbo** voice for the Morning Brief briefing. The v1 web
app and PWA keep working unchanged; they call this service over the LAN when they
want the cloned narrator instead of Kokoro.

## What this folder is

The **voice service** component of the parent Morning Brief repo: the
Chatterbox-Turbo API that turns a briefing script into audio. The web app / PWA,
the Android app and the nightly worker live elsewhere in the repo (`web/`,
`android/`, `app/`).

Everything here is self-contained, with its own venv and dependencies, because
Turbo needs PyTorch on Apple Silicon: the worker runs on the NAS and calls this
service over the LAN instead of loading the model in its own Docker image.

## Layout

```text
api/            FastAPI app and the built-in sample bulletin
turbo_voice/    Chatterbox-Turbo engine and the script -> spans text layer
data/voices/    reference clips; each filename becomes a selectable voice
scripts/        smoke tests: engine-only (smoke.py) and over HTTP (api_smoke.py)
tests/          unit tests for the text layer, no model required
docs/postman/   the Postman collection for the HTTP API
```

The scripts write generated audio to `out/`, which is git-ignored.

## Why a separate service

Turbo is a PyTorch model that wants a GPU. MPS (Apple Silicon) is **not**
available inside Docker on macOS, so this runs as a native venv, and the v1
worker on the NAS calls it over HTTP. That keeps scheduling, fetching, the LLM
script, push and Supabase on the NAS, and only text and audio cross the LAN.

## Requirements

- Python 3.11 (Chatterbox's tested version)
- Apple Silicon for `mps`, or any CPU (much slower)
- A reference clip **longer than 5 seconds** — Turbo is zero-shot, it clones

## Setup

```sh
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -e .
mkdir -p data/voices && cp your_voice.wav data/voices/reference.wav
```

Put a clean single-speaker recording of the voice you want in
`data/voices/reference.wav`. Around 10–15 seconds of natural speech works best.

## Run

```sh
.venv/bin/uvicorn --app-dir . api.app:app --host 0.0.0.0 --port 8090
```

Environment: `VOICE_DIR` (default `data/voices`), `VOICE_REFERENCE` (default
`$VOICE_DIR/reference.wav`). See `.env.example`.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | device, sample rate, reference status |
| GET | `/voices` | — | reference clips on disk |
| POST | `/synthesize` | `{"text": "...", "beat": 0.45}` | `audio/wav` |
| POST | `/news/sample` | `{"text": "..."}` | JSON: base64 audio, timing marks, warnings |

`/news/sample` with no body renders the built-in sample bulletin, which is the
quickest way to hear the voice and see the pause timings.

## Choosing a voice

Drop any number of clips into `data/voices/`. Each becomes a selectable voice by
its **filename without the extension**, and the caller picks one per request:

```json
{ "text": "Hello there.", "voice": "her_output" }
```

`GET /voices` lists them with durations and a `usable` flag — Chatterbox requires
a reference longer than 5 seconds. If a `data/voices/reference.wav` exists it is
the default when `voice` is omitted; otherwise the first usable clip is used.

## Trying it from Postman

Import `docs/postman/Morning_Brief_v2_Voice.postman_collection.json`, or follow
along by hand. The server listens on all interfaces, so use either address:

- `http://127.0.0.1:8090` — same machine
- `http://10.0.0.130:8090` — anywhere on your LAN

Interactive docs (Swagger UI, no setup needed): `http://10.0.0.130:8090/docs`

**Get an audio file back — `POST /synthesize`**

- Body: raw JSON
- Payload:

```json
{
  "text": "Good morning! [[pause:0.6]] The port strike is over... [sigh] it was a long week.",
  "voice": "her_output"
}
```

- In Postman choose **Send and Download** to save the `.wav`; the response is
  `audio/wav`. Useful response headers: `X-Duration`, `X-Voice`, `X-Sample-Rate`.

**Get JSON with timings — `POST /news/sample`**

Same body (or `{}` for the built-in bulletin). Returns `duration`, `spans`, a
`marks` array of start/end times, any `warnings`, and the audio as base64.

## Writing for the voice

Chatterbox reads ordinary punctuation well — commas, full stops and question
marks all land naturally. On top of that:

- `[[pause:0.8]]` — silence for that many seconds (max 5)
- `...` or `…` — one beat of silence (default 0.45s, set with `beat`)
- a blank line — a paragraph break, also one beat
- `[sigh]`, `[chuckle]`, `[laugh]`, `[cough]`, `[gasp]`, `[groan]`, `[sniffle]`, `[yawn]`

The paralinguistic tags are the model's own: it *performs* the sound, which is
far more convincing than synthesised breath. Use them sparingly.

**Why we insert silence ourselves:** Chatterbox's internal `punc_norm()`
rewrites `…` to `, ` and `—` to `-`, so punctuation alone can never produce a
real beat. The text layer splits the script into spans and pauses, voices each
span, and joins them with exact silence — the same "voice each beat, then stitch"
approach v1 uses.

## Measured performance

On an M3 Pro (36 GB, MPS), Turbo renders at roughly **0.85–1.1× realtime**
including the pauses. A 10-minute briefing is therefore a ~10-minute build, which
suits a nightly batch. First call after a restart takes ~40 s to download and
warm the model.

## Gotchas

- **`setuptools<81` is required.** Chatterbox's watermarker (`perth`) imports
  `pkg_resources`, which setuptools 81+ removed. Without the pin the model fails
  to load with `TypeError: 'NoneType' object is not callable`.
- Turbo **ignores** `cfg_weight`, `exaggeration` and `min_p` — those apply to the
  original 500M Chatterbox, not Turbo. Pacing is controlled with `temperature`,
  `top_p` and our own silence.
- The `nano` flag is **not** in the PyPI release (0.1.7); Nano needs an install
  from source. This service is for the GPU/MPS host.
- Every output carries Resemble's inaudible PerTh watermark.
- Cloning a voice needs the speaker's consent.

## Integration with the worker

The parent worker picks its TTS engine through `app/tts/`: every engine
implements the same `Engine` protocol (`status()`, `voices()`, `synthesize()`)
and is switched on with `TTS_ENGINES`. This service is that idea moved out of
process — a `turbo` engine in `app/tts/turbo.py` would just `POST /synthesize`
and hand back the WAV bytes, keeping PyTorch out of the worker image.

`SAMPLE_RATE` is 24 kHz here, matching `app/tts`, so the audio needs no
resampling.

## Tests

```sh
.venv/bin/python -m pytest -q
```
