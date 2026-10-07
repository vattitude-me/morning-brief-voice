"""HTTP API for the v2 voice service.

Run from the project root::

    .venv/bin/uvicorn --app-dir . api.app:app --host 0.0.0.0 --port 8090

Endpoints::

    GET  /health        model, device and reference status
    GET  /voices        reference clips on disk, with durations
    POST /synthesize    {"text": "...", "voice": "her_reference"} -> audio/wav
                        ?format=mp3 -> audio/mpeg (for the shared daily clips)
    POST /news/sample   {"text": "...", "voice": "her_reference"} -> JSON + base64 audio

Every endpoint is a plain ``def`` so FastAPI runs it in its threadpool: the model
is CPU/GPU bound and must not block the event loop.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import threading
from pathlib import Path

import soundfile as sf
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from turbo_voice import SAMPLE_RATE, TurboVoice, pick_device, plain, tags, to_mp3

from .sample import SAMPLE_STORY

log = logging.getLogger(__name__)

app = FastAPI(title="Morning Brief v2 voice", version="2.0.0")

CLIP_SUFFIXES = {".wav", ".mp3", ".m4a", ".aiff", ".aif", ".flac", ".ogg"}

_voice: TurboVoice | None = None
_voice_lock = threading.Lock()


# ---------------------------------------------------------------------- setup
def voice_dir() -> Path:
    return Path(os.getenv("VOICE_DIR", "data/voices"))


def reference_path() -> Path | None:
    """The default voice: an explicit path, else ``data/voices/reference.wav`` if present."""
    configured = os.getenv("VOICE_REFERENCE")
    if configured:
        return Path(configured)
    default = voice_dir() / "reference.wav"
    return default if default.exists() else None


def clips() -> list[dict]:
    """Every reference clip on disk with its duration, so a caller can choose one."""
    directory = voice_dir()
    if not directory.is_dir():
        return []
    found = []
    for path in sorted(directory.iterdir()):
        if path.suffix.lower() not in CLIP_SUFFIXES:
            continue
        try:
            info = sf.info(str(path))
        except Exception:  # noqa: BLE001 — an unreadable file is simply not offered
            continue
        found.append({
            "name": path.stem,
            "file": path.name,
            "seconds": round(info.duration, 2),
            # Chatterbox asserts the reference is longer than 5 seconds.
            "usable": info.duration > 5.0,
        })
    return found


def clip_path(name: str) -> Path:
    """Resolve a clip name inside ``VOICE_DIR``, refusing anything that escapes it."""
    directory = voice_dir().resolve()
    raw = Path(name)
    if raw.suffix == "":
        raw = raw.with_suffix(".wav")
    resolved = (directory / raw).resolve()
    if directory not in resolved.parents or not resolved.is_file():
        raise HTTPException(status_code=400, detail=f"Unknown voice '{name}'")
    return resolved


def target_for(requested: str | None) -> Path:
    """The clip to clone: the one the caller named, else the default.

    With no ``reference.wav`` we fall back to the first usable clip, so the API can
    be tried before a voice has been chosen.
    """
    if requested:
        return clip_path(requested)
    default = reference_path()
    if default is None:
        first = next((c for c in clips() if c["usable"]), None)
        default = clip_path(first["file"]) if first else None
    if default is None or not default.exists():
        raise HTTPException(
            status_code=400,
            detail="No voice available. Add a clip to data/voices/, or pass one from /voices.",
        )
    return default


def get_voice() -> TurboVoice:
    """The one loaded model. Loading is lazy so the API can report health first."""
    global _voice
    with _voice_lock:
        if _voice is None:
            _voice = TurboVoice(reference_path())
        return _voice


def wav_bytes(samples, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _fail(exc: Exception) -> HTTPException:
    log.warning("Voice unavailable: %s", exc)
    return HTTPException(status_code=503, detail=str(exc))


# --------------------------------------------------------------------- models
class SynthRequest(BaseModel):
    text: str = Field(..., min_length=1)
    beat: float | None = Field(None, gt=0, le=5.0)
    voice: str | None = Field(None, description="Clip name from /voices; defaults to reference.wav")


class SampleRequest(BaseModel):
    text: str | None = None
    beat: float | None = Field(None, gt=0, le=5.0)
    voice: str | None = Field(None, description="Clip name from /voices; defaults to reference.wav")


# ------------------------------------------------------------------ endpoints
@app.get("/health")
def health() -> dict:
    ref = reference_path()
    return {
        "status": "ok" if ref else "no-default-voice",
        "device": pick_device(),
        "sample_rate": SAMPLE_RATE,
        "loaded": _voice is not None,
        "default_voice": ref.name if ref else None,
        "clips": len(clips()),
    }


@app.get("/voices")
def voices() -> dict:
    ref = reference_path()
    return {"dir": str(voice_dir()), "default": ref.name if ref else None, "clips": clips()}


@app.post("/synthesize")
def synthesize(req: SynthRequest, format: str = Query("wav", pattern="^(wav|mp3)$")) -> Response:
    """Voice a script exactly as written, honouring pauses and tags.

    ``?format=mp3`` returns a compressed clip — the shared story pack stores MP3s so a
    whole day of audio stays small enough for the Supabase bucket.
    """
    try:
        voice = get_voice()
        kwargs = {} if req.beat is None else {"beat": req.beat}
        target = target_for(req.voice)
        audio, _ = voice.render(req.text, reference=target, **kwargs)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — report any other failure to the caller
        raise _fail(exc) from exc
    if audio.size == 0:
        raise HTTPException(status_code=400, detail="Nothing to say")
    if format == "mp3":
        try:
            body, media = to_mp3(audio, SAMPLE_RATE), "audio/mpeg"
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    else:
        body, media = wav_bytes(audio), "audio/wav"
    return Response(
        content=body,
        media_type=media,
        headers={
            "X-Sample-Rate": str(SAMPLE_RATE),
            "X-Duration": f"{audio.size / SAMPLE_RATE:.2f}",
            "X-Voice": target.name,
            "X-Format": format,
        },
    )


@app.post("/news/sample")
def news_sample(req: SampleRequest) -> dict:
    """Build a sample bulletin and return it with timings, for the PWA demo."""
    text = req.text or SAMPLE_STORY
    try:
        voice = get_voice()
        kwargs = {} if req.beat is None else {"beat": req.beat}
        target = target_for(req.voice)
        audio, marks = voice.render(text, reference=target, **kwargs)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _fail(exc) from exc

    warnings = [f"Unknown tag [{t}] will be read aloud" for t in tags(text)]
    return {
        "voice": target.name,
        "sample_rate": SAMPLE_RATE,
        "duration": round(audio.size / SAMPLE_RATE, 2),
        "spans": len(marks),
        "marks": [{"text": t, "start": s, "end": e} for t, s, e in marks],
        "text": plain(text),
        "warnings": warnings,
        "audio_b64": base64.b64encode(wav_bytes(audio)).decode(),
    }


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8090")))


if __name__ == "__main__":
    main()
