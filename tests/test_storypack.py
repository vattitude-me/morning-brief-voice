"""The shared story pack: the per-user lineup and the clip order both clients mirror."""
from app import guardian
from app.storypack import clips_for, default_lineup, lineup, total_seconds

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
