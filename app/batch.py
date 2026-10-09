"""The nightly batch: one briefing per user, built from shared work.

    fetch every source once → rank per user → read the chosen articles once →
    write copy once per story → voice each segment once → assemble, upload and notify per user

Everything that can go wrong is recorded in a RunReport: users see what affected
their briefing, the admin gets a push with the details.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable
from zoneinfo import ZoneInfo

import numpy as np

from . import audio, fetcher, push, tts, weather
from .config import Config
from .fetcher import FetchError, Item, check_public_url, detect, enrich_items, fetch_all
from .ranking import Story, select_top
from .report import MESSAGES, RunReport
from .sources import BUILTIN_SOURCES, DEFAULT_STORIES, SECTIONS, local_sources
from .store import Store, StoreError, cutoff, now_iso
from .writer import StoryCopy, StoryWriter, compose

log = logging.getLogger(__name__)

Progress = Callable[[str, float], None]

DEFAULT_SETTINGS = {
    "name": "",
    "voice": "kokoro:af_heart",
    "speed": 1.0,
    "daily": True,
    "stories": DEFAULT_STORIES,
    "city": "Toronto",
    "news_city": "",          # local news; empty = the weather city
    "latitude": 43.6532,
    "longitude": -79.3832,
    "weather": True,
    "say_sources": False,     # credit each story's outlet out loud
    "disabled_sources": [],   # ids of built-in sources this user switched off
}
BACKUP_VOICE = "edge:en-CA-ClaraNeural"
CACHE_DAYS = 3
# The landing-page demo: a public copy of the admin's latest briefing (no separate build).
SHOWCASE_DIR = "showcase"
# Stories told in briefings from this many days back aren't told again.
HEARD_DAYS = 2
BEAT_PAUSE = 0.4       # seconds between the beats of a story, longer than the voice's own sentence gap


def settings_for(profile: dict) -> dict:
    stored = profile.get("settings") or {}
    merged = {**DEFAULT_SETTINGS, **stored}
    merged["stories"] = {**DEFAULT_SETTINGS["stories"], **(stored.get("stories") or {})}
    for k in SECTIONS:
        merged["stories"][k] = max(0, min(10, int(merged["stories"].get(k) or 0)))
    try:
        merged["speed"] = max(0.7, min(1.4, float(merged["speed"])))
    except (TypeError, ValueError):
        merged["speed"] = 1.0
    return merged


def _log_progress(step: str, fraction: float) -> None:
    log.info("[%3d%%] %s", int(fraction * 100), step)


@dataclass
class UserPlan:
    profile: dict
    settings: dict
    sources: list[dict]
    picked: dict[str, list[Story]] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.profile["id"]

    @property
    def email(self) -> str:
        return self.profile.get("email") or self.id[:8]


@dataclass
class Result:
    profile: dict
    briefing: dict | None = None
    error: str | None = None


class Batch:
    def __init__(self, cfg: Config, store: Store, report: RunReport, *, progress: Progress = _log_progress,
                 writer: StoryWriter | None = None, notify: bool = True):
        self.cfg = cfg
        fetcher.ALLOW_PRIVATE = cfg.allow_private_urls
        self.store = store
        self.report = report
        self.progress = progress
        self.writer = writer or StoryWriter(
            cfg.cache_dir,
            report,
            api_key=cfg.groq_api_key,
            models=cfg.groq_models,
            gemini_api_key=cfg.gemini_api_key,
            gemini_models=cfg.gemini_models,
        )
        self.notify = notify
        self.tz = ZoneInfo(cfg.timezone)
        self.tts_cache = cfg.cache_dir / "tts"
        self.tts_cache.mkdir(parents=True, exist_ok=True)

    # ================================================================== entry
    def run(self, *, emails: list[str] | None = None, fresh: bool = False, scheduled: bool = True) -> list[Result]:
        """Build briefings. `emails` limits the run to those users; scheduled runs skip users with daily off."""
        now = datetime.now(self.tz)
        day = now.date().isoformat()
        results: list[Result] = []
        try:
            profiles = self.store.profiles()
            all_sources = self.store.sources()
        except StoreError as exc:
            self.report.add("supabase_down", str(exc), level="error")
            return results

        if emails is not None:
            wanted = {e.lower() for e in emails}
            profiles = [p for p in profiles if (p.get("email") or "").lower() in wanted or p["id"] in wanted]
            missing = wanted - {(p.get("email") or "").lower() for p in profiles} - {p["id"] for p in profiles}
            if missing:
                log.warning("No such user(s): %s", ", ".join(sorted(missing)))
        elif scheduled:
            profiles = [p for p in profiles if settings_for(p).get("daily", True)]
        if not profiles:
            log.info("No users to build for")
            return results

        if fresh and profiles:
            self._fresh(profiles, now)
            try:
                all_sources = self.store.sources()  # articles used today are queued again
            except StoreError as exc:
                self.report.add("supabase_down", str(exc), level="error")
                return results

        # 1. Work out each user's sources, checking any new links first ----------------
        self.progress("Checking new links", 0.02)
        self._detect_new(all_sources, {p["id"] for p in profiles})
        plans = [self._plan(p, all_sources) for p in profiles]

        # 2. Fetch every source once ----------------------------------------------------
        self.progress("Gathering today's headlines", 0.05)
        unique = {s["id"]: s for plan in plans for s in plan.sources}
        items, statuses = asyncio.run(fetch_all(list(unique.values()))) if unique else ([], {})
        self._record_statuses(unique, items, statuses)
        by_source: dict[int, list[Item]] = {}
        for it in items:
            by_source.setdefault(it.source_id, []).append(it)

        # 3. Rank per user, then read every chosen article once ---------------------------
        self.progress("Picking the top stories", 0.15)
        heard = self._heard([p.id for p in plans], now.date())
        for plan in plans:
            failed = [s for s in plan.sources if s["user_id"] and statuses.get(s["id"], "ok") != "ok"]
            if failed:
                self.report.add("sources_failed", ", ".join(f"{s['name']}: {statuses[s['id']]}" for s in failed)[:300],
                                user_id=plan.id)
            user_items = [it for s in plan.sources for it in by_source.get(s["id"], [])]
            limits = {k: plan.settings["stories"].get(k, 0) for k in SECTIONS}
            plan.picked = select_top(user_items, limits, heard=heard.get(plan.id)) if user_items else {}

        stories: dict[str, tuple[str, Story]] = {}
        for plan in plans:
            for section, group in plan.picked.items():
                for s in group:
                    stories.setdefault(s.id, (section, s))
        self.progress("Reading the full articles", 0.22)
        if stories:
            asyncio.run(enrich_items([s.lead for _, s in stories.values()]))

        # 4. Write copy once per story -----------------------------------------------
        copies: dict[str, StoryCopy] = {}
        for n, (section, story) in enumerate(stories.values()):
            self.progress("Writing summaries", 0.3 + 0.2 * n / max(1, len(stories)))
            copies[story.id] = self.writer.copy(section, story)  # after enrich: a Google News link is now the article's

        # 5. Per user: voice, assemble, upload, notify ----------------------------------
        weather_cache: dict[tuple, dict | None] = {}
        for n, plan in enumerate(plans):
            self.progress(f"Recording briefing {n + 1} of {len(plans)}", 0.5 + 0.45 * n / len(plans))
            results.append(self._build_user(plan, copies, statuses, weather_cache, now, day))
        self._publish_showcase(results, day)

        # 6. Tidy up -----------------------------------------------------------------
        self.progress("Clearing old briefings", 0.97)
        self._cleanup(now)
        self.report.finished_at = now_iso()
        return results

    # ================================================================ sources
    def _detect_new(self, all_sources: list[dict], user_ids: set[str]) -> None:
        """Links added in the app arrive as kind 'auto': find out what they are (feed, page or article)."""
        for src in all_sources:
            if src["kind"] != "auto" or src["user_id"] not in user_ids or not src["enabled"]:
                continue
            try:
                found = asyncio.run(detect(src["url"], self.cfg.allow_private_urls))
            except Exception as exc:  # noqa: BLE001
                msg = str(exc) if isinstance(exc, FetchError) else f"Couldn't open that link ({exc.__class__.__name__})"
                src["last_status"] = msg
                self._update_source(src["id"], {"last_status": msg, "last_fetched_at": now_iso()})
                continue
            values = {"kind": found.kind, "feed_url": found.feed_url}
            if found.name and src["name"] in (src["url"], ""):
                values["name"] = found.name[:200]
            src.update(values)
            self._update_source(src["id"], values)

    def _plan(self, profile: dict, all_sources: list[dict]) -> UserPlan:
        settings = settings_for(profile)
        disabled = set(settings.get("disabled_sources") or [])
        mine = [s for s in all_sources if s["user_id"] is None and s["enabled"] and s["id"] not in disabled]
        custom = [s for s in all_sources if s["user_id"] == profile["id"] and s["enabled"]
                  and s["kind"] != "auto" and not (s["kind"] == "article" and s.get("consumed_at"))]
        allowed = []
        for s in custom[: self.cfg.max_custom_sources]:
            try:
                # The worker runs on a home network: never let a user's link point at it.
                check_public_url(s.get("feed_url") or s["url"], self.cfg.allow_private_urls)
                allowed.append(s)
            except FetchError as exc:
                self._update_source(s["id"], {"last_status": str(exc), "last_fetched_at": now_iso()})
        local = []
        if settings["stories"].get("local"):
            disabled_urls = set(settings.get("disabled_urls") or [])
            city = settings.get("news_city") or settings.get("city") or ""
            local = [{**s, "id": -int(hashlib.sha1(s["url"].encode()).hexdigest()[:12], 16), "user_id": None,
                      "kind": "feed", "feed_url": s["url"], "enabled": True}
                     for s in local_sources(city) if s["url"] not in disabled_urls]
        return UserPlan(profile, settings, mine + local + allowed)

    def _heard(self, user_ids: list[str], today) -> dict[str, list[dict]]:
        """Story cards from each user's recent briefings (not today's, which a rebuild replaces)."""
        since = (today - timedelta(days=HEARD_DAYS)).isoformat()
        try:
            rows = self.store.recent_stories(user_ids, since, today.isoformat())
        except StoreError as exc:
            log.warning("Couldn't load recent briefings, so repeats aren't filtered: %s", exc)
            return {}
        heard: dict[str, list[dict]] = {}
        for row in rows:
            heard.setdefault(row["user_id"], []).extend(row.get("stories") or [])
        return heard

    def _record_statuses(self, sources: dict[int, dict], items: list[Item], statuses: dict[int, str]) -> None:
        counts: dict[int, int] = {}
        for it in items:
            counts[it.source_id] = counts.get(it.source_id, 0) + 1
        stamp = now_iso()
        for sid, status in statuses.items():
            if sid < 0:  # local news isn't a row
                continue
            self._update_source(sid, {"last_fetched_at": stamp, "last_status": status, "last_count": counts.get(sid, 0)})

    def _update_source(self, source_id: int, values: dict) -> None:
        try:
            self.store.update_source(source_id, values)
        except StoreError as exc:
            log.warning("Couldn't update source %s: %s", source_id, exc)

    # ================================================================== users
    def _build_user(self, plan: UserPlan, copies: dict[str, StoryCopy], statuses: dict[int, str],
                    weather_cache: dict, now: datetime, day: str) -> Result:
        result = Result(plan.profile)
        try:
            if not plan.sources:
                self.report.add("no_sources", level="error", user_id=plan.id)
                raise UserSkipped(MESSAGES["no_sources"])
            if not plan.picked:
                self.report.add("no_stories", level="error", user_id=plan.id)
                raise UserSkipped(MESSAGES["no_stories"])
            result.briefing = self._briefing(plan, copies, weather_cache, now, day)
            self.report.built.append(plan.email)
            for s in plan.sources:
                if s["kind"] == "article" and statuses.get(s["id"]) == "ok":
                    self._update_source(s["id"], {"consumed_at": now_iso()})
            self._set_status(plan, {"ok": True, "date": day, "built_at": now_iso(), "notes": result.briefing["notes"]})
            if self.notify:
                self._notify_user(plan, result.briefing)
        except UserSkipped as exc:
            result.error = str(exc)
            self.report.failed.append(plan.email)
            self._set_status(plan, {"ok": False, "date": day, "error": result.error, "at": now_iso()})
        except StoreError as exc:
            log.exception("Saving %s's briefing failed", plan.email)
            self.report.add("storage_failed", f"{plan.email}: {exc}", level="error", user_id=plan.id)
            result.error = MESSAGES["storage_failed"]
            self.report.failed.append(plan.email)
            self._set_status(plan, {"ok": False, "date": day, "error": result.error, "at": now_iso()})
        except Exception as exc:  # noqa: BLE001 - one user's failure mustn't stop the others
            log.exception("Building %s's briefing failed", plan.email)
            self.report.add("build_failed", f"{plan.email}: {exc.__class__.__name__}: {exc}"[:300],
                            level="error", user_id=plan.id)
            result.error = MESSAGES["build_failed"]
            self.report.failed.append(plan.email)
            self._set_status(plan, {"ok": False, "date": day, "error": result.error, "at": now_iso()})
        return result

    def _publish_showcase(self, results: list[Result], day: str) -> None:
        """Share the admin's fresh briefing as the landing-page demo. Failures here only concern the admin."""
        admin = next((r for r in results if r.briefing and self._is_admin(r.profile)), None)
        if not admin:
            return
        try:
            mp3 = f"{SHOWCASE_DIR}/{day}-{time.time_ns() // 1_000_000}.mp3"  # a new name each time, so no stale CDN copy
            url = self.store.copy(f"{admin.profile['feed_token']}/{day}.mp3", mp3)
            briefing = {**admin.briefing, "audio_url": url, "notes": [],
                        "stories": [{k: v for k, v in card.items() if k != "links"}
                                    for card in admin.briefing["stories"] if card.get("section") != "custom"]}
            voices = [{k: v[k] for k in ("id", "name", "accent", "gender", "description", "engine") if k in v}
                      | {"preview_url": self.store.public_url(preview_path(v["id"]))}
                      for v in tts.all_voices() if v.get("available", True)]
            data = {"briefing": briefing, "voices": voices, "batch_time": self.cfg.batch_time,
                    "timezone": self.cfg.timezone}
            self.store.upload(f"{SHOWCASE_DIR}/sample.json", json.dumps(data).encode(), "application/json",
                              cache="max-age=300")
            stale = [p for p in self.store.list_objects(SHOWCASE_DIR) if p.endswith(".mp3") and p != mp3]
            if stale:
                self.store.remove_objects(stale)
            log.info("Published %s's briefing as the landing-page demo", admin.profile.get("email"))
        except Exception as exc:  # noqa: BLE001
            log.exception("Landing-page demo failed")
            self.report.add("showcase_failed", f"{exc.__class__.__name__}: {exc}"[:200])

    def _is_admin(self, profile: dict) -> bool:
        return bool(profile.get("is_admin")) or (profile.get("email") or "").lower() in self.cfg.admin_emails

    def _set_status(self, plan: UserPlan, status: dict) -> None:
        try:
            self.store.set_profile_status(plan.id, status)
        except StoreError as exc:
            log.warning("Couldn't save status for %s: %s", plan.email, exc)

    def _briefing(self, plan: UserPlan, copies: dict[str, StoryCopy], weather_cache: dict,
                  now: datetime, day: str) -> dict:
        briefing, mp3 = self._record(plan, copies, weather_cache, now, day)
        path = f"{plan.profile['feed_token']}/{day}.mp3"
        url = self.store.upload(path, mp3)
        briefing["audio_url"] = f"{url}?v={int(time.time())}"
        briefing["notes"] = self.report.for_user(plan.id)
        self.store.upsert_briefing(plan.id, day, briefing, path)
        return briefing

    def _record(self, plan: UserPlan, copies: dict[str, StoryCopy], weather_cache: dict,
                now: datetime, day: str) -> tuple[dict, bytes]:
        """Script, voice and assemble one briefing: returns the document and the MP3."""
        started = time.monotonic()
        st = plan.settings
        wx = None
        if st.get("weather"):
            key = (round(float(st["latitude"]), 2), round(float(st["longitude"]), 2), st["city"])
            if key not in weather_cache:
                weather_cache[key] = weather.forecast(key[0], key[1], st["city"], self.cfg.timezone)
            wx = weather_cache[key]
        script = compose(plan.picked, copies, now, weather.spoken(wx), city=st.get("news_city") or st.get("city"), name=(st.get("name") or "").strip() or None,
                         say_sources=bool(st.get("say_sources")))

        voice_id = st["voice"]
        try:
            tts.resolve(voice_id)
        except ValueError:
            voice_id = tts.default_voice()
        speed = float(st["speed"])

        segments: list[tuple[str, str, float]] = [("intro", script.intro, 0.9)]
        for section, group in plan.picked.items():
            segments.append((f"section:{section}", script.section_leads[section], 0.6))
            for i, story in enumerate(group):
                segments.append((story.id, script.stories[story.id].spoken, 1.2 if i == len(group) - 1 else 0.8))
        segments.append(("outro", script.outro, 0.8))
        rendered = [(key, self._voice(voice_id, text, speed, plan.id), pause) for key, text, pause in segments]
        pcm, marks = audio.assemble(rendered)
        mp3 = audio.encode_mp3(pcm)
        return self._document(plan, script, marks, wx, voice_id, now, day, pcm.size, started), mp3

    def _document(self, plan: UserPlan, script, marks, wx, voice_id, now, day, samples, started) -> dict:
        chapters = [{"id": "intro", "kind": "intro", "title": "Good morning", "start": 0.0,
                     "end": marks["intro"][1], "text": script.intro}]
        cards = []
        for section, group in plan.picked.items():
            s_start = marks[f"section:{section}"][0]
            chapters.append({"id": f"section:{section}", "kind": "section", "section": section,
                             "title": SECTIONS[section]["title"], "start": s_start, "end": s_start,
                             "text": script.section_leads[section]})
            for story in group:
                copy = script.stories[story.id]
                start, end = marks[story.id]
                chapters.append({"id": story.id, "kind": "story", "section": section, "title": copy.headline,
                                 "start": start, "end": end, "text": copy.spoken})
                lead = story.lead
                cards.append({
                    "id": story.id, "section": section, "headline": copy.headline, "original_title": lead.title,
                    "summary": copy.summary, "url": lead.url, "source": lead.source_name,
                    "also": [s for s in story.sources if s != lead.source_name],
                    "links": [{"source": i.source_name, "url": i.url} for i in story.items[:5]],
                    "image": lead.image if lead.image and lead.image.startswith(("http://", "https://")) else None,
                    "published": lead.published.isoformat() if lead.published else None,
                    "start": start, "end": end, "writer": copy.writer,
                })
        chapters.append({"id": "outro", "kind": "outro", "title": "Sign-off", "start": marks["outro"][0],
                         "end": marks["outro"][1], "text": script.outro})
        voice = next((v for v in tts.all_voices() if v["id"] == voice_id), {"id": voice_id, "name": voice_id})
        return {
            "date": day,
            "title": f"{now:%A}, {now:%B} {now.day}",
            "generated_at": now_iso(),
            "duration": round(samples / tts.SAMPLE_RATE, 2),
            "voice": {"id": voice_id, "name": voice.get("name"), "accent": voice.get("accent")},
            "writer": script.writer,
            "weather": wx,
            "intro": script.intro,
            "sections": [{"key": k, "title": SECTIONS[k]["title"], "emoji": SECTIONS[k]["emoji"], "count": len(v)}
                         for k, v in plan.picked.items()],
            "chapters": chapters,
            "stories": cards,
            "build_seconds": round(time.monotonic() - started, 1),
        }

    def _voice(self, voice_id: str, text: str, speed: float, user_id: str) -> np.ndarray:
        """Synthesize one segment, reusing audio another user's briefing already recorded.

        Copy written in beats (one per line) is voiced a beat at a time, with a pause between."""
        beats = [b for b in text.split("\n") if b.strip()]
        if len(beats) > 1:
            parts: list[np.ndarray] = []
            for beat in beats:
                if parts:
                    parts.append(audio.silence(BEAT_PAUSE))
                parts.append(audio.trim_silence(self._voice(voice_id, beat, speed, user_id)))
            return np.concatenate(parts)
        key = hashlib.sha1(f"{voice_id}|{speed}|{text}".encode()).hexdigest()
        path = self.tts_cache / f"{key}.npy"
        if path.exists():
            try:
                return np.load(path)
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
        try:
            pcm = tts.synthesize(voice_id, text, speed)
        except Exception as exc:  # noqa: BLE001
            backup = BACKUP_VOICE if not voice_id.startswith("edge:") else tts.default_voice()
            if backup == voice_id:
                raise
            log.warning("Voice %s failed (%s); using %s for this segment", voice_id, exc, backup)
            self.report.add("tts_fallback", f"{voice_id}: {exc.__class__.__name__}: {exc}"[:200], user_id=user_id)
            return tts.synthesize(backup, text, speed)
        np.save(path, pcm)
        return pcm

    def _notify_user(self, plan: UserPlan, briefing: dict) -> None:
        cards = briefing.get("stories") or []
        body = cards[0]["headline"] if cards else "Tap to listen to today's briefing."
        if any(n["level"] in ("warn", "error") for n in briefing.get("notes") or []):
            body += " (See the note in the app about today's briefing.)"
        try:
            subs = self.store.push_subscriptions([plan.id])
            _, gone = push.send(self.cfg, subs, "☀️ Your Morning Brief is ready", body)
            for endpoint in gone:
                self.store.delete_push_subscription(endpoint)
        except Exception as exc:  # noqa: BLE001
            log.warning("Morning notification for %s failed: %s", plan.email, exc)

    # ================================================================ tidying
    def _fresh(self, profiles: list[dict], now: datetime) -> None:
        """Start over for these users: drop today's briefing, the local caches and 'already used' marks."""
        ids = [p["id"] for p in profiles]
        day = now.date().isoformat()
        try:
            rows = self.store.briefings({"user_id": self.store._in(ids), "date": f"eq.{day}"})
            self.store.delete_briefings(rows)
            start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
            self.store.reset_consumed(ids, start_of_day.isoformat(timespec="seconds"))
            log.info("Fresh run: removed %d briefing(s) from today", len(rows))
        except StoreError as exc:
            log.warning("Couldn't clear today's briefings: %s", exc)
        for sub in ("copy", "tts"):
            shutil.rmtree(self.cfg.cache_dir / sub, ignore_errors=True)
            (self.cfg.cache_dir / sub).mkdir(parents=True, exist_ok=True)

    def _cleanup(self, now: datetime) -> None:
        try:
            old = self.store.briefings({"date": f"lt.{cutoff(now.date(), self.cfg.keep_days)}"})
            if old:
                self.store.delete_briefings(old)
                log.info("Removed %d old briefing(s)", len(old))
        except StoreError as exc:
            log.warning("Cleanup failed: %s", exc)
        limit = time.time() - CACHE_DAYS * 86400
        for sub in ("copy", "tts"):
            for f in (self.cfg.cache_dir / sub).glob("*"):
                if f.stat().st_mtime < limit:
                    f.unlink(missing_ok=True)


def preview_path(voice_id: str) -> str:
    return "previews/" + re.sub(r"[^a-zA-Z0-9_-]", "-", voice_id) + ".mp3"


class UserSkipped(Exception):
    """Nothing to build for this user (no sources or no stories)."""


# ==================================================================== admin
def admin_subscriptions(cfg: Config, store: Store | None) -> list[dict]:
    """Admins' push subscriptions, cached locally so a Supabase outage can still be reported."""
    cache = cfg.data_dir / "admin_push.json"
    if store is not None:
        try:
            admins = [p["id"] for p in store.profiles()
                      if p.get("is_admin") or (p.get("email") or "").lower() in cfg.admin_emails]
            subs = store.push_subscriptions(admins) if admins else []
            cache.write_text(json.dumps(subs))
            cache.chmod(0o600)
            return subs
        except StoreError:
            pass
    try:
        return json.loads(cache.read_text())
    except (OSError, ValueError):
        return []


def notify_admin(cfg: Config, store: Store | None, report: RunReport, *, always: bool = False) -> None:
    has_issues = not report.ok or any(i.level != "info" for i in report.issues)
    if not (has_issues or always or cfg.admin_notify == "always"):
        return
    icon = "✅" if not has_issues else ("❌" if not report.ok else "⚠️")
    title = f"{icon} Morning Brief {report.trigger}: {len(report.built)} built"
    body = report.summary()
    detail = report.admin_detail()
    if detail:
        body += "\n" + detail
    try:
        push.send(cfg, admin_subscriptions(cfg, store), title, body[:900], url="/")
    except Exception as exc:  # noqa: BLE001
        log.warning("Admin notification failed: %s", exc)


class BatchLock:
    """One batch at a time across processes (the worker and an ad-hoc `python -m app run`)."""

    def __init__(self, cfg: Config):
        self.path = cfg.data_dir / "batch.lock"
        self.fh = None

    def acquire(self) -> bool:
        import fcntl

        self.fh = open(self.path, "w")
        try:
            fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            self.fh.close()
            self.fh = None
            return False

    def release(self) -> None:
        if self.fh:
            self.fh.close()
            self.fh = None


def seed_builtins(store: Store) -> None:
    try:
        store.seed_builtins(BUILTIN_SOURCES)
    except StoreError as exc:
        # Most likely supabase/schema.sql hasn't been re-run since sections were added.
        log.warning("Couldn't update the built-in sources (re-run supabase/schema.sql?): %s", exc)


def next_run(cfg: Config, now: datetime | None = None) -> str:
    tz = ZoneInfo(cfg.timezone)
    now = now or datetime.now(tz)
    hour, minute = (int(x) for x in cfg.batch_time.split(":"))
    at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if at <= now:
        at += timedelta(days=1)
    return at.isoformat(timespec="minutes")
