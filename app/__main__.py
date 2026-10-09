"""Command line entry point.

    python -m app worker                         # daily batch + app requests (the Docker service)
    python -m app run [--fresh] [--user EMAIL]   # build briefings now and print them
    python -m app pack [--voice NAME]            # voice the day's stories into the shared pack
    python -m app check                          # test the Supabase and Groq connections
"""
from __future__ import annotations

import argparse
import logging
import sys
import textwrap
import time


def _store(cfg):
    from .store import Store

    return Store(cfg.supabase_url, cfg.supabase_secret_key, cfg.bucket)


def print_briefing(profile: dict, briefing: dict | None, error: str | None) -> None:
    who = profile.get("email") or profile["id"]
    print("\n" + "=" * 78)
    if not briefing:
        print(f"✗ {who}: {error}")
        return
    mins = briefing["duration"] / 60
    print(f"✓ {who} · {briefing['title']} · {mins:.1f} min · voice {briefing['voice']['name']} · "
          f"writer {briefing['writer']} · built in {briefing['build_seconds']}s")
    print(f"  Audio: {briefing['audio_url']}")
    for note in briefing.get("notes") or []:
        print(f"  ! {note['message']}")
    if briefing.get("weather"):
        print(f"  Weather: {briefing['intro']}")
    section = None
    for card in briefing["stories"]:
        if card["section"] != section:
            section = card["section"]
            title = next((s["title"] for s in briefing["sections"] if s["key"] == section), section)
            print(f"\n  ── {title} ──")
        print(f"  • {card['headline']}  [{card['source']}{' · ' + card['writer'] if card.get('writer') else ''}]")
        print(textwrap.indent(textwrap.fill(card["summary"], 72), "      "))
        print(f"      {card['url']}")


def cmd_run(args) -> int:
    from .batch import Batch, BatchLock, notify_admin
    from .config import load
    from .report import RunReport

    cfg = load()
    lock = BatchLock(cfg)
    if not lock.acquire():
        print("A build is already running (the daily batch or another run). Try again when it finishes.")
        return 1
    try:
        report = RunReport("adhoc" if args.user else "manual")
        store = _store(cfg)
        results = Batch(cfg, store, report, notify=not args.no_push).run(
            emails=args.user or None, fresh=args.fresh, scheduled=False)
        for r in results:
            print_briefing(r.profile, r.briefing, r.error)
        print("\n" + "=" * 78)
        print(f"Run: {report.summary()}")
        for issue in report.issues:
            print(f"  [{issue.level}] {issue.code}: {issue.detail or issue.message}")
        if not results and not report.issues:
            print("  Nobody to build for. Check --user, or that the user has signed in to the app once.")
        if not args.no_push:
            notify_admin(cfg, store, report, always=True)
        return 0 if report.ok and results else 1
    finally:
        lock.release()


def cmd_check() -> int:
    import httpx

    from .config import load
    from .store import StoreError

    cfg = load()
    ok = True
    try:
        store = _store(cfg)
        profiles = store.profiles()
        print(f"✓ Supabase: {len(profiles)} user(s), {len(store.sources())} source(s)")
        store.list_objects("previews")
        print(f"✓ Storage bucket '{cfg.bucket}' reachable")
    except StoreError as exc:
        ok = False
        print(f"✗ Supabase: {exc}")
    if not cfg.groq_api_key:
        print("• Groq: no GROQ_API_KEY, summaries use the built-in writer")
    else:
        resp = httpx.get("https://api.groq.com/openai/v1/models",
                         headers={"Authorization": f"Bearer {cfg.groq_api_key}"}, timeout=20)
        if resp.status_code == 200:
            available = {m["id"] for m in resp.json().get("data", [])}
            for model in cfg.groq_models:
                print(f"{'✓' if model in available else '✗'} Groq model {model}")
                ok = ok and model in available
            if not set(cfg.groq_models) <= available:
                print("  Available chat models: " + ", ".join(sorted(m for m in available if "whisper" not in m)))
        else:
            ok = False
            print(f"✗ Groq: HTTP {resp.status_code} {resp.text[:150]}")
    if cfg.gemini_api_key:
        try:
            resp = httpx.get("https://generativelanguage.googleapis.com/v1beta/openai/models",
                             headers={"Authorization": f"Bearer {cfg.gemini_api_key}"}, timeout=20)
            if resp.status_code == 200:
                print("✓ Gemini AI Studio connected")
            else:
                print(f"✗ Gemini: HTTP {resp.status_code} {resp.text[:150]}")
        except Exception as exc:
            print(f"✗ Gemini: {exc}")
    print(f"• Daily batch at {cfg.batch_time} {cfg.timezone}, keeping {cfg.keep_days} day(s)")
    print(f"• Admins: {', '.join(cfg.admin_emails) or '(none; set ADMIN_EMAILS)'}")
    return 0 if ok else 1


def _day(cfg, args) -> str:
    """The day a pack command is working on: the one it was given, or today where the Mac is."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    return args.day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()


def _split(cfg, store, day: str, voice: str | None) -> tuple[list[str], list[str]]:
    """Which narrators' days are complete, and which are still missing."""
    from .storypack import ready

    names = [voice] if voice else list(cfg.story_voices or ())
    here = [n for n in names if ready(store, day=day, voice=n)]
    return here, [n for n in names if n not in here]


def _narrator(voice: str, is_ready: bool) -> dict:
    """One narrator's line in a run log entry."""
    from .storypack import voice_name

    return {"id": voice, "name": voice_name(voice), "ready": bool(is_ready)}


def _publish_key(cfg, store) -> bool:
    """Put this machine's notification key in the status row clients read.

    A device subscribes with whatever that row publishes, and a push signed with any other key is
    refused. So if the key pair on this machine has been replaced, the row has to follow it, or
    every device ends up subscribed to a channel nothing can post to.
    """
    from . import push

    key = push.load_keys(cfg)["public_key"]
    row = store.app_status()
    if row.get("vapid_public_key") == key:
        return False
    store.set_app_status({**row, "vapid_public_key": key})
    print("→ Published a new notification key to the app status")
    return True


def cmd_report(args) -> int:
    """The check that runs an hour after the pack.

    By then a transient failure has had its chance, so a missing narrator is first re-rendered and
    then reported either way. The admin gets a line for each narrator that is on the air, and the
    reason for any that are not, which is the part a silent 05:00 run never tells you.
    """
    import asyncio

    from .config import load
    from .storypack import build, notify_admins, notify_listeners, voice_name

    cfg = load()
    store = _store(cfg)
    day = _day(cfg, args)
    here, missing = _split(cfg, store, day, args.voice)
    tried: list[str] = []
    if missing and getattr(args, "retry", False):
        for name in missing:
            try:
                print(f"→ Re-rendering {day} for {voice_name(name)}")
                asyncio.run(build(cfg, store, day=day, voice=name))
                tried.append(f"{voice_name(name)}: re-rendered")
            except Exception as exc:  # noqa: BLE001 — report it, do not crash the check
                tried.append(f"{voice_name(name)}: {exc.__class__.__name__}: {exc}")
                print(f"✗ {voice_name(name)}: {exc.__class__.__name__}: {exc}")
        here, missing = _split(cfg, store, day, args.voice)
    good = ", ".join(voice_name(n) for n in here) or "nobody"
    bad = ", ".join(voice_name(n) for n in missing)
    detail = ". ".join(tried)
    voices = [_narrator(n, n in here) for n in here + missing]
    print(f"{'✗' if missing else '✓'} {day} is ready for {good}" + (f"; missing {bad}" if missing else ""))
    if missing:
        notify_admins(cfg, store, day=day, status="incomplete", detail=detail, voices=voices,
                      title=f"✗ Morning Brief incomplete: {bad}",
                      body=f"{day} is ready for {good}. "
                           + (detail or "The 05:00 run did not finish for them, and a retry did not happen."))
        return 1
    notify_admins(cfg, store, day=day, status="ok", detail=detail, voices=voices,
                  title=f"✓ Morning Brief ready: {good}",
                  body=f"{day} is complete for every narrator." + (f" {detail}." if detail else ""))
    if tried:
        # The 05:00 run failed, so listeners never got their nudge; this one goes out now.
        notify_listeners(cfg, store, title="☀️ Your Morning Brief is ready",
                         body=f"Today's brief is read by {good}.")
    return 0


def cmd_pack(args) -> int:
    """Voice the day's stories once and publish them as the shared daily clips."""
    import asyncio

    from .config import load
    from .storypack import (NOTES, build, build_notes, mark_ready, notify_admins, notify_listeners,
                           publish_showcase, ready, total_seconds, voice_name, write_sample_bundle)

    cfg = load()
    sections = args.sections.split(",") if args.sections else None
    if not getattr(args, "check", False):
        # Cheap, and it keeps the key clients subscribe with in step with the one this machine
        # signs with, on every path that touches a pack.
        try:
            _publish_key(cfg, _store(cfg))
        except Exception as exc:  # noqa: BLE001 — never let a status row stand in the way
            print(f"• Could not publish the notification key: {exc}")
    if getattr(args, "report", False):
        return cmd_report(args)
    if getattr(args, "check", False):
        # Readiness on its own, so a nightly job can decide whether it needs the voice service at all.
        store = _store(cfg)
        day = _day(cfg, args)
        here, missing = _split(cfg, store, day, args.voice)
        print(f"{'✗' if missing else '✓'} {day}: ready for "
              f"{', '.join(voice_name(n) for n in here) or 'nobody'}"
              + (f"; missing {', '.join(voice_name(n) for n in missing)}" if missing else ""))
        return 1 if missing else 0
    if getattr(args, "prune", False):
        from .storypack import prune_older

        gone = prune_older(_store(cfg), keep=_day(cfg, args))
        print(f"✓ Removed {len(gone)} older day(s): {', '.join(gone) or 'nothing to remove'}")
        return 0
    try:
        if getattr(args, "if_missing", False):
            # What a scheduled run wants: today's pack, unless it is already on the air. A later run
            # on the same day would re-cut the brief to whatever the feed says now, because a story
            # whose URL moved is rendered again.
            store = _store(cfg)
            day = _day(cfg, args)
            names = [args.voice] if args.voice else list(cfg.story_voices or ())
            missing = [n for n in names if not ready(store, day=day, voice=n)]
            if not missing:
                print(f"✓ {day} is already published for {', '.join(names)}; nothing to do")
                return 0
            print(f"→ {day} still needs {', '.join(missing)}")
        if getattr(args, "mark_ready", False):
            # Days published before the completeness marker existed are otherwise unplayable. Marks
            # a narrator's day only when its clips and all of its framing are actually there.
            store = _store(cfg)
            day = _day(cfg, args)
            names = [args.voice] if args.voice else list(cfg.story_voices or ())
            done: list[str] = []
            for name in names:
                clips = store.select("story_audio", {"date": f"eq.{day}", "voice": f"eq.{name}"})
                have = {n["note_key"] for n in store.select("voice_notes", {"date": f"eq.{day}", "voice": f"eq.{name}"})}
                missing = sorted(set(NOTES) - have)
                if not clips or missing:
                    print(f"✗ {name}: {len(clips)} clips, missing {missing or 'nothing'} — not marked ready")
                    continue
                mark_ready(store, day=day, voice=name, clips=len(clips), notes=len(NOTES))
                print(f"✓ {name}: {len(clips)} clips, {len(NOTES)} notes — ready for {day}")
                done.append(name)
            return 0 if done else 1
        if getattr(args, "sample_bundle", None):
            brief = asyncio.run(write_sample_bundle(cfg, _store(cfg), args.sample_bundle,
                                                   day=args.day, voice=args.voice))["briefing"]
            print(f"✓ Wrote the fixed landing sample to {args.sample_bundle}: "
                  f"{brief['audio_url'] or 'clip playlist'}, {brief['duration']:.1f}s, "
                  f"{len(brief['stories'])} stories")
            return 0
        if getattr(args, "showcase_only", False):
            brief = asyncio.run(publish_showcase(cfg, _store(cfg), day=args.day,
                                                 voice=args.voice))["briefing"]
            print(f"✓ Published the landing sample: {len(brief['clips'])} clips, "
                  f"{brief['duration']:.1f}s ({len(brief['stories'])} stories)")
            return 0
        if getattr(args, "notes_only", False):
            notes = asyncio.run(build_notes(cfg, _store(cfg), day=args.day, voice=args.voice))
            print(f"✓ Published {len(notes)} voice notes as {args.voice or cfg.story_voice}")
            for note in notes:
                print(f"  {note['note_key']:20} {note['text'][:52]!r} — {note['duration']:.1f}s")
            return 0 if notes else 1
        t0 = time.monotonic()
        rows = asyncio.run(build(cfg, _store(cfg), day=args.day, voice=args.voice,
                                 sections=sections, per_section=args.per_section,
                                 notes=not getattr(args, "no_notes", False),
                                 force=getattr(args, "force", False)))
        elapsed_sec = time.monotonic() - t0
        duration_fmt = f"{int(elapsed_sec // 60)}m {int(elapsed_sec % 60):02d}s" if elapsed_sec >= 60 else f"{elapsed_sec:.1f}s"
    except Exception as exc:  # noqa: BLE001 — say why and fail the run
        text = f"{exc.__class__.__name__}: {exc}"
        print(f"✗ {text}")
        if getattr(args, "notify", False):
            # A failure at 05:00 is otherwise silent until someone opens the app. The run log gets it
            # too, so a phone that was asleep is not the only place the news lived.
            notify_admins(cfg, _store(cfg), day=_day(cfg, args), status="failed",
                          title="✗ Morning Brief failed", detail=f"Failed: {text}", body=text)
        return 1
    print(f"✓ Published {len(rows)} clips ({total_seconds(rows):.1f}s of audio in {duration_fmt}) as {args.voice or cfg.story_voice}")
    for row in rows:
        print(f"  [{row['section']} #{row['rank']}] {row['title'][:70]} — {row['duration']:.1f}s")
    if getattr(args, "notify", False):
        store = _store(cfg)
        day = _day(cfg, args)
        here, missing = _split(cfg, store, day, args.voice)
        names = [voice_name(n) for n in here]
        voices = [_narrator(n, n in here) for n in here + missing]
        audio_mins = total_seconds(rows) / 60
        if missing:
            notify_admins(cfg, store, day=day, status="incomplete", voices=voices,
                          title=f"✗ Morning Brief incomplete: {', '.join(voice_name(n) for n in missing)}",
                          body=f"{day} is ready for {', '.join(names) or 'nobody'}. "
                               f"{len(rows)} clips were published; the rest failed.",
                          detail=f"Took {duration_fmt} · {len(rows)} clips published ({audio_mins:.1f}m audio)")
        else:
            per_voice = len(rows) // max(1, len(here))
            notify_admins(cfg, store, day=day, status="ok", voices=voices,
                          title=f"✓ Morning Brief ready: {', '.join(names)}",
                          body=f"{day}: {per_voice} stories for {', '.join(names)}, "
                               f"{total_seconds(rows) / max(1, len(here)) / 60:.0f} min each.",
                          detail=f"Took {duration_fmt} · {len(rows)} clips ({audio_mins:.1f} min audio)")
            if rows:
                notify_listeners(cfg, store, title="☀️ Your Morning Brief is ready",
                                 body=f"{rows[0]['title']}, and the rest of the day's stories.")
    return 0 if rows else 1


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m app", description="Morning Brief Voice: daily spoken news briefing")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("worker", help="run the daily batch and handle requests from the app")
    run = sub.add_parser("run", help="build briefings now and print them")
    run.add_argument("--fresh", action="store_true",
                     help="start over: delete today's briefing(s), cached summaries/audio and 'used' marks on article links")
    run.add_argument("--user", action="append", metavar="EMAIL", help="only this user (repeatable); default everyone")
    run.add_argument("--no-push", action="store_true", help="don't send notifications")
    pack = sub.add_parser("pack", help="voice the day's top stories into the shared daily pack")
    pack.add_argument("--day", help="date to publish under (default: today)")
    pack.add_argument("--voice", help="reference clip name (default: STORY_VOICE)")
    pack.add_argument("--per-section", type=int, dest="per_section", help="stories per section (default: STORIES_PER_SECTION)")
    pack.add_argument("--sections", help="comma-separated subset (default: all seven)")
    pack.add_argument("--notes-only", action="store_true", dest="notes_only",
                      help="only re-voice the greeting and section intros")
    pack.add_argument("--showcase-only", action="store_true", dest="showcase_only",
                      help="only republish the landing page's sample of the day's pack")
    pack.add_argument("--sample-bundle", nargs="?", const="web/sample", metavar="DIR",
                      help="write the fixed landing sample (audio + manifest) into DIR")
    pack.add_argument("--no-notes", action="store_true", dest="no_notes",
                      help="skip the greeting and section intros")
    pack.add_argument("--force", action="store_true",
                      help="re-voice everything, including clips and notes already published")
    pack.add_argument("--mark-ready", action="store_true", dest="mark_ready",
                      help="mark a finished day playable (for packs published before the marker)")
    pack.add_argument("--if-missing", action="store_true", dest="if_missing",
                      help="do nothing if the day is already published (for the nightly job)")
    pack.add_argument("--notify", action="store_true",
                      help="push the outcome: listeners when the day is ready, admins either way")
    pack.add_argument("--report", action="store_true",
                      help="check the day for every narrator, retry what is missing (--retry) and "
                           "push the outcome to the admins; for an hour after the nightly pack")
    pack.add_argument("--check", action="store_true",
                      help="only print whether the day is complete, exit 1 if it is not")
    pack.add_argument("--retry", action="store_true",
                      help="with --report: re-render the narrators that are still missing")
    pack.add_argument("--prune", action="store_true",
                      help="delete the audio of the days before --day (the nightly pack does this itself)")
    sub.add_parser("check", help="test the Supabase and Groq connections")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.cmd == "worker":
        from .config import load
        from .worker import Worker

        cfg = load()
        Worker(cfg, _store(cfg)).start()
    elif args.cmd == "run":
        sys.exit(cmd_run(args))
    elif args.cmd == "pack":
        sys.exit(cmd_pack(args))
    elif args.cmd == "check":
        sys.exit(cmd_check())


if __name__ == "__main__":
    main()
