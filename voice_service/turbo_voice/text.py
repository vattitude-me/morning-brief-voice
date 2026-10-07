"""Turn a news script into speech spans and pauses.

Chatterbox's own ``punc_norm()`` rewrites "…" to ", " and "—" to "-", so
punctuation alone can never produce a real beat of silence. The script is
therefore split into speech spans and explicit pauses, each span is synthesised
on its own, and the pieces are joined with silence — the same "voice each beat,
then stitch" approach the v1 briefing uses.

Two things reach the model untouched:

* paralinguistic tags such as ``[sigh]``, ``[chuckle]``, ``[cough]``, ``[laugh]``
* ordinary punctuation, which the model reads and paces well

Pause syntax::

    [[pause:0.8]]   a pause of that many seconds
    ...  or  …      a beat, using the caller's default

``[sigh]`` and friends are left in the text on purpose: the model was trained on
them and performs the sound itself, which sounds far more human than the same
breath synthesised as noise.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# The paralinguistic tags Chatterbox is trained on. Anything else in square
# brackets is passed through as literal text rather than silently swallowed, so a
# typo shows up in the audio instead of disappearing.
TAGS = frozenset({"sigh", "chuckle", "laugh", "cough", "gasp", "groan", "sniffle", "yawn"})

_PAUSE = re.compile(r"\[\[\s*pause\s*:\s*(\d+(?:\.\d+)?)\s*\]\]", re.I)
_ELLIPSIS = re.compile(r"\s*(?:\.\.\.+|…)\s*")
_PARAGRAPH = re.compile(r"\n\s*\n+")
_BRACKET = re.compile(r"\[([^\[\]]{1,24})\]")
_SPACE = re.compile(r"\s+")
_MARK = "\x00"

DEFAULT_BEAT = 0.45
MAX_PAUSE = 5.0


@dataclass(frozen=True)
class Say:
    """A span of text to voice."""

    text: str


@dataclass(frozen=True)
class Pause:
    """Silence to leave before the next span."""

    seconds: float


def _tidy(text: str) -> str:
    return _SPACE.sub(" ", text).strip()


def parse(text: str, *, beat: float = DEFAULT_BEAT) -> list[Say | Pause]:
    """Split ``text`` into alternating speech spans and pauses.

    Adjacent pauses are summed and leading or trailing pauses dropped, so the
    result always begins and ends with something to say.
    """
    text = (text or "").strip()
    if not text:
        return []

    # Unify every "pause here" spelling behind one sentinel, prefixed so a span
    # that happens to be all digits ("2026") is never mistaken for a duration.
    # A blank line is a paragraph break, which reads as a beat of its own.
    text = _PARAGRAPH.sub(f"{_MARK}p:{beat}{_MARK}", text)
    text = _PAUSE.sub(lambda m: f"{_MARK}p:{m.group(1)}{_MARK}", text)
    text = _ELLIPSIS.sub(f"{_MARK}p:{beat}{_MARK}", text)

    out: list[Say | Pause] = []
    for part in text.split(_MARK):
        part = _tidy(part)
        if not part:
            continue
        if part.startswith("p:"):
            seconds = min(float(part[2:]), MAX_PAUSE)
            if seconds <= 0:
                continue
            if out and isinstance(out[-1], Pause):
                out[-1] = Pause(round(out[-1].seconds + seconds, 3))
            else:
                out.append(Pause(seconds))
        else:
            out.append(Say(part))

    while out and isinstance(out[0], Pause):
        out.pop(0)
    while out and isinstance(out[-1], Pause):
        out.pop()
    return out


def spans(text: str, *, beat: float = DEFAULT_BEAT) -> list[str]:
    """Just the text that will be voiced, for previews and card copy."""
    return [item.text for item in parse(text, beat=beat) if isinstance(item, Say)]


def tags(text: str) -> list[str]:
    """Bracketed tokens that are not tags we know, so callers can warn."""
    text = _PAUSE.sub(" ", text or "")
    return [t for t in _BRACKET.findall(text) if t.strip().lower() not in TAGS]


def plain(text: str) -> str:
    """The script without pause markers or tags: what a card should display."""
    text = _PAUSE.sub(" ", text or "")
    return _tidy(_BRACKET.sub(" ", text))
