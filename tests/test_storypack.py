"""The shared story pack: the per-user lineup and the clip order both clients mirror."""
import asyncio
import dataclasses

import pytest

from app import guardian, storypack
from app.storypack import (GREETINGS, INTROS, NOTES, clips_for, default_lineup, greeting_key,
                           lineup, total_seconds)
VOICE = "her_reference"


def _rows(section: str, ranks=(1, 2, 3, 4, 5), voice: str = VOICE) -> list[dict]:
    return [{"date": "2026-10-07", "section": section, "rank": r, "voice": voice,
             "duration": 30.0, "audio_path": f"stories/2026-10-07/{section}-{r}-{voice}.mp3"}
            for r in ranks]


def test_lineup_defaults_to_five_per_section():
    assert lineup(None) == {key: 5 for key in guardian.SECTIONS}
    assert default_lineup() == lineup({})


def test_lineup_clamps_and_ignores_rubbish():
    chosen = lineup({"stories": {"top": 3, "ai": 99, "tech": -2, "sports": "x", "nope": 4}})
    assert chosen["top"] == 3
    assert chosen["ai"] == 5      # clamped to the max
    assert chosen["tech"] == 0    # clamped to off
    assert chosen["sports"] == 0  # unparsable counts as off
    assert "nope" not in chosen   # only the seven known sections
    assert chosen["science"] == 5  # untouched sections keep the default


def test_clips_follow_section_order_then_rank_and_skip_zero_counts():
    rows = _rows("top") + _rows("sports") + _rows("ai")
    wanted = {key: 0 for key in guardian.SECTIONS}
    wanted.update({"ai": 2, "top": 1, "sports": 3})
    clips = clips_for(rows, wanted)
    assert [(c["section"], c["rank"]) for c in clips] == [
        ("top", 1), ("ai", 1), ("ai", 2), ("sports", 1), ("sports", 2), ("sports", 3)]
    assert total_seconds(clips) == 180.0


def test_clips_ignore_other_voices():
    rows = _rows("top") + _rows("top", voice="him_reference")
    clips = clips_for(rows, {"top": 5}, voice=VOICE)
    assert len(clips) == 5
    assert all(c["voice"] == VOICE for c in clips)


def test_no_sections_means_no_audio():
    assert clips_for(_rows("top"), {key: 0 for key in guardian.SECTIONS}) == []


def test_every_section_has_an_intro_to_voice():
    """A new section must not silently lose its spoken framing."""
    assert set(INTROS) == {f"intro_{key}" for key in guardian.SECTIONS}
    assert set(NOTES) == set(GREETINGS) | set(INTROS)


def test_the_greeting_follows_the_listeners_clock():
    assert greeting_key(0) == "greeting_morning"
    assert greeting_key(11) == "greeting_morning"
    assert greeting_key(12) == "greeting_afternoon"
    assert greeting_key(16) == "greeting_afternoon"
    assert greeting_key(17) == "greeting_evening"
    assert greeting_key(23) == "greeting_evening"


DAY = "2026-10-07"


def test_notes_are_reused_unless_forced(cfg, store, monkeypatch):
    """Re-running the pack must not pay for the same eight words again, but a new narrator has to."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test")
    for key, text in NOTES.items():
        store.tables.setdefault("voice_notes", []).append(
            {"date": DAY, "voice": "him_reference", "note_key": key, "text": text,
             "duration": 1.0, "audio_path": f"notes/{DAY}/{key}-him_reference.mp3"})

    spoken: list[str] = []

    async def fake_synthesise(client, base, text, voice, *args, **kwargs):
        spoken.append(text)
        return b"mp3\x00", 2.0

    monkeypatch.setattr(storypack, "synthesise", fake_synthesise)

    asyncio.run(storypack.build_notes(cfg, store, day=DAY, voice="him_reference"))
    assert spoken == []                      # unchanged text, so the recording stands

    asyncio.run(storypack.build_notes(cfg, store, day=DAY, voice="him_reference", force=True))
    assert spoken == [NOTES[key] for key in NOTES]   # a replaced reference clip re-reads them all


def test_build_forces_the_notes_along_with_the_stories(cfg, store, monkeypatch):
    """--force has to mean the whole briefing: framing in the old voice sounds broken."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test")
    seen: dict = {}

    async def fake_pack(per_section=5, sections=None, max_words=60):
        return []

    async def fake_notes(*args, **kwargs):
        seen.update(kwargs)
        return []

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "build_notes", fake_notes)

    asyncio.run(storypack.build(cfg, store, day=DAY, voice="him_reference", force=True))

    assert seen["force"] is True


SCRIPT = {"id": "a", "section": "top", "rank": 1, "title": "Rate held steady",
          "source": "The Guardian", "url": "https://example.test/1", "published": None,
          "image": None, "script": "The Bank of Canada held its key rate steady this morning."}


def _one_story(monkeypatch, seconds: float = 3.0):
    async def fake_pack(per_section=5, sections=None, max_words=60):
        return [SCRIPT]

    async def fake_synthesise(client, base, text, voice, *args, **kwargs):
        return b"mp3\x00", seconds

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "synthesise", fake_synthesise)


def test_a_finished_day_is_marked_playable(cfg, store, monkeypatch):
    """Clients refuse a day without this marker, so a half-rendered pack never reaches a listener."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test")
    _one_story(monkeypatch)

    assert not storypack.ready(store, day=DAY, voice="him_reference")
    asyncio.run(storypack.build(cfg, store, day=DAY, voice="him_reference"))

    assert storypack.ready(store, day=DAY, voice="him_reference")
    marker = [n for n in store.tables["voice_notes"] if n["note_key"] == storypack.PACK_READY][0]
    assert marker["text"] == "1 clip, 10 notes"
    assert (marker["date"], marker["voice"]) == (DAY, "him_reference")


def test_a_forced_re_render_takes_the_day_off_the_air_first(cfg, store, monkeypatch, ):
    """While a narrator is being re-recorded, the old clips must stop being offered."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test")
    storypack.mark_ready(store, day=DAY, voice="him_reference", clips=35, notes=len(NOTES))
    assert storypack.ready(store, day=DAY, voice="him_reference")

    async def fake_pack(per_section=5, sections=None, max_words=60):
        return [SCRIPT]

    async def broken(client, base, text, voice, *args, **kwargs):
        raise RuntimeError("voice service is down")

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "synthesise", broken)

    with pytest.raises(RuntimeError):
        asyncio.run(storypack.build(cfg, store, day=DAY, voice="him_reference", force=True))

    assert not storypack.ready(store, day=DAY, voice="him_reference")
