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

    from .config import load
    from .storypack import build, total_seconds

    cfg = load()
    sections = args.sections.split(",") if args.sections else None
    try:
        rows = asyncio.run(build(cfg, _store(cfg), day=args.day, voice=args.voice,
                                 sections=sections, per_section=args.per_section))
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
