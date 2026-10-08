from __future__ import annotations

import dataclasses
from pathlib import Path

import httpx
import numpy as np
import pytest

from app import fetcher, tts
from app.config import Config
from app.tts import SAMPLE_RATE, Voice

from . import fakenews

BASE = "https://sample.news"


class ToneEngine:
    """Deterministic stand-in for a neural voice: 0.05 s of tone per word."""

    name = "fake"

    def status(self):
        return True, ""

    def voices(self):
        return [Voice("fake:tone", "fake", "Tone", "Test", "none", "test voice")]

    def synthesize(self, text, voice, speed=1.0):
        n = int(len(text.split()) * 0.05 * SAMPLE_RATE / speed)
        t = np.arange(n) / SAMPLE_RATE
        return (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


@pytest.fixture(autouse=True)
def fake_network(monkeypatch):
    transport = httpx.MockTransport(fakenews.handler(BASE))

    def make_client(timeout: float = 20.0):
        return httpx.AsyncClient(transport=transport, follow_redirects=True, timeout=timeout)

    monkeypatch.setattr(fetcher, "make_client", make_client)
    monkeypatch.setattr("app.weather.forecast", lambda *a, **k: {
        "city": "Toronto", "now": 12, "high": 17, "low": 8, "code": 1, "conditions": "mostly clear skies", "precip": 10,
    })
    tts.register(ToneEngine())
    yield


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    c = dataclasses.replace(
        Config(), data_dir=tmp_path, model_dir=tmp_path / "models", groq_api_key=None,
        supabase_url="https://proj.supabase.co", supabase_secret_key="sb_secret_test",
        allow_private_urls=True, admin_emails=("admin@example.com",), admin_notify="issues",
    )
    c.ensure_dirs()
    return c


class FakeStore:
    """In-memory stand-in for app.store.Store with the same methods the worker uses."""

    url = "https://proj.supabase.co"

    def __init__(self):
        self.profiles_ = []
        self.sources_ = []
        self.briefings_ = {}      # (user_id, date) -> row
        self.objects = {}         # path -> bytes
        self.subs = []
        self.requests = []
        self.status = {}
        self.source_updates = []
        self.tables = {}          # table name -> rows, for the shared story pack

    # helpers used by tests
    def add_user(self, email, **settings):
        uid = f"u-{len(self.profiles_) + 1}"
        self.profiles_.append({"id": uid, "email": email, "is_admin": False, "feed_token": f"tok{uid}",
                               "settings": {"voice": "fake:tone", **settings}, "status": {}})
        return uid

    def add_source(self, user_id, name, url, section, kind="feed", feed_url=None, **extra):
        row = {"id": len(self.sources_) + 1, "user_id": user_id, "name": name, "url": url,
               "feed_url": feed_url if feed_url is not None else (url if kind == "feed" else None),
               "kind": kind, "section": section, "enabled": True, "weight": 1.0,
               "last_status": None, "consumed_at": None, **extra}
        self.sources_.append(row)
        return row

    def source(self, sid):
        return next(s for s in self.sources_ if s["id"] == sid)

    # Store API
    @staticmethod
    def _in(values):
        return "in.(" + ",".join(f'"{v}"' for v in values) + ")"

    @staticmethod
    def _match(row, params):
        for key, cond in params.items():
            if key in ("select", "order"):
                continue
            op, _, val = cond.partition(".")
            have = str(row.get(key))
            if op == "eq" and have != val:
                return False
            if op == "lt" and not have < val:
                return False
            if op == "in" and have not in [v.strip('"') for v in val.strip("()").split(",")]:
                return False
        return True

    def profiles(self):
        return [dict(p) for p in self.profiles_]

    def set_admins(self, emails):
        for p in self.profiles_:
            if p["email"] in emails:
                p["is_admin"] = True

    def set_profile_status(self, uid, status):
        next(p for p in self.profiles_ if p["id"] == uid)["status"] = status

    def sources(self):
        return [dict(s) for s in self.sources_]

    def seed_builtins(self, builtins):
        pass

    def update_source(self, sid, values):
        self.source_updates.append((sid, values))
        self.source(sid).update(values)

    # Generic table access, for the tables the story pack writes itself.
    def select(self, table, params=None):
        return [dict(r) for r in self.tables.get(table, []) if self._match(r, params or {})]

    def insert(self, table, values, on_conflict=None):
        rows = self.tables.setdefault(table, [])
        keys = [k.strip() for k in on_conflict.split(",")] if on_conflict else []
        for row in rows:
            if keys and all(str(row.get(k)) == str(values.get(k)) for k in keys):
                row.update(values)
                return
        rows.append(dict(values))

    def update(self, table, params, values):
        for row in self.tables.get(table, []):
            if self._match(row, params):
                row.update(values)

    def reset_consumed(self, user_ids, since):
        for s in self.sources_:
            if s["user_id"] in user_ids and s["consumed_at"] and s["consumed_at"] >= since:
                s["consumed_at"] = None

    def upsert_briefing(self, uid, day, data, audio_path):
        self.briefings_[(uid, day)] = {"user_id": uid, "date": day, "data": data, "audio_path": audio_path}

    def briefings(self, params):
        return [dict(r) for r in self.briefings_.values() if self._match(r, params)]

    def recent_stories(self, user_ids, since, before):
        return [{"user_id": r["user_id"], "date": r["date"], "stories": r["data"].get("stories")}
                for r in self.briefings_.values() if r["user_id"] in user_ids and since <= r["date"] < before]

    def delete_briefings(self, rows):
        for r in rows:
            self.objects.pop(r["audio_path"], None)
            self.briefings_.pop((r["user_id"], r["date"]), None)

    def push_subscriptions(self, user_ids=None):
        return [s for s in self.subs if user_ids is None or s["user_id"] in user_ids]

    def delete_push_subscription(self, endpoint):
        self.subs = [s for s in self.subs if s["endpoint"] != endpoint]

    def delete_user(self, uid):
        # Mirrors the cascade from auth.users.
        self.profiles_ = [p for p in self.profiles_ if p["id"] != uid]
        self.sources_ = [s for s in self.sources_ if s["user_id"] != uid]
        self.briefings_ = {k: v for k, v in self.briefings_.items() if k[0] != uid}
        self.subs = [s for s in self.subs if s.get("user_id") != uid]
        self.requests = [r for r in self.requests if r["user_id"] != uid]

    def pending_requests(self):
        return [r for r in self.requests if r["status"] == "queued"]

    def update_request(self, rid, values):
        next(r for r in self.requests if r["id"] == rid).update(values)

    def set_app_status(self, data):
        self.status = dict(data)

    def app_status(self):
        return dict(self.status)

    def public_url(self, path):
        return f"{self.url}/storage/v1/object/public/briefings/{path}"

    def upload(self, path, data, content_type="audio/mpeg", cache="max-age=3600"):
        self.objects[path] = data
        return self.public_url(path)

    def copy(self, source, destination):
        assert destination not in self.objects, "Supabase refuses to copy over an existing file"
        self.objects[destination] = self.objects[source]
        return self.public_url(destination)

    def list_objects(self, prefix):
        return [p for p in self.objects if p.startswith(prefix.rstrip("/") + "/")]

    def remove_objects(self, paths):
        for p in paths:
            self.objects.pop(p, None)


@pytest.fixture
def store():
    s = FakeStore()
    for key, section in (("canada", "canada"), ("canada2", "canada"), ("tech", "tech")):
        s.add_source(None, fakenews.SOURCE_NAMES[key], f"{BASE}/{key}/feed.xml", section)
    return s
