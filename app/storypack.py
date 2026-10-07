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
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from . import guardian

log = logging.getLogger(__name__)

MAX_PER_SECTION = 5


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


async def synthesise(client: httpx.AsyncClient, base: str, text: str, voice: str) -> tuple[bytes, float]:
    """One MP3 from the voice service, plus its duration (from the response header)."""
    resp = await client.post(f"{base}/synthesize", params={"format": "mp3"},
                             json={"text": text, "voice": voice})
    if resp.status_code >= 400:
        raise RuntimeError(f"voice service {resp.status_code}: {resp.text[:200]}")
    return resp.content, float(resp.headers.get("X-Duration") or 0.0)


async def build(cfg, store, *, day: str | None = None, per_section: int | None = None,
                sections: list[str] | None = None, voice: str | None = None,
                voice_url: str | None = None) -> list[dict]:
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

    rows: list[dict] = []
    async with httpx.AsyncClient(timeout=900) as client:
        for story in scripts:
            audio, duration = await synthesise(client, base, story["script"], voice)
            path = f"stories/{day}/{story['section']}-{story['rank']}-{voice}.mp3"
            store.upload(path, audio, content_type="audio/mpeg", cache="max-age=86400")
            rows.append({
                "date": day, "section": story["section"], "rank": story["rank"], "voice": voice,
                "title": story["title"][:500], "url": story["url"],
                "source": (story["source"] or "")[:200], "script": story["script"],
                "duration": round(duration, 3), "audio_path": path,
            })
            log.info("[%s #%s] %s — %.1fs", story["section"], story["rank"], story["title"][:60], duration)

    if rows:
        store.insert("story_audio", rows, on_conflict="date,section,rank,voice")
    log.info("Published %d clips (%.1fs of audio)", len(rows), total_seconds(rows))
    return rows


def main() -> int:
    from .config import load
    from .store import Store

    ap = argparse.ArgumentParser(description="Voice the day's stories into the shared pack.")
    ap.add_argument("--day", help="Date to publish under (default: today)")
    ap.add_argument("--voice", help="Reference clip name (default: STORY_VOICE)")
    ap.add_argument("--per-section", type=int, help="Stories per section (default: STORIES_PER_SECTION)")
    ap.add_argument("--sections", help="Comma-separated subset (default: all)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load()
    store = Store(cfg.supabase_url, cfg.supabase_secret_key, cfg.bucket)
    sections = args.sections.split(",") if args.sections else None
    rows = asyncio.run(build(cfg, store, day=args.day, per_section=args.per_section,
                             sections=sections, voice=args.voice))
    print(f"published {len(rows)} clips, {total_seconds(rows):.1f}s of audio")
    return 0 if rows else 1


if __name__ == "__main__":
    raise SystemExit(main())
