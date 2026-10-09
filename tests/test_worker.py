from __future__ import annotations

import dataclasses

from app import guardian, storypack
from app.worker import Worker


def test_delete_account_removes_audio_and_every_row(cfg, store):
    keep = store.add_user("keep@example.com")
    gone = store.add_user("gone@example.com")
    store.add_source(gone, "My blog", "https://blog.example/feed", "custom")
    store.upload(f"toku-{gone[-1]}/2026-10-01.mp3", b"mp3")
    store.upload(f"toku-{keep[-1]}/2026-10-01.mp3", b"mp3")
    store.upsert_briefing(gone, "2026-10-01", {}, f"toku-{gone[-1]}/2026-10-01.mp3")
    store.requests.append({"id": 1, "user_id": gone, "kind": "delete_account", "status": "queued"})

    Worker(cfg, store).poll_requests()

    assert [p["id"] for p in store.profiles()] == [keep]
    assert not any(s["user_id"] == gone for s in store.sources_)
    assert not any(k[0] == gone for k in store.briefings_)
    assert list(store.objects) == [f"toku-{keep[-1]}/2026-10-01.mp3"]
    assert store.requests == []


def test_failed_delete_is_reported_and_keeps_the_account(cfg, store, monkeypatch):
    uid = store.add_user("me@example.com")
    store.requests.append({"id": 1, "user_id": uid, "kind": "delete_account", "status": "queued"})

    def boom(_uid):
        raise RuntimeError("auth admin unavailable")

    monkeypatch.setattr(store, "delete_user", boom)
    Worker(cfg, store).poll_requests()

    assert [p["id"] for p in store.profiles()] == [uid]
    assert store.requests[0]["status"] == "error"
    assert "auth admin unavailable" in store.requests[0]["message"]


SCRIPT = {"id": "a", "section": "top", "rank": 1, "title": "Rate held steady",
          "source": "The Guardian", "url": "https://example.test/1", "published": None,
          "image": None, "script": "The Bank of Canada held its key rate steady this morning."}


def test_admin_rebuilds_the_pack_from_the_admin_page(cfg, store, monkeypatch):
    uid = store.add_user("boss@example.com")
    store.set_admins(["boss@example.com"])
    store.requests.append({"id": 1, "user_id": uid, "kind": "pack", "status": "queued",
                           "payload": {"day": "2026-10-07", "voices": ["her_reference"]}})

    async def fake_pack(per_section=5, sections=None, max_words=60):
        return [SCRIPT]

    async def fake_synthesise(client, base, text, voice, *args, **kwargs):
        return b"mp3\\x00", 4.0

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "synthesise", fake_synthesise)

    published = []
    keep_status = store.set_app_status
    monkeypatch.setattr(store, "set_app_status", lambda data: (published.append(dict(data)), keep_status(data)))

    Worker(dataclasses.replace(cfg, voice_url="http://voice.test"), store).poll_requests()

    assert store.requests[0]["status"] == "done"
    assert "1 clips for 2026-10-07" in store.requests[0]["message"]
    clip = store.tables["story_audio"][0]
    assert (clip["date"], clip["voice"], clip["section"], clip["rank"]) == ("2026-10-07", "her_reference", "top", 1)
    assert clip["duration"] == 4.0
    assert store.tables["voice_notes"], "the greeting and intros ride along with a rebuild"
    assert store.status["last_pack"]["ok"] is True
    assert store.status["running"] is False
    assert store.status["progress"] == 1
    # The admin watches these lines while a long rebuild runs.
    assert any(step == "Alice: top #1" for step in (row.get("step") for row in published))
    # A rebuild from the page lands in the same log as the nightly run.
    entry = store.tables["run_log"][0]
    assert (entry["run_date"], entry["status"]) == ("2026-10-07", "ok")
    assert "boss@example.com" in entry["detail"]
    assert entry["voices"] == [{"id": "her_reference", "name": "Alice", "ready": True}]


def test_a_failed_rebuild_is_recorded_and_reported(cfg, store, monkeypatch):
    uid = store.add_user("boss@example.com")
    store.set_admins(["boss@example.com"])
    store.requests.append({"id": 1, "user_id": uid, "kind": "pack", "status": "queued",
                           "payload": {"day": "2026-10-07", "voices": ["her_reference"]}})

    async def fake_pack(per_section=5, sections=None, max_words=60):
        return [SCRIPT]

    async def broken(client, base, text, voice, *args, **kwargs):
        raise RuntimeError("voice service is down")

    monkeypatch.setattr(guardian, "build_pack", fake_pack)
    monkeypatch.setattr(storypack, "synthesise", broken)

    Worker(dataclasses.replace(cfg, voice_url="http://voice.test"), store).poll_requests()

    assert store.requests[0]["status"] == "error"
    entry = store.tables["run_log"][0]
    assert (entry["run_date"], entry["status"], entry["title"]) == ("2026-10-07", "failed", "✗ Rebuild failed")
    assert "voice service is down" in entry["body"]


def test_pack_request_from_a_customer_is_refused(cfg, store):
    uid = store.add_user("reader@example.com")
    store.requests.append({"id": 1, "user_id": uid, "kind": "pack", "status": "queued", "payload": {}})

    Worker(cfg, store).poll_requests()

    assert store.requests[0]["status"] == "error"
    assert "Only admins can rebuild the audio" in store.requests[0]["message"]
    assert not store.tables.get("story_audio")
