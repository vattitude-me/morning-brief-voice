"""One famous news site, and no AI anywhere in the path.

This is the single-source collector for the new approach: seven sections, the top
five stories each, taken from The Guardian's own RSS feeds. Fetching uses
``feedparser`` and article text uses ``trafilatura`` — the same open-source tooling
the worker already relies on — and the summary is the built-in extractive
summarizer in ``app/summarizer.py``. No LLM is involved at any step.

Why The Guardian as the first source:

* it publishes a clean per-section RSS, including a dedicated **Artificial
  intelligence** feed, which the seven categories need;
* the feed order is the *editor's* ranking, so "top 5" is just the first five —
  no ranking model required;
* it is explicitly free to syndicate (RSS + the Open Platform API), so scraping a
  page's private JSON is never necessary.

Swap :data:`SECTIONS` to move to another single source (BBC, NYT, …); nothing else
changes.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .fetcher import Item, enrich_items, fetch_source, make_client
from .summarizer import drop_boilerplate, summarize

log = logging.getLogger(__name__)

PROVIDER = "The Guardian"

# key -> the Guardian feed for that category. Order is the reading order.
SECTIONS: dict[str, dict] = {
    "top":           {"title": "Top stories",   "feed": "https://www.theguardian.com/international/rss"},
    "ai":            {"title": "AI",            "feed": "https://www.theguardian.com/technology/artificialintelligenceai/rss"},
    "tech":          {"title": "Tech",          "feed": "https://www.theguardian.com/uk/technology/rss"},
    "politics":      {"title": "Politics",      "feed": "https://www.theguardian.com/politics/rss"},
    "entertainment": {"title": "Entertainment", "feed": "https://www.theguardian.com/culture/rss"},
    "science":       {"title": "Science",       "feed": "https://www.theguardian.com/science/rss"},
    "sports":        {"title": "Sports",        "feed": "https://www.theguardian.com/uk/sport/rss"},
}

MAX_AGE = timedelta(hours=48)
DEFAULT_PER_SECTION = 5


def feed_url(key: str) -> str:
    return SECTIONS[key]["feed"]


def source_for(key: str) -> dict:
    """The worker's own source dict shape, so the existing fetcher reads the feed unchanged."""
    return {
        "id": 0,
        "name": f"{PROVIDER} · {SECTIONS[key]['title']}",
        "url": SECTIONS[key]["feed"],
        "section": key,
        "weight": 1.0,
        "kind": "feed",
    }


def top_n(items: list[Item], n: int = DEFAULT_PER_SECTION, max_age: timedelta = MAX_AGE) -> list[Item]:
    """The editor's top ``n``: the feed is already ranked, so keep its order.

    Dead links and stale items are dropped first, but if a feed is entirely older
    than ``max_age`` we still return its head rather than nothing.
    """
    now = datetime.now(timezone.utc)
    seen: set[str] = set()
    fresh: list[Item] = []
    for item in items:
        if not item.title or not item.url or item.url in seen:
            continue
        seen.add(item.url)
        if item.published and (now - item.published) > max_age:
            continue
        fresh.append(item)
    return (fresh or items)[:n]


def script_for(item: Item, max_words: int = 60, title: str = "") -> str:
    """The spoken script: the built-in extractive summary, never an LLM."""
    body = drop_boilerplate(item.text) or item.summary or item.title
    return summarize(body, fallback=item.summary or item.title, max_words=max_words, title=item.title or title)


async def collect_section(client, key: str, limit: int = DEFAULT_PER_SECTION) -> list[Item]:
    items = await fetch_source(client, source_for(key))
    return top_n(items, limit)


async def collect(limit: int = DEFAULT_PER_SECTION, sections: list[str] | None = None) -> dict[str, list[Item]]:
    """Top ``limit`` stories for each section. One bad feed never sinks the rest."""
    keys = [k for k in (sections or list(SECTIONS)) if k in SECTIONS]
    async with make_client() as client:
        results = await asyncio.gather(*(collect_section(client, k, limit) for k in keys),
                                       return_exceptions=True)
    out: dict[str, list[Item]] = {}
    for key, res in zip(keys, results):
        if isinstance(res, Exception):  # noqa: BLE001 — report, keep going
            log.warning("%s · %s failed: %s", PROVIDER, key, res)
            out[key] = []
        else:
            out[key] = res
    return out


async def build_pack(per_section: int = DEFAULT_PER_SECTION, sections: list[str] | None = None,
                     max_words: int = 60) -> list[dict]:
    """The day's story pack: every section's top stories as ready-to-voice scripts."""
    picked = await collect(per_section, sections)
    await enrich_items([item for items in picked.values() for item in items])
    pack: list[dict] = []
    for key, items in picked.items():
        for rank, item in enumerate(items, 1):
            pack.append({
                "id": item.id,
                "section": key,
                "rank": rank,
                "title": item.title,
                "source": item.source_name or PROVIDER,
                "url": item.url,
                "published": item.published.isoformat() if item.published else None,
                "image": item.image,
                "script": script_for(item, max_words=max_words, title=item.title),
            })
    return pack


async def _amain(args: argparse.Namespace) -> int:
    sections = args.sections.split(",") if args.sections else None
    pack = await build_pack(per_section=args.per_section, sections=sections, max_words=args.max_words)
    payload = {"date": args.date, "provider": PROVIDER, "stories": pack}
    if args.out:
        args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"wrote {args.out}  ({len(pack)} stories)")
        return 0
    for story in pack:
        print(f"[{story['section']:>2} #{story['rank']}] {story['title']}")
        print(f"        {story['script']}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=f"{PROVIDER}: top stories per section, no AI.")
    ap.add_argument("--per-section", type=int, default=DEFAULT_PER_SECTION)
    ap.add_argument("--sections", help="Comma-separated subset (default: all seven)")
    ap.add_argument("--max-words", type=int, default=60, help="Script length per story")
    ap.add_argument("--date", default=datetime.now(timezone.utc).date().isoformat())
    ap.add_argument("--out", type=Path, help="Write the pack as JSON instead of printing it")
    return asyncio.run(_amain(ap.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
