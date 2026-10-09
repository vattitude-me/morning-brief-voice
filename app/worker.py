"""The long-running worker on the Linux server.

* Runs the batch every day at BATCH_TIME (and catches up if the server woke late).
* Every minute, picks up requests the app queued in Supabase (admin rebuilds, test notifications,
  account deletions).
* Keeps the shared app_status row current so the app can show schedule, progress and problems.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from . import audio, push, tts
from .batch import Batch, BatchLock, admin_subscriptions, next_run, notify_admin, preview_path, seed_builtins
from .config import Config
from .report import RunReport
from .store import Store, StoreError, now_iso

log = logging.getLogger(__name__)

PREVIEW_TEXT = "Good morning! Here's your briefing, with the top stories from across Canada and the latest in tech."


class Worker:
    def __init__(self, cfg: Config, store: Store):
        self.cfg = cfg
        self.store = store
        self.tz = ZoneInfo(cfg.timezone)
        self.lock = BatchLock(cfg)
        self.status: dict = {}
        self.scheduler = BlockingScheduler(timezone=self.tz)

    # ============================================================== status
    def publish(self, **changes) -> None:
        self.status.update(changes)
        self.status.update(next_run=next_run(self.cfg), updated_at=now_iso())
        try:
            self.store.set_app_status(self.status)
        except StoreError as exc:
            log.warning("Couldn't publish status: %s", exc)

    def _base_status(self) -> dict:
        try:
            previous = self.store.app_status()
        except StoreError:
            previous = {}
        voices = [{**v, "preview_url": self.store.public_url(preview_path(v["id"]))} for v in tts.all_voices()]
        return {
            **previous,
            "running": False, "step": None, "progress": 0,
            "batch_time": self.cfg.batch_time, "timezone": self.cfg.timezone, "keep_days": self.cfg.keep_days,
            "writer": "groq" if self.cfg.groq_api_key else "built-in",
            "vapid_public_key": push.load_keys(self.cfg)["public_key"],
            "voices": voices,
            "limits": {"max_custom_sources": self.cfg.max_custom_sources, "max_stories": 10},
        }

    # ================================================================ runs
    def run_batch(self, trigger: str, *, emails: list[str] | None = None, fresh: bool = False,
                  scheduled: bool = True) -> RunReport | None:
        if not self.lock.acquire():
            log.info("A build is already running; skipping %s", trigger)
            return None
        report = RunReport(trigger)
        try:
            self.publish(running=True, step="Starting", progress=0, trigger=trigger, started_at=report.started_at)

            def progress(step: str, fraction: float) -> None:
                log.info("[%3d%%] %s", int(fraction * 100), step)
                self.publish(step=step, progress=round(fraction, 3))

            try:
                Batch(self.cfg, self.store, report, progress=progress).run(
                    emails=emails, fresh=fresh, scheduled=scheduled)
            except Exception as exc:  # noqa: BLE001
                log.exception("Batch crashed")
                report.add("build_failed", f"{exc.__class__.__name__}: {exc}"[:300], level="error")
            report.finished_at = report.finished_at or now_iso()
            log.info("Run finished: %s %s", report.summary(), report.admin_detail())
            last = {**report.to_dict(), "date": datetime.now(self.tz).date().isoformat()}
            if scheduled:
                self.publish(running=False, step=None, progress=1, last_run=last)
            else:
                self.publish(running=False, step=None, progress=1, last_adhoc=last)
            notify_admin(self.cfg, self.store, report, always=not scheduled)
            return report
        finally:
            self.lock.release()

    def daily(self) -> None:
        self.run_batch("schedule")

    def catch_up(self) -> None:
        """If the server was asleep (or the worker down) at batch time, build today's briefings now."""
        now = datetime.now(self.tz)
        hour, minute = (int(x) for x in self.cfg.batch_time.split(":"))
        last = (self.status.get("last_run") or {}).get("date")
        if (now.hour, now.minute) >= (hour, minute) and now.hour < 12 and last != now.date().isoformat():
            log.info("Missed today's %s run; building now", self.cfg.batch_time)
            self.run_batch("catch-up")

    # ============================================================ requests
    def poll_requests(self) -> None:
        try:
            pending = self.store.pending_requests()
        except StoreError as exc:
            log.warning("Couldn't read requests: %s", exc)
            return
        if not pending:
            return
        profiles = {p["id"]: p for p in self.store.profiles()}
        for req in pending:
            profile = profiles.get(req["user_id"]) or {}
            self.store.update_request(req["id"], {"status": "running"})
            status, message = "done", None
            try:
                if req["kind"] == "delete_account":
                    self.delete_account(req["user_id"], profile)
                    continue  # the request row went with the account; the app takes that as done
                if req["kind"] == "push_test":
                    subs = self.store.push_subscriptions([req["user_id"]])
                    sent, gone = push.send(self.cfg, subs, "🔔 Test notification",
                                           "Notifications work. Your briefing will arrive here every morning.")
                    for endpoint in gone:
                        self.store.delete_push_subscription(endpoint)
                    message = f"Sent to {sent} device(s)" if sent else "No devices are subscribed yet"
                elif req["kind"] == "build":
                    if not self._is_admin(profile):
                        raise PermissionError("Only admins can rebuild on demand for now")
                    report = self.run_batch("adhoc", emails=[req["user_id"]], fresh=True, scheduled=False)
                    if report is None:
                        status, message = "error", "A build is already running. Try again in a few minutes."
                    else:
                        status = "done" if report.ok else "error"
                        message = report.summary()
                elif req["kind"] == "pack":
                    if not self._is_admin(profile):
                        raise PermissionError("Only admins can rebuild the audio")
                    status, message = self.run_pack(req.get("payload") or {}, profile)
            except Exception as exc:  # noqa: BLE001
                log.exception("Request %s failed", req["id"])
                status, message = "error", str(exc)[:300]
            try:
                self.store.update_request(req["id"], {"status": status, "message": message, "finished_at": now_iso()})
            except StoreError as exc:
                log.warning("Couldn't update request %s: %s", req["id"], exc)

    def _is_admin(self, profile: dict) -> bool:
        """Admins are flagged in the database, or listed in ADMIN_EMAILS on the server."""
        return bool(profile.get("is_admin") or (profile.get("email") or "").lower() in self.cfg.admin_emails)

    def run_pack(self, options: dict, profile: dict | None = None) -> tuple[str, str]:
        """Re-voice the shared pack on request from the admin page.

        The options mirror ``python -m app pack``: a day, which voices, notes only, and
        whether to re-voice clips that are already published. Returns the request status
        and the line the admin reads back. Runs under the batch lock, so a rebuild and
        the nightly run never overlap.
        """
        from . import storypack

        if not self.lock.acquire():
            return "error", "A build is already running. Try again in a few minutes."
        try:
            day = (options.get("day") or "").strip() or datetime.now(self.tz).date().isoformat()
            chosen = [v for v in (options.get("voices") or []) if v in storypack.VOICES]
            notes_only = bool(options.get("notes_only"))
            force = bool(options.get("force"))
            started = now_iso()
            clock = time.monotonic()

            def progress(text: str, fraction: float) -> None:
                log.info("[pack %3d%%] %s", int(fraction * 100), text)
                self.publish(step=text, progress=round(fraction, 3))

            self.publish(running=True, step="Reading the day's stories", progress=0, trigger="pack")
            if notes_only:
                clips: list[dict] = []
                for name in chosen or list(self.cfg.story_voices or ()):
                    clips += asyncio.run(storypack.build_notes(self.cfg, self.store, day=day,
                                                              voice=name, force=force))
                detail = f"{len(clips)} voice notes re-recorded for {day}"
            else:
                clips = []
                for name in chosen or [None]:
                    clips += asyncio.run(storypack.build(self.cfg, self.store, day=day, voice=name,
                                                       force=force, on_step=progress))
                minutes = storypack.total_seconds(clips) / 60
                voices = ", ".join(storypack.voice_name(v) for v in (chosen or list(self.cfg.story_voices or ())))
                detail = f"{len(clips)} clips for {day}, {minutes:.1f} min of audio ({voices})"

            self.publish(running=False, step=None, progress=1, last_pack={
                "day": day, "voices": chosen or list(self.cfg.story_voices or ()), "notes_only": notes_only,
                "force": force, "detail": detail, "seconds": round(time.monotonic() - clock, 1),
                "started_at": started, "at": now_iso(), "ok": True, "by": (profile or {}).get("email"),
            })
            # The run log is what the admin page reads, so a rebuild from here belongs in it.
            storypack.record(self.store, day=day, status="ok",
                             title=f"✓ Rebuild finished: {detail.split(',')[0]}",
                             body=detail, detail=f"Rebuilt from the admin page by {(profile or {}).get('email') or 'the worker'}",
                             voices=[{"id": v, "name": storypack.voice_name(v),
                                      "ready": storypack.ready(self.store, day=day, voice=v)}
                                     for v in (chosen or list(self.cfg.story_voices or ()))])
            log.info("Pack rebuilt: %s", detail)
            return "done", detail
        except Exception as exc:  # noqa: BLE001 - the request row carries the reason
            log.exception("Pack rebuild failed")
            self.publish(running=False, step=None, progress=0, last_pack={
                "error": f"{exc.__class__.__name__}: {exc}"[:300], "at": now_iso(), "ok": False,
                "by": (profile or {}).get("email"),
            })
            storypack.record(self.store, day=(options.get("day") or datetime.now(self.tz).date().isoformat()),
                             status="failed", title="✗ Rebuild failed",
                             body=f"{exc.__class__.__name__}: {exc}"[:300],
                             detail=f"Rebuilt from the admin page by {(profile or {}).get('email') or 'the worker'}")
            return "error", f"{exc.__class__.__name__}: {exc}"[:300]
        finally:
            self.lock.release()

    def delete_account(self, user_id: str, profile: dict) -> None:
        """Remove the user's MP3s, then their sign-in (every table row cascades with it)."""
        token = profile.get("feed_token")
        if token:
            paths = self.store.list_objects(token)
            if paths:
                self.store.remove_objects(paths)
        self.store.delete_user(user_id)
        log.info("Deleted account %s (%s)", user_id, profile.get("email") or "no email")

    # ============================================================== setup
    def upload_previews(self) -> None:
        try:
            have = set(self.store.list_objects("previews"))
        except StoreError as exc:
            log.warning("Couldn't list voice previews: %s", exc)
            return
        for voice in tts.all_voices():
            path = preview_path(voice["id"])
            if path in have or not voice["available"]:
                continue
            try:
                mp3 = audio.encode_mp3(audio.level(tts.synthesize(voice["id"], PREVIEW_TEXT)))
                self.store.upload(path, mp3)
                log.info("Uploaded preview for %s", voice["id"])
            except Exception as exc:  # noqa: BLE001
                log.warning("Preview for %s failed: %s", voice["id"], exc)

    def start(self) -> None:
        try:
            seed_builtins(self.store)
            self.store.set_admins(self.cfg.admin_emails)
            admin_subscriptions(self.cfg, self.store)  # refresh the offline copy
        except StoreError as exc:
            log.error("Supabase isn't ready (did you run supabase/schema.sql?): %s", exc)
            report = RunReport("startup")
            report.add("supabase_down", str(exc), level="error")
            notify_admin(self.cfg, None, report)
        self.status = self._base_status()
        self.publish()
        hour, minute = (int(x) for x in self.cfg.batch_time.split(":"))
        if self.cfg.daily_batch:
            self.scheduler.add_job(self.daily, CronTrigger(hour=hour, minute=minute, timezone=self.tz),
                                   id="daily", misfire_grace_time=3 * 3600, coalesce=True, max_instances=1)
            self.scheduler.add_job(self.catch_up, id="catch-up")
        self.scheduler.add_job(self.poll_requests, "interval", seconds=60, id="requests",
                               coalesce=True, max_instances=1)
        self.scheduler.add_job(self.upload_previews, id="previews")
        if self.cfg.daily_batch:
            log.info("Worker ready: daily batch at %s %s, next %s", self.cfg.batch_time, self.cfg.timezone,
                     next_run(self.cfg))
        else:
            log.info("Worker ready: daily batch off (DAILY_BATCH=false), answering requests only")
        self.scheduler.start()
