"""The pause and tag layer: pure logic, no model needed."""
from __future__ import annotations

from turbo_voice import DEFAULT_BEAT, MAX_PAUSE, Pause, Say, parse, plain, spans, tags


def pauses(text: str) -> list[float]:
    return [item.seconds for item in parse(text) if isinstance(item, Pause)]


def kinds(text: str) -> list[str]:
    return [type(item).__name__ for item in parse(text)]


def test_plain_sentence_is_a_single_span():
    assert kinds("Hello there.") == ["Say"]


def test_blank_line_is_a_beat():
    assert kinds("One.\n\nTwo.") == ["Say", "Pause", "Say"]
    assert pauses("One.\n\nTwo.") == [DEFAULT_BEAT]


def test_explicit_pause_uses_its_seconds():
    assert pauses("One. [[pause:1.5]] Two.") == [1.5]


def test_ellipsis_is_a_beat():
    assert pauses("One... Two.") == [DEFAULT_BEAT]
    assert pauses("One… Two.") == [DEFAULT_BEAT]


def test_adjacent_pauses_are_summed():
    assert pauses("One...\n\nTwo.") == [round(DEFAULT_BEAT * 2, 3)]


def test_long_pause_is_clamped():
    assert pauses("One. [[pause:99]] Two.") == [MAX_PAUSE]


def test_leading_and_trailing_pauses_are_dropped():
    assert kinds("...One.") == ["Say"]
    assert kinds("One...") == ["Say"]


def test_tags_reach_the_model_untouched():
    (only,) = parse("Well, [sigh] fine.")
    assert isinstance(only, Say)
    assert "[sigh]" in only.text


def test_unknown_tags_are_reported_but_known_ones_are_not():
    assert tags("Hi [chortle] there") == ["chortle"]
    assert tags("Hi [sigh] there") == []
    assert tags("Wait [[pause:0.5]] here") == []


def test_numbers_are_not_mistaken_for_pauses():
    assert spans("In 2026 we won.") == ["In 2026 we won."]


def test_plain_strips_markers_and_tags():
    assert plain("Hi [[pause:0.5]] [sigh] there") == "Hi there"


def test_empty_input_has_no_spans():
    assert parse("   ") == []
    assert spans("") == []


def test_whitespace_is_tidied_within_a_span():
    assert spans("Hello    \n  world.") == ["Hello world."]
