"""Build the sample a new install hears: the day's own clips, with the same breath between them.

Run from the repo root:

    python scripts/make-sample-brief.py [--day YYYY-MM-DD] [--voice her_reference]

Writes `android/app/src/main/res/raw/sample_brief.mp3`. Replaces the old bundled sample, which was
recorded with a different model and does not sound like the brief the app now plays.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "android/app/src/main/res/raw/sample_brief.mp3"
GAP = ROOT / "web/audio/gap.mp3"
# The greeting, the first section's intro, then its top stories.
NOTES = ("greeting_morning", "intro_top")
SECTION = "top"
MAX_SECONDS = 50.0


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", help="day to sample (default: today)")
    ap.add_argument("--voice", default="her_reference")
    args = ap.parse_args()

    sys.path.insert(0, str(ROOT))
    for key, value in env().items():
        os.environ.setdefault(key, value)
    from app.config import load  # noqa: PLC0415
    from app.store import Store  # noqa: PLC0415

    cfg = load()
    store = Store(cfg.supabase_url, cfg.supabase_secret_key, cfg.bucket)
    day = args.day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()

    rows = sorted(
        (r for r in store.select("story_audio", {"date": f"eq.{day}", "voice": f"eq.{args.voice}",
                                                 "section": f"eq.{SECTION}"})),
        key=lambda r: r["rank"],
    )
    notes = {n["note_key"]: n for n in store.select("voice_notes", {"date": f"eq.{day}", "voice": f"eq.{args.voice}"})}
    if not rows:
        print(f"✗ No pack published for {day} as {args.voice}. Run `python -m app pack` first.")
        return 1

    clips = [notes[k] for k in NOTES if k in notes]
    total = sum(float(c["duration"]) for c in clips)
    for row in rows:
        if clips and total + float(row["duration"]) > MAX_SECONDS:
            break
        clips.append(row)
        total += float(row["duration"])

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        gap = work / "gap.mp3"
        gap.write_bytes(GAP.read_bytes())
        paths: list[Path] = []
        with httpx.Client(timeout=120, follow_redirects=True) as client:
            for i, clip in enumerate(clips):
                url = store.public_url(clip["audio_path"])
                resp = client.get(url)
                resp.raise_for_status()
                path = work / f"{i:02d}.mp3"
                path.write_bytes(resp.content)
                paths.append(path)
        listing = work / "parts.txt"
        ordered: list[Path] = []
        for i, path in enumerate(paths):
            if i:
                ordered.append(gap)
            ordered.append(path)
        listing.write_text("".join(f"file '{p}'\n" for p in ordered))
        # One pass through the encoder: the parts are all the same format, but a copy leaves the
        # silence's timestamps fighting the clips', which some players dislike.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(listing), "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "24000",
                        "-ac", "1", str(OUT)], check=True)

    seconds = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                    "-of", "default=nw=1:nk=1", str(OUT)],
                                   check=True, capture_output=True, text=True).stdout.strip())
    print(f"✓ {OUT.relative_to(ROOT)}: {len(clips)} clips, {seconds:.1f}s, voice {args.voice}, day {day}")
    for clip in clips:
        label = clip.get("title") or clip.get("text") or clip.get("note_key") or ""
        print(f"  {str(clip.get('note_key') or clip['section'] + ' #' + str(clip['rank'])):16} {label[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
