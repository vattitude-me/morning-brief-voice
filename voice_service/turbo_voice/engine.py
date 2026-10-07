"""Chatterbox-Turbo on Apple Silicon.

The model is loaded once per process and a reference clip is embedded once, then
reused. ``prepare_conditionals()`` is the expensive part — doing it per span would
dominate a build — so it runs again only when the clip changes, which also makes
it cheap to switch voices between requests.

Turbo ignores ``cfg_weight``, ``exaggeration`` and ``min_p``; pacing is controlled
with temperature, top_p and the silence we insert ourselves.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

from .text import Pause, Say, parse

log = logging.getLogger(__name__)

SAMPLE_RATE = 24_000


def pick_device() -> str:
    """``mps`` on Apple Silicon, otherwise CPU."""
    try:
        import torch
    except ImportError:  # surfaced properly when the model loads
        return "cpu"
    return "mps" if torch.backends.mps.is_available() else "cpu"


class TurboVoice:
    """A Chatterbox-Turbo voice cloned from a reference clip."""

    def __init__(self, reference: Path | str | None = None, device: str | None = None):
        # The reference is optional so the service can start, report health and
        # list voices before one has been chosen.
        self.reference = Path(reference) if reference else None
        self.device = device or pick_device()
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

    def _condition(self, model, reference: Path) -> None:
        """Embed a reference clip — once, and again only when the clip changes."""
        if not reference.exists():
            raise FileNotFoundError(f"Reference clip not found: {reference}")
        key = (str(reference), reference.stat().st_mtime_ns)
        if self._prepared != key:
            log.info("Embedding reference voice %s", reference.name)
            model.prepare_conditionals(str(reference))
            self._prepared = key

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
