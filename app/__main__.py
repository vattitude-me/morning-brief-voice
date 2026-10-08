"""Command line entry point.

    python -m app worker                         # daily batch + app requests (the Docker service)
    python -m app run [--fresh] [--user EMAIL]   # build briefings now and print them
    python -m app pack [--voice NAME]            # voice the day's stories into the shared pack
    python -m app check                          # test the Supabase and Groq connections
    python -m app setup                          # download the Kokoro voice model
"""
from __future__ import annotations

import argparse
import logging
import sys
import textwrap


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
    print(f"• Daily batch at {cfg.batch_time} {cfg.timezone}, keeping {cfg.keep_days} day(s)")
    print(f"• Admins: {', '.join(cfg.admin_emails) or '(none; set ADMIN_EMAILS)'}")
    return 0 if ok else 1


def cmd_pack(args) -> int:
    """Voice the day's stories once and publish them as the shared daily clips."""
    import asyncio
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from .config import load
    from .storypack import NOTES, build, build_notes, mark_ready, publish_showcase, total_seconds, write_sample_bundle

    cfg = load()
    sections = args.sections.split(",") if args.sections else None
    try:
        if getattr(args, "mark_ready", False):
            # Days published before the completeness marker existed are otherwise unplayable. Marks
            # a narrator's day only when its clips and all of its framing are actually there.
            store = _store(cfg)
            day = args.day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()
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
        rows = asyncio.run(build(cfg, _store(cfg), day=args.day, voice=args.voice,
                                 sections=sections, per_section=args.per_section,
                                 notes=not getattr(args, "no_notes", False),
                                 force=getattr(args, "force", False)))
    except Exception as exc:  # noqa: BLE001 — say why and fail the run
        print(f"✗ {exc.__class__.__name__}: {exc}")
        return 1
    print(f"✓ Published {len(rows)} clips ({total_seconds(rows):.1f}s of audio) as {args.voice or cfg.story_voice}")
    for row in rows:
        print(f"  [{row['section']} #{row['rank']}] {row['title'][:70]} — {row['duration']:.1f}s")
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
    sub.add_parser("check", help="test the Supabase and Groq connections")
    sub.add_parser("setup", help="download the Kokoro voice model (~350 MB)")
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
    elif args.cmd == "setup":
        from .config import load
        from .tts.kokoro import download_models

        cfg = load()
        last = {}

        def progress(name: str, done: int, total: int) -> None:
            pct = done * 100 // total
            if last.get(name) != pct and pct % 10 == 0:
                last[name] = pct
                print(f"  {name}: {pct}%")

        download_models(cfg.model_dir, progress)
        print(f"Voice model ready in {cfg.model_dir}")


if __name__ == "__main__":
    main()
