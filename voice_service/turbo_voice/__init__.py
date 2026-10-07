"""Chatterbox-Turbo voice service for Morning Brief v2.

``turbo_voice.text`` turns a script into speech spans and pauses;
``turbo_voice.engine`` voices them on Apple Silicon and joins them back together.
"""
from .engine import SAMPLE_RATE, TurboVoice, pick_device
from .text import DEFAULT_BEAT, MAX_PAUSE, Pause, Say, parse, plain, spans, tags

__all__ = [
    "TurboVoice",
    "pick_device",
    "SAMPLE_RATE",
    "DEFAULT_BEAT",
    "MAX_PAUSE",
    "parse",
    "spans",
    "plain",
    "tags",
    "Say",
    "Pause",
]
