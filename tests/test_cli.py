"""The command line's own bits, mostly the parts that talk to the status row."""
from __future__ import annotations

import base64
import dataclasses

from app import push
from app.__main__ import _publish_key, _split, cmd_report
from app.storypack import NOTES, mark_ready


def test_the_key_clients_subscribe_with_is_the_one_we_sign_with(cfg, store):
    """A push is refused when the key in the status row is not the pair on this machine.

    That is exactly how notifications went quiet once: the key file was lost, a new pair was
    generated, and the row went on publishing the old public key, so every device was subscribed to
    a channel nothing could post to.
    """
    keys = push.load_keys(cfg)
    assert store.app_status().get("vapid_public_key") is None

    assert _publish_key(cfg, store) is True
    assert store.app_status()["vapid_public_key"] == keys["public_key"]

    # Already in step: nothing to write, and the rest of the status row is left alone.
    assert _publish_key(cfg, store) is False

    # The published key must be the public half of the key that sends.
    public = base64.urlsafe_b64decode(keys["public_key"] + "==")
    assert len(public) == 65 and public[0] == 4  # an uncompressed P-256 point


def test_the_published_key_survives_a_status_row_that_has_other_fields(cfg, store):
    """Clients read the whole row, so publishing a key must not drop the worker's fields."""
    store.set_app_status({"running": True, "step": "Voicing", "vapid_public_key": "stale"})

    _publish_key(cfg, store)

    assert store.app_status()["step"] == "Voicing"
    assert store.app_status()["vapid_public_key"] != "stale"


def test_readiness_names_the_narrators_that_are_missing(cfg, store):
    """This is what the 06:00 job reads to decide between a report and a retry."""
    cfg = dataclasses.replace(cfg, story_voices=("her_reference", "him_reference"))
    mark_ready(store, day="2026-10-08", voice="her_reference", clips=35, notes=len(NOTES))

    here, missing = _split(cfg, store, "2026-10-08", None)

    assert here == ["her_reference"]
    assert missing == ["him_reference"]


def test_a_report_that_cannot_reach_a_subscriber_still_returns_the_state(cfg, store, monkeypatch, capsys):
    """Sending is best effort; the exit code is about the day, not about the push service."""
    cfg = dataclasses.replace(cfg, story_voices=("him_reference",))
    monkeypatch.setattr("app.config.load", lambda: cfg)
    monkeypatch.setattr("app.__main__._store", lambda cfg: store)

    class Args:
        day = "2026-10-08"
        voice = None
        retry = False

    assert cmd_report(Args()) == 1
    assert "missing Mike" in capsys.readouterr().out

    mark_ready(store, day="2026-10-08", voice="him_reference", clips=35, notes=len(NOTES))
    assert cmd_report(Args()) == 0
