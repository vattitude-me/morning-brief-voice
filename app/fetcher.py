"""Fetch news from RSS/Atom feeds, plain web pages and single articles.

Built on open-source tooling: feedparser for feeds, trafilatura for article
extraction, and lxml for link discovery on pages without a feed.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import ipaddress
import json
import logging
import re
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from calendar import timegm
from urllib.parse import urljoin, urlparse, urldefrag

import feedparser
import httpx
import lxml.html
import trafilatura

log = logging.getLogger(__name__)


def _drop_boilerplate(text: str) -> str:
    from .summarizer import drop_boilerplate  # summarizer -> ranking -> fetcher, so not at the top

    return drop_boilerplate(text)

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0 Safari/537.36 MorningBrief/2.0"
)
FEED_PATHS = ("feed", "rss", "feed.xml", "rss.xml", "atom.xml", "index.xml", "feeds/posts/default")
MAX_ITEMS_PER_SOURCE = 25


@dataclass
class Item:
    title: str
    url: str
    source_id: int
    source_name: str
    section: str
    weight: float = 1.0
    published: datetime | None = None
    summary: str = ""
    image: str | None = None
    position: int = 0
    feed_len: int = 1
    text: str = ""
    kind: str = "feed"

    @property
    def id(self) -> str:
        return hashlib.sha1(self.url.encode()).hexdigest()[:12]


@dataclass
class Detection:
    kind: str                      # feed | page | article
    url: str
    feed_url: str | None
    name: str
    sample: list[str] = field(default_factory=list)


class FetchError(Exception):
    pass


# --------------------------------------------------------------------- helpers
# The worker may sit on a home network, and anyone can add links: every request, including each
# redirect and every link scraped from a page, must go to a public address. Set from ALLOW_PRIVATE_URLS.
ALLOW_PRIVATE = False


async def _public_only(request: httpx.Request) -> None:
    if not ALLOW_PRIVATE:
        await asyncio.to_thread(check_public_url, str(request.url), False)


def make_client(timeout: float = 20.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Accept-Language": "en-CA,en;q=0.9"},
        follow_redirects=True,
        timeout=timeout,
        event_hooks={"request": [_public_only]},
    )


def clean_text(raw: str | None) -> str:
    if not raw:
        return ""
    if "<" in raw:
        try:
            raw = lxml.html.fromstring(f"<div>{raw}</div>").text_content()
        except Exception:  # noqa: BLE001 - malformed markup, fall back to regex
            raw = re.sub(r"<[^>]+>", " ", raw)
    raw = html.unescape(raw)
    return re.sub(r"\s+", " ", raw).strip()


def normalize_url(url: str) -> str:
    url = url.strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return urldefrag(url)[0]


def check_public_url(url: str, allow_private: bool) -> None:
    """Refuse non-HTTP schemes and (unless allowed) hosts that resolve to private networks."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise FetchError("Only http(s) links are supported.")
    if allow_private:
        return
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        return  # can't resolve locally (e.g. behind a proxy); let the request decide
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise FetchError("That address points to a private network.")


def _entry_time(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if value:
            return datetime.fromtimestamp(timegm(value), tz=timezone.utc)
    return None


def _entry_image(entry) -> str | None:
    for key in ("media_content", "media_thumbnail"):
        for media in entry.get(key) or []:
            url = media.get("url")
            if url and (media.get("medium") in (None, "image") or "image" in (media.get("type") or "image")):
                return url
    for enc in entry.get("enclosures") or []:
        if (enc.get("type") or "").startswith("image") and enc.get("href"):
            return enc["href"]
    for blob in [entry.get("summary", "")] + [c.get("value", "") for c in entry.get("content") or []]:
        m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', blob or "")
        if m:
            return html.unescape(m.group(1))
    return None


def looks_like_feed(content_type: str, body: bytes) -> bool:
    head = body[:600].lstrip().lower()
    return (
        any(t in content_type for t in ("rss", "atom", "xml"))
        and b"<html" not in head
    ) or head.startswith((b"<?xml", b"<rss", b"<feed", b"<rdf"))


def parse_feed(body: bytes, source: dict) -> tuple[str, list[Item]]:
    parsed = feedparser.parse(body)
    if parsed.bozo and not parsed.entries:
        raise FetchError("Couldn't read that feed.")
    entries = parsed.entries[:MAX_ITEMS_PER_SOURCE]
    items = []
    for pos, entry in enumerate(entries):
        title = clean_text(entry.get("title"))
        link = entry.get("link")
        if not title or not link:
            continue
        summary = clean_text(entry.get("summary") or "")
        source_name = source.get("name", "")
        outlet = clean_text((entry.get("source") or {}).get("title"))
        if outlet and _is_google_news(link):
            # Google News: "Headline - Outlet", and the summary only repeats the headline.
            title = title.removesuffix(f" - {outlet}").strip() or title
            source_name, summary = outlet, ""
        if len(summary) > 1200:
            summary = summary[:1200].rsplit(" ", 1)[0] + "…"
        items.append(Item(
            title=title,
            url=link,
            source_id=source.get("id", 0),
            source_name=source_name,
            section=source.get("section", "custom"),
            weight=source.get("weight", 1.0),
            published=_entry_time(entry),
            summary=summary,
            image=_entry_image(entry),
            position=pos,
            feed_len=len(entries),
        ))
    return clean_text(parsed.feed.get("title")) or urlparse(source.get("url", "")).hostname or "", items


def discover_feed_links(page_html: str, base_url: str) -> list[str]:
    try:
        doc = lxml.html.fromstring(page_html)
    except Exception:  # noqa: BLE001
        return []
    links = []
    for link in doc.xpath('//link[@rel="alternate"][@href]'):
        typ = (link.get("type") or "").lower()
        if "rss" in typ or "atom" in typ:
            links.append(urljoin(base_url, link.get("href")))
    return links


def extract_page_links(page_html: str, base_url: str, limit: int = 15) -> list[tuple[str, str]]:
    """Heuristically find headline links on a section/home page without a feed."""
    try:
        doc = lxml.html.fromstring(page_html)
    except Exception:  # noqa: BLE001
        return []
    base_host = (urlparse(base_url).hostname or "").removeprefix("www.")
    seen: set[str] = set()
    found: list[tuple[str, str]] = []
    for a in doc.xpath("//a[@href]"):
        text = re.sub(r"\s+", " ", a.text_content() or "").strip()
        href = urldefrag(urljoin(base_url, a.get("href")))[0]
        parsed = urlparse(href)
        host = (parsed.hostname or "").removeprefix("www.")
        if parsed.scheme not in {"http", "https"} or not host.endswith(base_host):
            continue
        words = len(text.split())
        path_parts = [p for p in parsed.path.split("/") if p]
        # Headlines are several words long and live on deep, slug-like paths.
        if words < 5 or words > 30 or len(path_parts) < 2 and "-" not in parsed.path:
            continue
        if href in seen or href.rstrip("/") == base_url.rstrip("/"):
            continue
        seen.add(href)
        found.append((text, href))
        if len(found) >= limit:
            break
    return found


def extract_article(page_html: str, url: str) -> dict:
    raw = trafilatura.extract(
        page_html,
        url=url,
        output_format="json",
        with_metadata=True,
        include_comments=False,
        include_tables=False,
        favor_precision=True,
    )
    if not raw:
        meta = trafilatura.extract_metadata(page_html, default_url=url)
        return {
            "title": getattr(meta, "title", None),
            "description": getattr(meta, "description", None),
            "image": getattr(meta, "image", None),
            "sitename": getattr(meta, "sitename", None),
            "text": "",
        }
    data = json.loads(raw)
    return {
        "title": data.get("title"),
        "description": data.get("description") or data.get("excerpt"),
        "image": data.get("image"),
        "sitename": data.get("sitename") or data.get("hostname"),
        "date": data.get("date"),
        "pagetype": data.get("pagetype"),
        "text": data.get("text") or data.get("raw_text") or "",
    }


# ---------------------------------------------------------------- async fetch
async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    try:
        resp = await client.get(url)
    except FetchError:
        raise
    except httpx.HTTPError as exc:
        raise FetchError(f"Couldn't reach {urlparse(url).hostname}: {exc.__class__.__name__}") from exc
    if resp.status_code >= 400:
        raise FetchError(f"{urlparse(url).hostname} returned HTTP {resp.status_code}")
    return resp


async def fetch_source(client: httpx.AsyncClient, source: dict) -> list[Item]:
    kind = source.get("kind", "feed")
    if kind == "feed":
        resp = await _get(client, source.get("feed_url") or source["url"])
        _, items = parse_feed(resp.content, source)
        return items

    resp = await _get(client, source["url"])
    if kind == "article":
        art = extract_article(resp.text, str(resp.url))
        title = clean_text(art.get("title")) or source["name"]
        return [Item(
            title=title,
            url=str(resp.url),
            source_id=source["id"],
            source_name=clean_text(art.get("sitename")) or source["name"],
            section=source["section"],
            weight=source.get("weight", 1.2),
            summary=clean_text(art.get("description")),
            image=art.get("image"),
            text=_drop_boilerplate(art.get("text", "")),
            kind="article",
            published=datetime.now(timezone.utc),
        )]

    # page: scrape headline links
    links = extract_page_links(resp.text, str(resp.url))
    return [
        Item(
            title=title,
            url=href,
            source_id=source["id"],
            source_name=source["name"],
            section=source["section"],
            weight=source.get("weight", 1.0),
            position=pos,
            feed_len=len(links),
            kind="page",
        )
        for pos, (title, href) in enumerate(links)
    ]


async def fetch_all(sources: list[dict], concurrency: int = 8) -> tuple[list[Item], dict[int, str]]:
    """Fetch every source; returns items plus a per-source status message."""
    sem = asyncio.Semaphore(concurrency)
    statuses: dict[int, str] = {}
    items: list[Item] = []

    async with make_client() as client:
        async def one(src: dict) -> None:
            async with sem:
                try:
                    got = await fetch_source(client, src)
                    items.extend(got)
                    statuses[src["id"]] = "ok"
                except Exception as exc:  # noqa: BLE001 - one bad source mustn't sink the briefing
                    log.warning("Source %s failed: %s", src.get("name"), exc)
                    statuses[src["id"]] = str(exc) if isinstance(exc, FetchError) else f"error: {exc.__class__.__name__}"

        await asyncio.gather(*(one(s) for s in sources))
    return items, statuses


def _is_google_news(url: str) -> bool:
    return urlparse(url).hostname == "news.google.com" and "/articles/" in url


async def google_news_target(client: httpx.AsyncClient, url: str) -> str | None:
    """The publisher's link behind a Google News article link, which only redirects in a browser."""
    gid = urlparse(url).path.rsplit("/", 1)[-1]
    page = (await _get(client, f"https://news.google.com/rss/articles/{gid}")).text
    sig = re.search(r'data-n-a-sg="([^"]+)"', page)
    ts = re.search(r'data-n-a-ts="([^"]+)"', page)
    if not (sig and ts):
        return None
    inner = json.dumps(["garturlreq", [["X", "X", ["X", "X"], None, None, 1, 1, "US:en", None, 1, None, None, None,
                                        None, None, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
                        gid, int(ts.group(1)), sig.group(1)])
    resp = await client.post("https://news.google.com/_/DotsSplashUi/data/batchexecute",
                             data={"f.req": json.dumps([[["Fbv4je", inner, None, "generic"]]])})
    found = re.search(r'\[\\"garturlres\\",\\"(.*?)\\"', resp.text)
    return found.group(1) if found and found.group(1).startswith("http") else None


async def enrich_items(items: list[Item], concurrency: int = 6) -> None:
    """Download full article text and a lead image for the stories that made the cut."""
    sem = asyncio.Semaphore(concurrency)

    async with make_client(timeout=15.0) as client:
        async def one(item: Item) -> None:
            if item.text and item.image:
                return
            async with sem:
                if _is_google_news(item.url):
                    try:
                        item.url = await google_news_target(client, item.url) or item.url
                    except Exception as exc:  # noqa: BLE001
                        log.info("Could not follow %s: %s", item.url, exc)
                    if _is_google_news(item.url):
                        return
                try:
                    resp = await _get(client, item.url)
                    art = await asyncio.to_thread(extract_article, resp.text, str(resp.url))
                except Exception as exc:  # noqa: BLE001
                    log.info("Could not extract %s: %s", item.url, exc)
                    return
            if len(art.get("text") or "") > len(item.text):
                item.text = art["text"]
            # The article's og:image is a large signed URL; the feed's is a 140px thumbnail.
            item.image = art.get("image") or item.image
            if not item.summary:
                item.summary = clean_text(art.get("description"))

        await asyncio.gather(*(one(i) for i in items))


async def detect(url: str, allow_private: bool = False) -> Detection:
    """Work out what a user-supplied link is: a feed, a site with a feed, a page or an article."""
    url = normalize_url(url)
    check_public_url(url, allow_private)
    async with make_client(timeout=15.0) as client:
        resp = await _get(client, url)
        final = str(resp.url)
        ctype = resp.headers.get("content-type", "").lower()

        if looks_like_feed(ctype, resp.content):
            name, items = parse_feed(resp.content, {"url": final})
            return Detection("feed", url, final, name, [i.title for i in items[:4]])

        page_html = resp.text
        candidates = discover_feed_links(page_html, final)
        parsed = urlparse(final)
        shallow = len([p for p in parsed.path.split("/") if p]) <= 2
        if shallow:
            base = final if final.endswith("/") else final + "/"
            candidates += [urljoin(base, p) for p in FEED_PATHS[:3]]

        for cand in dict.fromkeys(candidates):
            try:
                fr = await _get(client, cand)
            except FetchError:
                continue
            if looks_like_feed(fr.headers.get("content-type", "").lower(), fr.content):
                try:
                    name, items = parse_feed(fr.content, {"url": cand})
                except FetchError:
                    continue
                if items:
                    return Detection("feed", url, str(fr.url), name, [i.title for i in items[:4]])

        art = await asyncio.to_thread(extract_article, page_html, final)
        site = clean_text(art.get("sitename")) or (parsed.hostname or "").removeprefix("www.")
        links = extract_page_links(page_html, final)
        slug = parsed.path.rstrip("/").rsplit("/", 1)[-1]
        article_hint = art.get("pagetype") == "article" or slug.count("-") >= 3 or not shallow
        text_len = len(art.get("text") or "")
        is_article = (text_len > 400 and article_hint) or (text_len > 1200 and len(links) < 5)
        if is_article:
            title = clean_text(art.get("title")) or site
            return Detection("article", url, None, title, [title])
        if links:
            return Detection("page", url, None, site, [t for t, _ in links[:4]])
        raise FetchError("Couldn't find any news on that page. Try the site's RSS feed or an article link.")
