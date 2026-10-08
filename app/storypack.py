"""Build the day's shared story pack: Guardian scripts → cloned voice → Supabase.

Thin glue around three pieces that already exist:

* :mod:`app.guardian` — the day's stories, no AI in the path;
* the voice service — one MP3 per story (``voice_service/scripts/batch.py`` does the
  same thing offline, for testing without Supabase);
* Supabase Storage + the ``story_audio`` table.

The worker runs this **once per day, per voice**, and every listener is served from
the same clips. TTS cost therefore depends on stories × voices, never on how many
people use the app. Each client then assembles a personal briefing by concatenating
only the clips for the sections and counts that user asked for — see
:func:`clips_for`, which mirrors what the PWA and Android do.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

from . import guardian

log = logging.getLogger(__name__)

MAX_PER_SECTION = 5

# The landing page has to play something for people who aren't signed in, and
# `story_audio` is not readable without a session. So every pack also publishes a
# small public slice of itself: the greeting, a couple of sections' intros, and
# their top stories, carrying the same clip timeline the clients assemble. No second
# render, no extra voice work — the sample is literally the day's own clips.
SHOWCASE_KEY = "showcase/sample.json"
SHOWCASE_SECTIONS: tuple[str, ...] = ("top", "ai")
SHOWCASE_PER_SECTION = 3

# The landing page's own copy of the sample, checked into the site so it plays for
# anyone, instantly, with no account and no storage bucket in the path. Regenerate it
# with `python -m app pack --sample-bundle`.
SAMPLE_BUNDLE_DIR = "web/sample"
SAMPLE_BUNDLE_AUDIO = "sample.mp3"

# Spoken framing, voiced once per day like the stories. A listener opens with the
# greeting that matches their clock, then hears the section's line before its first
# story. Kept short on purpose — these are punctuation, not content.
GREETINGS = {
    "greeting_morning": "Good morning.",
    "greeting_afternoon": "Good afternoon.",
    "greeting_evening": "Good evening.",
}
INTROS = {
    "intro_top": "Here are the top stories.",
    "intro_ai": "Here's the latest in AI.",
    "intro_tech": "Now, the latest in tech.",
    "intro_politics": "Turning to politics.",
    "intro_entertainment": "In entertainment.",
    "intro_science": "In science.",
    "intro_sports": "In sports.",
}
NOTES: dict[str, str] = {**GREETINGS, **INTROS}


def greeting_key(hour: int) -> str:
    """Which greeting a listener hears, by their local hour (mirrors the client)."""
    if hour < 12:
        return "greeting_morning"
    if hour < 17:
        return "greeting_afternoon"
    return "greeting_evening"


def default_lineup() -> dict[str, int]:
    """Every section on, at the maximum, until the user says otherwise."""
    return {key: MAX_PER_SECTION for key in guardian.SECTIONS}


def lineup(settings: dict | None, default: dict[str, int] | None = None) -> dict[str, int]:
    """The per-section story counts a user asked for (0 = off), clamped to 0..``MAX``.

    Read from ``profiles.settings.stories`` — the key both clients already keep, e.g.
    ``{"top": 3, "ai": 5, "sports": 0}`` — so no settings migration is needed.
    """
    chosen = (settings or {}).get("stories") or {}
    base = default or default_lineup()
    out: dict[str, int] = {}
    for key in guardian.SECTIONS:
        try:
            count = int(chosen.get(key, base.get(key, 0)))
        except (TypeError, ValueError):
            count = 0
        out[key] = max(0, min(count, MAX_PER_SECTION))
    return out


def clips_for(rows: list[dict], wanted: dict[str, int], voice: str | None = None) -> list[dict]:
    """Order the shared clips into one listener's briefing.

    Sections follow the catalog's reading order and each contributes its top ``n``
    clips by rank, so the same rows produce a different briefing per user.
    """
    by_section: dict[str, list[dict]] = {}
    for row in rows:
        if voice and row.get("voice") != voice:
            continue
        by_section.setdefault(row["section"], []).append(row)

    ordered: list[dict] = []
    for key in guardian.SECTIONS:
        count = wanted.get(key, 0)
        if count <= 0:
            continue
        ordered.extend(sorted(by_section.get(key, []), key=lambda r: r.get("rank", 0))[:count])
    return ordered


def total_seconds(clips: list[dict]) -> float:
    return round(sum(float(c.get("duration") or 0) for c in clips), 2)


def showcase_payload(rows: list[dict], notes: list[dict], url_for, *, day: str,
                     voice: str | None = None,
                     sections: tuple[str, ...] = SHOWCASE_SECTIONS,
                     per_section: int = SHOWCASE_PER_SECTION) -> dict:
    """The public sample of a day's pack, in the shape both clients already read.

    ``clips`` carry a running timeline so the landing page can play the greeting, each
    section's line and the top stories back to back, and ``chapters``/``stories`` tell
    it which story is playing at any moment.
    """
    note_by_key = {n["note_key"]: n for n in notes if not voice or n.get("voice") == voice}
    by_section: dict[str, list[dict]] = {}
    for row in rows:
        if voice and row.get("voice") != voice:
            continue
        by_section.setdefault(row["section"], []).append(row)

    clips: list[dict] = []
    chapters: list[dict] = []
    stories: list[dict] = []
    counts: dict[str, int] = {}
    cursor = 0.0

    def add(duration: float, cid: str, kind: str, title: str, path: str) -> tuple[float, float]:
        nonlocal cursor
        start, end = cursor, cursor + duration
        clips.append({"url": url_for(path), "duration": round(duration, 3),
                      "start": round(start, 3), "end": round(end, 3)})
        chapters.append({"id": cid, "kind": kind, "title": title,
                         "start": round(start, 3), "end": round(end, 3)})
        cursor = end
        return start, end

    greeting = note_by_key.get("greeting_morning")
    if greeting:
        add(float(greeting.get("duration") or 0), "greeting", "note",
            greeting.get("text") or "Good morning.", greeting["audio_path"])

    for key in sections:
        chosen = sorted(by_section.get(key, []), key=lambda r: r.get("rank", 0))[:per_section]
        if not chosen:
            continue
        intro = note_by_key.get(f"intro_{key}")
        if intro:
            add(float(intro.get("duration") or 0), f"intro-{key}", "note",
                intro.get("text") or "", intro["audio_path"])
        for row in chosen:
            cid = f"{key}-{row['rank']}"
            start, end = add(float(row.get("duration") or 0), cid, "story",
                             row.get("title") or "", row["audio_path"])
            stories.append({
                "id": cid, "section": key, "headline": row.get("title") or "",
                "summary": row.get("script") or "", "source": row.get("source") or "",
                "url": row.get("url") or "", "image": row.get("image") or "",
                "start": round(start, 3), "end": round(end, 3),
            })
            counts[key] = counts.get(key, 0) + 1

    return {"briefing": {
        "date": day,
        "title": "Your briefing",
        "duration": round(cursor, 2),
        "audio_url": "",  # the sample is the clips below, played back to back
        "clips": clips,
        "chapters": chapters,
        "stories": stories,
        "sections": [{"key": k, "title": guardian.SECTIONS[k]["title"], "count": n}
                     for k, n in counts.items()],
    }}


async def publish_showcase(cfg, store, *, day: str | None = None, voice: str | None = None,
                           sections: tuple[str, ...] = SHOWCASE_SECTIONS,
                           per_section: int = SHOWCASE_PER_SECTION) -> dict:
    """Publish the public sample of the day's pack, for the signed-out landing page."""
    day = day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()
    voice = voice or cfg.story_voice
    rows = store.select("story_audio", {"date": f"eq.{day}", "voice": f"eq.{voice}"})
    notes = store.select("voice_notes", {"date": f"eq.{day}", "voice": f"eq.{voice}"})
    payload = showcase_payload(rows, notes, store.public_url, day=day, voice=voice,
                              sections=sections, per_section=per_section)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    store.upload(SHOWCASE_KEY, body, content_type="application/json", cache="max-age=300")
    log.info("Published the landing sample: %d clips, %.1fs",
             len(payload["briefing"]["clips"]), payload["briefing"]["duration"])
    return payload


def _probe_seconds(path: Path) -> float | None:
    """How long an audio file really is, in seconds, or None when ffprobe can't say."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            check=True, capture_output=True, text=True).stdout.strip()
        return float(out)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


async def _join_clips(urls: list[str], dest: Path, workdir: Path) -> bool:
    """Stitch the sample's clips into one file. False when there's no ffmpeg to do it."""
    if not urls or not shutil.which("ffmpeg"):
        return False
    parts = workdir / "parts"
    parts.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    async with httpx.AsyncClient(timeout=300) as client:
        for i, url in enumerate(urls):
            resp = await client.get(url)
            resp.raise_for_status()
            name = f"{i:02d}.mp3"
            (parts / name).write_bytes(resp.content)
            names.append(name)
    listing = workdir / "parts.txt"
    listing.write_text("".join(f"file '{parts / n}'\n" for n in names))
    try:
        # -c copy keeps the voice bit-for-bit: same encoder produced every part.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                        "-i", str(listing), "-c", "copy", str(dest)],
                       check=True, capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("Could not join the sample audio: %s", exc)
        return False
    return dest.exists() and dest.stat().st_size > 0


async def write_sample_bundle(cfg, store, directory: str = SAMPLE_BUNDLE_DIR, *,
                              day: str | None = None, voice: str | None = None,
                              sections: tuple[str, ...] = SHOWCASE_SECTIONS,
                              per_section: int = SHOWCASE_PER_SECTION) -> dict:
    """Write the sample the landing page ships with: one MP3 plus its manifest.

    The page has to play for a visitor who isn't signed in, on the first tap, without
    waiting on the storage bucket — so the audio is joined into a single file and kept
    beside the site. Chapters keep their absolute times, so the story list still lights
    up as it plays. Without ffmpeg the clips stay a playlist and the client plays them
    back to back, which the markup already understands.
    """
    day = day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()
    voice = voice or cfg.story_voice
    rows = store.select("story_audio", {"date": f"eq.{day}", "voice": f"eq.{voice}"})
    notes = store.select("voice_notes", {"date": f"eq.{day}", "voice": f"eq.{voice}"})
    payload = showcase_payload(rows, notes, store.public_url, day=day, voice=voice,
                               sections=sections, per_section=per_section)
    brief = payload["briefing"]
    clips = brief.pop("clips", [])

    out = Path(directory)
    out.mkdir(parents=True, exist_ok=True)
    audio = out / SAMPLE_BUNDLE_AUDIO
    with tempfile.TemporaryDirectory() as tmp:
        joined = await _join_clips([c["url"] for c in clips], audio, Path(tmp))
    if joined:
        brief["audio_url"] = f"/sample/{SAMPLE_BUNDLE_AUDIO}"
        seconds = _probe_seconds(audio)
        if seconds:
            brief["duration"] = round(seconds, 2)
    else:
        brief["clips"] = clips
        brief["audio_url"] = ""
        audio.unlink(missing_ok=True)

    (out / "sample.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n")
    log.info("Wrote the fixed landing sample to %s (%s, %.1fs)", out,
             brief["audio_url"] or f"{len(clips)} clips", brief["duration"])
    return payload


async def synthesise(client: httpx.AsyncClient, base: str, text: str, voice: str,
                     attempts: int = 4) -> tuple[bytes, float]:
    """One MP3 from the voice service, plus its duration (from the response header).

    A long pack must not die because the service blipped or was restarted: transport
    errors are retried with a growing back-off (a container restart needs a few seconds
    to serve again). A 4xx/5xx answer is a real error and is raised straight away.
    """
    delay = 5
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            resp = await client.post(f"{base}/synthesize", params={"format": "mp3"},
                                     json={"text": text, "voice": voice})
        except httpx.HTTPError as exc:
            last = exc
            if attempt == attempts:
                break
            log.warning("voice service unreachable (%s); retrying in %ds", exc.__class__.__name__, delay)
            await asyncio.sleep(delay)
            delay *= 3
            continue
        if resp.status_code >= 400:
            raise RuntimeError(f"voice service {resp.status_code}: {resp.text[:200]}")
        return resp.content, float(resp.headers.get("X-Duration") or 0.0)
    raise RuntimeError(f"voice service unavailable after {attempts} attempts: {last}")


async def build_notes(cfg, store, *, day: str | None = None, voice: str | None = None,
                      voice_url: str | None = None, keys: list[str] | None = None) -> list[dict]:
    """Voice the greeting and the section intros once for the day."""
    day = day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()
    voice = voice or cfg.story_voice
    base = (voice_url or cfg.voice_url or "").rstrip("/")
    if not base:
        raise RuntimeError("VOICE_SERVICE_URL is not set")

    items = [(k, NOTES[k]) for k in NOTES if not keys or k in keys]
    rows: list[dict] = []
    async with httpx.AsyncClient(timeout=900) as client:
        for key, text in items:
            audio, duration = await synthesise(client, base, text, voice)
            path = f"notes/{day}/{key}-{voice}.mp3"
            store.upload(path, audio, content_type="audio/mpeg", cache="max-age=86400")
            row = {"date": day, "voice": voice, "note_key": key, "text": text,
                   "duration": round(duration, 3), "audio_path": path}
            store.insert("voice_notes", row, on_conflict="date,voice,note_key")
            rows.append(row)
            log.info("[note] %-20s %-34s %.1fs", key, text, duration)
    log.info("Published %d voice notes", len(rows))
    return rows


async def build(cfg, store, *, day: str | None = None, per_section: int | None = None,
                sections: list[str] | None = None, voice: str | None = None,
                voice_url: str | None = None, notes: bool = True,
                force: bool = False) -> list[dict]:
    """Voice the day's stories once and publish them as shared clips.

    Safe to re-run: rows upsert on ``(date, section, rank, voice)``, so a retry — or a
    second voice — simply adds to the day's pack.
    """
    day = day or datetime.now(ZoneInfo(cfg.timezone)).date().isoformat()
    voice = voice or cfg.story_voice
    base = (voice_url or cfg.voice_url or "").rstrip("/")
    if not base:
        raise RuntimeError("VOICE_SERVICE_URL is not set")
    per_section = per_section or cfg.stories_per_section

    scripts = await guardian.build_pack(per_section=per_section, sections=sections)
    log.info("Voicing %d stories for %s as %s", len(scripts), day, voice)

    # Stories already voiced for this day are reused, so a re-run only re-renders what
    # genuinely changed — a story that dropped out of the top five, or a new one — and
    # metadata such as the lead image can be refreshed without paying for audio again.
    existing = {(r["section"], r["rank"]): r for r in store.select(
        "story_audio", {"date": f"eq.{day}", "voice": f"eq.{voice}"})}

    rows: list[dict] = []
    async with httpx.AsyncClient(timeout=900) as client:
        for story in scripts:
            image = (story.get("image") or "")[:2000] or None
            done = existing.get((story["section"], story["rank"]))
            if not force and done and done.get("audio_path") and done.get("url") == story["url"]:
                store.update("story_audio",
                             {"date": f"eq.{day}", "section": f"eq.{story['section']}",
                              "rank": f"eq.{story['rank']}", "voice": f"eq.{voice}"},
                             {"image": image, "title": story["title"][:500],
                              "source": (story["source"] or "")[:200], "script": story["script"]})
                rows.append({**done, "image": image})
                log.info("[%s #%s] %s — reused (%.1fs)", story["section"], story["rank"],
                         story["title"][:60], done.get("duration") or 0)
                continue

            audio, duration = await synthesise(client, base, story["script"], voice)
            path = f"stories/{day}/{story['section']}-{story['rank']}-{voice}.mp3"
            store.upload(path, audio, content_type="audio/mpeg", cache="max-age=86400")
            row = {
                "date": day, "section": story["section"], "rank": story["rank"], "voice": voice,
                "title": story["title"][:500], "url": story["url"],
                "source": (story["source"] or "")[:200], "image": image,
                "script": story["script"],
                "duration": round(duration, 3), "audio_path": path,
            }
            # Publish each story as it lands, so a failure part-way through still leaves
            # a usable pack instead of throwing away every minute already rendered.
            store.insert("story_audio", row, on_conflict="date,section,rank,voice")
            rows.append(row)
            log.info("[%s #%s] %s — %.1fs", story["section"], story["rank"], story["title"][:60], duration)

    log.info("Published %d clips (%.1fs of audio)", len(rows), total_seconds(rows))
    if notes:
        await build_notes(cfg, store, day=day, voice=voice, voice_url=base)
    # The landing page's sample rides along with the pack, so it can't quietly go stale.
    try:
        await publish_showcase(cfg, store, day=day, voice=voice)
    except Exception as exc:  # noqa: BLE001 — a sample is worth having, a pack is not
        log.warning("Could not publish the landing sample: %s", exc)
    return rows


def main() -> int:
    from .config import load
    from .store import Store

    ap = argparse.ArgumentParser(description="Voice the day's stories into the shared pack.")
    ap.add_argument("--day", help="Date to publish under (default: today)")
    ap.add_argument("--voice", help="Reference clip name (default: STORY_VOICE)")
    ap.add_argument("--per-section", type=int, help="Stories per section (default: STORIES_PER_SECTION)")
    ap.add_argument("--sections", help="Comma-separated subset (default: all)")
    ap.add_argument("--notes-only", action="store_true", dest="notes_only",
                    help="only re-voice the greeting and section intros")
    ap.add_argument("--no-notes", action="store_true", dest="no_notes",
                    help="skip the greeting and section intros")
    ap.add_argument("--showcase-only", action="store_true", dest="showcase_only",
                    help="only republish the landing page's sample of the day's pack")
    ap.add_argument("--sample-bundle", nargs="?", const=SAMPLE_BUNDLE_DIR, metavar="DIR",
                    help="write the fixed landing sample (audio + manifest) into DIR")
    ap.add_argument("--force", action="store_true",
                    help="re-voice every story, even ones already published")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load()
    store = Store(cfg.supabase_url, cfg.supabase_secret_key, cfg.bucket)
    sections = args.sections.split(",") if args.sections else None
    if args.sample_bundle:
        payload = asyncio.run(write_sample_bundle(cfg, store, args.sample_bundle,
                                                 day=args.day, voice=args.voice))
        brief = payload["briefing"]
        print(f"wrote {args.sample_bundle}: {brief['audio_url'] or 'clip playlist'}, "
              f"{brief['duration']:.1f}s, {len(brief['stories'])} stories")
        return 0
    if args.showcase_only:
        payload = asyncio.run(publish_showcase(cfg, store, day=args.day, voice=args.voice))
        brief = payload["briefing"]
        print(f"published the landing sample: {len(brief['clips'])} clips, {brief['duration']:.1f}s")
        return 0
    if args.notes_only:
        notes = asyncio.run(build_notes(cfg, store, day=args.day, voice=args.voice))
        print(f"published {len(notes)} voice notes")
        return 0 if notes else 1
    rows = asyncio.run(build(cfg, store, day=args.day, per_section=args.per_section,
                             sections=sections, voice=args.voice, notes=not args.no_notes,
                             force=args.force))
    print(f"published {len(rows)} clips, {total_seconds(rows):.1f}s of audio")
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
