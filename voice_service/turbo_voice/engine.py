"""Chatterbox-Turbo on an NVIDIA GPU, on Apple Silicon, or on plain CPU.

The model is loaded once per process and a reference clip is embedded once, then
reused. ``prepare_conditionals()`` is the expensive part — doing it per span would
dominate a build — so it runs again only when the clip changes, which also makes
it cheap to switch voices between requests.

Because that embedding is the only costly per-voice step, it is also cached on disk
next to the clip (``<clip>.turbo-v1.conds.pt``) so a restarted process — or a fresh
cloud container — skips it entirely. Chatterbox ships this hook itself, as
``Conditionals.save()`` / ``Conditionals.load()``.

Turbo ignores ``cfg_weight``, ``exaggeration`` and ``min_p``; pacing is controlled
with temperature, top_p and the silence we insert ourselves.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import numpy as np

from .text import Pause, Say, parse

log = logging.getLogger(__name__)

SAMPLE_RATE = 24_000

# Part of the cache filename: bump it when the model or the conditional layout
# changes and stale sidecars are simply ignored.
CONDS_STAMP = "turbo-v1"


def pick_device() -> str:
    """``cuda`` on an NVIDIA GPU, ``mps`` on Apple Silicon, otherwise CPU."""
    try:
        import torch
    except ImportError:  # surfaced properly when the model loads
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def cache_enabled() -> bool:
    """Voice-conditioning sidecars are on by default; set VOICE_CONDS_CACHE=0 to disable."""
    return os.getenv("VOICE_CONDS_CACHE", "1").strip().lower() not in {"0", "false", "no", "off"}


class TurboVoice:
    """A Chatterbox-Turbo voice cloned from a reference clip."""

    def __init__(self, reference: Path | str | None = None, device: str | None = None,
                 cache_conds: bool | None = None):
        # The reference is optional so the service can start, report health and
        # list voices before one has been chosen.
        self.reference = Path(reference) if reference else None
        self.device = device or pick_device()
        self.cache_conds = cache_enabled() if cache_conds is None else cache_conds
        self._model = None
        self._prepared: tuple[str, int] | None = None
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- loading
    def _load(self):
        if self._model is None:
            from chatterbox.tts_turbo import ChatterboxTurboTTS

            log.info("Loading Chatterbox-Turbo on %s", self.device)
            self._model = ChatterboxTurboTTS.from_pretrained(device=self.device)
        return self._model

    def path_for(self, reference: Path | str | None = None) -> Path:
        """The clip to clone: the one asked for, else this voice's own."""
        chosen = Path(reference) if reference else self.reference
        if chosen is None:
            raise ValueError("No reference voice chosen")
        return chosen

    def _sidecar(self, reference: Path) -> Path:
        """Where this clip's precomputed conditionals live (a sibling file)."""
        return reference.with_name(f"{reference.stem}.{CONDS_STAMP}.conds.pt")

    def _condition(self, model, reference: Path) -> None:
        """Embed a reference clip — once, and again only when the clip changes.

        On a cache hit the saved conditionals are loaded, which skips both the WAV
        read and the neural embedding, so a restart costs nothing per voice.
        """
        if not reference.exists():
            raise FileNotFoundError(f"Reference clip not found: {reference}")
        key = (str(reference), reference.stat().st_mtime_ns)
        if self._prepared == key:
            return
        if self._load_cached(model, reference):
            self._prepared = key
            return
        log.info("Embedding reference voice %s", reference.name)
        model.prepare_conditionals(str(reference))
        self._save_cached(model, reference)
        self._prepared = key

    def _load_cached(self, model, reference: Path) -> bool:
        if not self.cache_conds:
            return False
        sidecar = self._sidecar(reference)
        try:
            # A sidecar is only good if it is not older than the clip it came from.
            if not sidecar.is_file() or sidecar.stat().st_mtime_ns < reference.stat().st_mtime_ns:
                return False
            from chatterbox.tts_turbo import Conditionals

            model.conds = Conditionals.load(sidecar, map_location="cpu").to(self.device)
            log.info("Loaded cached voice conditionals %s", sidecar.name)
            return True
        except Exception as exc:  # noqa: BLE001 — a bad cache must never break synthesis
            log.warning("Ignoring cached conditionals %s: %s", sidecar.name, exc)
            return False

    def _save_cached(self, model, reference: Path) -> None:
        if not self.cache_conds:
            return
        sidecar = self._sidecar(reference)
        try:
            conds = model.conds.to("cpu")  # torch.save of MPS tensors is not reliable
            conds.save(sidecar)
            conds.to(self.device)
            log.info("Cached voice conditionals to %s", sidecar.name)
        except Exception as exc:  # noqa: BLE001 — caching is best-effort
            log.warning("Could not cache conditionals to %s: %s", sidecar, exc)

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    # --------------------------------------------------------------- synthesis
    def say(self, text: str, *, reference: Path | str | None = None, temperature: float = 0.8,
            top_p: float = 0.95, top_k: int = 1000, repetition_penalty: float = 1.2) -> np.ndarray:
        """One span of speech, with no leading or trailing silence of our own."""
        model = self._load()
        self._condition(model, self.path_for(reference))
        with self._lock:  # the model keeps per-call state; one span at a time
            wav = model.generate(
                text,
                temperature=temperature,
                top_p=top_p,
                top_k=top_k,
                repetition_penalty=repetition_penalty,
            )
        return wav.detach().cpu().numpy().squeeze(0).astype(np.float32)

    def silence(self, seconds: float) -> np.ndarray:
        return np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32)

    def render(self, script: str, *, beat: float | None = None,
               reference: Path | str | None = None) -> tuple[np.ndarray, list[tuple[str, float, float]]]:
        """Voice a whole script, honouring ``[[pause:x]]``, ellipses and blank lines.

        Returns the audio and a ``(text, start, end)`` mark per speech span, so
        chapter timings come out of the same pass.
        """
        items = parse(script) if beat is None else parse(script, beat=beat)
        pieces: list[np.ndarray] = []
        marks: list[tuple[str, float, float]] = []
        cursor = 0

        for item in items:
            if isinstance(item, Pause):
                gap = self.silence(item.seconds)
                pieces.append(gap)
                cursor += gap.size
                continue
            if not isinstance(item, Say):
                continue
            audio = self.say(item.text, reference=reference)
            start = cursor / SAMPLE_RATE
            pieces.append(audio)
            cursor += audio.size
            marks.append((item.text, round(start, 2), round(cursor / SAMPLE_RATE, 2)))

        if not pieces:
            return np.zeros(0, dtype=np.float32), marks
        return np.concatenate(pieces), marks
