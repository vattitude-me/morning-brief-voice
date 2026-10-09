"""Text-to-speech engines.

Primary engine: Chatterbox-Turbo running in the cloud voice service.
Fallback: Microsoft Edge neural voices via edge-tts.
"""
from __future__ import annotations

import io
import logging
import os
from dataclasses import asdict, dataclass
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)

SAMPLE_RATE = 24_000


@dataclass(frozen=True)
class Voice:
    id: str           # "<engine>:<voice>"
    engine: str
    name: str
    accent: str
    gender: str
    description: str
    recommended: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


class Engine(Protocol):
    name: str

    def status(self) -> tuple[bool, str]: ...
    def voices(self) -> list[Voice]: ...
    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> np.ndarray: ...


class ChatterboxEngine:
    name = "chatterbox"

    def status(self) -> tuple[bool, str]:
        url = os.getenv("VOICE_SERVICE_URL", "")
        if not url:
            return False, "VOICE_SERVICE_URL is not configured"
        return True, "Chatterbox-Turbo cloud voice service"

    def voices(self) -> list[Voice]:
        return [
            Voice("chatterbox:alice", "chatterbox", "Alice", "British", "female", "Warm, measured narrator", True),
            Voice("chatterbox:mike", "chatterbox", "Mike", "American", "male", "Calm, steady narrator", False),
        ]

    def synthesize(self, text: str, voice: str, speed: float = 1.0) -> np.ndarray:
        import httpx
        import soundfile as sf

        url = os.getenv("VOICE_SERVICE_URL", "").rstrip("/")
        if not url:
            raise RuntimeError("VOICE_SERVICE_URL is not set")
        ref = "her_reference" if voice in ("alice", "her_reference") else "him_reference"
        with httpx.Client(timeout=180) as client:
            resp = client.post(f"{url}/synthesize", params={"format": "wav"}, json={"text": text, "voice": ref})
            resp.raise_for_status()
            data, _sr = sf.read(io.BytesIO(resp.content))
            return data.astype(np.float32)


_ENGINES: dict[str, Engine] = {}


def register(engine: Engine) -> None:
    _ENGINES[engine.name] = engine


def enabled_engines() -> list[str]:
    return [e.strip() for e in os.getenv("TTS_ENGINES", "chatterbox,edge").split(",") if e.strip()]


_builtins_loaded = False


def engines() -> dict[str, Engine]:
    global _builtins_loaded
    if not _builtins_loaded:
        from .edge import EdgeEngine

        wanted = enabled_engines()
        for engine in (ChatterboxEngine(), EdgeEngine()):
            if engine.name in wanted:
                _ENGINES.setdefault(engine.name, engine)
        _builtins_loaded = True
    return _ENGINES


def default_voice() -> str:
    configured = os.getenv("DEFAULT_VOICE")
    if configured:
        try:
            resolve(configured)
            return configured
        except ValueError:
            pass
    for engine in engines().values():
        voices = engine.voices()
        if voices:
            return next((v.id for v in voices if v.recommended), voices[0].id)
    return "chatterbox:alice"


def all_voices() -> list[dict]:
    out = []
    for engine in engines().values():
        ok, note = engine.status()
        for v in engine.voices():
            out.append({**v.to_dict(), "available": ok, "note": note})
    return out


def resolve(voice_id: str) -> tuple[Engine, str]:
    engine_name, _, voice = voice_id.partition(":")
    engine = engines().get(engine_name)
    if engine is None or not voice:
        raise ValueError(f"Unknown voice '{voice_id}'")
    return engine, voice
