"""The shared story pack: the per-user lineup and the clip order both clients mirror."""
import asyncio
import dataclasses

import pytest

from app import guardian, storypack
from app.fetcher import Item
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


def test_the_framing_is_a_greeting_intros_and_a_sign_off():
    """A new section must not silently lose its spoken framing, and a brief needs an ending."""
    assert set(INTROS) == {f"intro_{key}" for key in guardian.SECTIONS}
    assert set(NOTES) == set(GREETINGS) | set(INTROS) | {storypack.OUTRO_KEY}


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
    assert marker["text"] == "1 clip, 11 notes"
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


# --- one story a day --------------------------------------------------------------------------
# The Guardian runs the same article in more than one feed, so without this the day's brief can
# read its top story twice: once under Top stories and again under Sport.

GU = "https://www.theguardian.com"


def _item(title: str, url: str, section: str = "top") -> Item:
    return Item(title=title, url=url, source_id=1, source_name="The Guardian", section=section)


def test_a_story_two_feeds_carry_is_read_once_under_the_earlier_section():
    top = [_item("Bank of Canada holds its key rate", f"{GU}/business/2026/oct/08/rate"),
           _item("Storm warning for the west coast", f"{GU}/weather/2026/oct/08/storm")]
    sports = [_item("Bank of Canada holds its key rate", f"{GU}/business/2026/oct/08/rate#top"),
              _item("Final goes to penalties", f"{GU}/football/2026/oct/08/final")]

    picked = guardian.pick_unique({"top": top, "sports": sports}, per_section=5)

    assert [i.title for i in picked["top"]] == [
        "Bank of Canada holds its key rate", "Storm warning for the west coast"]
    assert [i.title for i in picked["sports"]] == ["Final goes to penalties"]


def test_the_same_headline_from_two_links_is_one_story():
    """Syndicated copies keep the headline and change the link, which the URL check alone misses."""
    picked = guardian.pick_unique({
        "top": [_item("Trudeau resigns", f"{GU}/world/2026/oct/08/trudeau")],
        "politics": [_item("Trudeau resigns", f"{GU}/politics/live/2026/oct/08/live-blog"),
                     _item("Budget vote tonight", f"{GU}/politics/2026/oct/08/budget")],
    }, per_section=5)
    assert [i.title for i in picked["politics"]] == ["Budget vote tonight"]


def test_a_section_losing_its_head_takes_the_next_candidate():
    """A section that gives a story away still gets its full count, from further down its feed."""
    top = [_item("Fire in the port", f"{GU}/a/1")]
    sports = [_item("Fire in the port", f"{GU}/a/1"), _item("Final goes to penalties", f"{GU}/sport/2"),
              _item("Injury doubt for the derby", f"{GU}/sport/3")]

    picked = guardian.pick_unique({"top": top, "sports": sports}, per_section=2)

    assert [i.title for i in picked["sports"]] == ["Final goes to penalties", "Injury doubt for the derby"]


def test_a_section_that_only_has_repeats_stays_short():
    """Better a four-story section than the same headline twice in one brief."""
    top = [_item("One big story", f"{GU}/a/1")]
    tech = [_item("One big story", f"{GU}/a/1")]
    assert guardian.pick_unique({"top": top, "tech": tech}, per_section=5)["tech"] == []


# --- one day of audio -------------------------------------------------------------------------

YESTERDAY = "2026-10-06"


def _old_day(store, day: str, voice: str) -> None:
    """A published day, rows and files, as the pack leaves it behind."""
    path = f"stories/{day}/top-1-{voice}.mp3"
    store.insert("story_audio", {"date": day, "section": "top", "rank": 1, "voice": voice,
                                 "duration": 30.0, "audio_path": path, "title": "A story"})
    store.upload(path, b"mp3")
    for key in NOTES:
        note = f"notes/{day}/{key}-{voice}.mp3"
        store.insert("voice_notes", {"date": day, "voice": voice, "note_key": key, "text": NOTES[key],
                                     "duration": 2.0, "audio_path": note})
        store.upload(note, b"mp3")
    storypack.mark_ready(store, day=day, voice=voice, clips=1, notes=len(NOTES))


def _yesterday_is_gone(store) -> bool:
    return (not store.select("story_audio", {"date": f"eq.{YESTERDAY}"})
            and not store.select("voice_notes", {"date": f"eq.{YESTERDAY}"})
            and not [p for p in store.objects if p.startswith(f"stories/{YESTERDAY}/")]
            and not [p for p in store.objects if p.startswith(f"notes/{YESTERDAY}/")])


def test_the_old_day_goes_once_the_new_one_is_whole(cfg, store, monkeypatch):
    """Yesterday's audio is deleted, rows and files, when today is complete for every narrator."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test",
                              story_voices=("her_reference", "him_reference"))
    _one_story(monkeypatch)
    for voice in cfg.story_voices:
        _old_day(store, YESTERDAY, voice)

    asyncio.run(storypack.build(cfg, store, day=DAY))

    assert storypack.ready(store, day=DAY, voice="her_reference")
    assert storypack.ready(store, day=DAY, voice="him_reference")
    assert _yesterday_is_gone(store), "the previous day should not survive a complete morning"


def test_a_failed_morning_keeps_yesterday(cfg, store, monkeypatch):
    """A listener whose morning failed falls back to yesterday, so it has to still be there."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test",
                              story_voices=("her_reference", "him_reference"))
    for voice in cfg.story_voices:
        _old_day(store, YESTERDAY, voice)

    async def fake_pack(per_section=5, sections=None, max_words=60):
        return [SCRIPT]

    async def broken(client, base, text, voice, *args, **kwargs):
        raise RuntimeError("voice service is down")

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "synthesise", broken)

    with pytest.raises(RuntimeError):
        asyncio.run(storypack.build(cfg, store, day=DAY))

    assert store.select("story_audio", {"date": f"eq.{YESTERDAY}"})
    assert not _yesterday_is_gone(store)


def test_one_narrator_finishing_does_not_drop_the_other_day(cfg, store, monkeypatch):
    """Today is only whole when every narrator has it, which is the condition for a deletion."""
    cfg = dataclasses.replace(cfg, voice_url="http://voice.test",
                              story_voices=("her_reference", "him_reference"))
    _one_story(monkeypatch)
    for voice in cfg.story_voices:
        _old_day(store, YESTERDAY, voice)

    # Only one of the two narrators gets rendered today.
    asyncio.run(storypack.build(cfg, store, day=DAY, voice="him_reference"))

    assert not storypack.ready(store, day=DAY, voice="her_reference")
    assert store.select("story_audio", {"date": f"eq.{YESTERDAY}"}), "yesterday must wait for the day to be whole"


# --- telling someone what happened ---------------------------------------------------------

def _pushes(monkeypatch) -> list[tuple[str, str, int]]:
    from app import push

    sent: list[tuple[str, str, int]] = []

    def fake_send(cfg, subs, title, body):
        sent.append((title, body, len(subs)))
        return len(subs), []

    monkeypatch.setattr(push, "send", fake_send)
    return sent


def test_a_ready_day_tells_the_listeners_and_the_admin(cfg, store, monkeypatch):
    sent = _pushes(monkeypatch)
    store.subs = [{"endpoint": "https://push.test/a", "user_id": "u-1"}]
    store.profiles_.append({"id": "u-1", "email": cfg.admin_emails[0], "is_admin": True})

    storypack.notify_listeners(cfg, store, title="☀️ Your Morning Brief is ready", body="Top story.")
    storypack.notify_admins(cfg, store, title="✓ Morning Brief ready: Alice", body=f"{DAY} is complete.")

    assert sent[0][2] == 1 and "ready" in sent[0][0]
    assert sent[1][2] == 1 and "ready" in sent[1][0]


def test_a_failed_push_does_not_break_the_render(cfg, store, monkeypatch):
    """Notifications are a nicety: the pack must survive a push service that is down."""
    from app import push

    def boom(cfg, subs, title, body):
        raise RuntimeError("push service is down")

    monkeypatch.setattr(push, "send", boom)
    assert storypack.notify_listeners(cfg, store, title="x", body="y") == 0
    assert storypack.notify_admins(cfg, store, title="x", body="y") == 0


# --- the run log: what the admin page reads when the phone was never told ----------------------

def test_a_failed_morning_reaches_the_run_log_even_when_the_push_does_not(cfg, store, monkeypatch):
    """A phone can be asleep, out of data or signed out. The database cannot."""
    from app import push

    def boom(cfg, subs, title, body):
        raise RuntimeError("push service is down")

    monkeypatch.setattr(push, "send", boom)

    storypack.notify_admins(cfg, store, day=DAY, status="failed", title="✗ Morning Brief failed",
                            body="RuntimeError: voice service is down",
                            detail="RuntimeError: voice service is down")

    row = store.tables["run_log"][0]
    assert (row["run_date"], row["status"], row["title"]) == (DAY, "failed", "✗ Morning Brief failed")
    assert "voice service is down" in row["detail"]


def test_the_run_log_names_each_narrator(cfg, store, monkeypatch):
    sent = _pushes(monkeypatch)
    store.subs = [{"endpoint": "https://push.test/a", "user_id": "u-1"}]
    store.profiles_.append({"id": "u-1", "email": cfg.admin_emails[0], "is_admin": True})

    storypack.notify_admins(cfg, store, day=DAY, status="incomplete", title="✗ incomplete: Mike",
                            body="Ready for Alice.", voices=[
                                {"id": "her_reference", "name": "Alice", "ready": True},
                                {"id": "him_reference", "name": "Mike", "ready": False}])

    assert sent  # the push still goes
    voices = store.tables["run_log"][0]["voices"]
    assert [(v["name"], v["ready"]) for v in voices] == [("Alice", True), ("Mike", False)]


def test_a_missing_run_log_table_does_not_break_a_morning(cfg, store, monkeypatch):
    """The table is created by hand in the SQL editor, so it may not be there on the first run."""
    def boom(table, values, on_conflict=None):
        raise RuntimeError('relation "run_log" does not exist')

    monkeypatch.setattr(store, "insert", boom)
    assert storypack.record(store, day=DAY, status="ok", title="✓ ready") is False
    assert storypack.notify_admins(cfg, store, day=DAY, status="ok", title="✓ ready", body="") == 0


def test_the_run_log_outlives_the_audio_by_a_fortnight(cfg, store):
    """The audio is one day deep; the record of what happened is what the admin reads."""
    for day in ("2026-09-01", "2026-10-01", DAY):
        storypack.record(store, day=day, status="ok", title="✓ ready")

    storypack.prune_older(store, keep=DAY)

    assert [r["run_date"] for r in store.tables["run_log"]] == ["2026-10-01", DAY]

