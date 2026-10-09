"""Turn ranked stories into card copy and a spoken briefing script.

Story copy (headline, card summary, spoken lines) is written once per story and
shared by every user whose briefing includes it. Groq writes it when a key is
set, falling through GROQ_MODELS as each one hits its free-tier limit; the
extractive template writer is the last resort, so a briefing always ships.
The intro, section transitions and sign-off are templates, personalised per user.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path

import httpx

from .ranking import Story
from .report import RunReport
from .sources import SECTIONS
from .summarizer import drop_boilerplate, summarize

log = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
MAX_WAIT = 65          # longest per-minute back-off we'll sit through, in seconds
MAX_ARTICLE_CHARS = 2500


@dataclass
class StoryCopy:
    headline: str
    summary: str
    spoken: str
    writer: str = "built-in"


@dataclass
class Script:
    intro: str
    section_leads: dict[str, str]
    stories: dict[str, StoryCopy]
    outro: str
    writer: str = "built-in"
    notes: list[str] = field(default_factory=list)


# ------------------------------------------------------------------ template
CONNECTORS = ["", "Next,", "Meanwhile,", "Also today,", "In other news,", "Elsewhere,", "And"]


def _source_phrase(story: Story) -> str:
    names = story.sources
    if len(names) >= 3:
        return f"{names[0]}, {names[1]} and others"
    return " and ".join(names)


# Spoken after a story when the listener wants to hear where it came from; varied so it doesn't drone.
CREDITS = ["That's from {src}.", "Via {src}.", "{src} has the full story.", "Reporting from {src}."]


def credit(story: Story) -> str:
    return CREDITS[int(story.id, 16) % len(CREDITS)].format(src=_source_phrase(story))


def template_copy(story: Story) -> StoryCopy:
    lead = story.lead
    summary = summarize(lead.text, fallback=lead.summary, max_words=60, title=lead.title) or lead.summary or lead.title
    spoken_body = summarize(lead.text, fallback=lead.summary, max_words=55, max_sentences=2, title=lead.title)
    if spoken_body.endswith("…"):
        # Never stop mid-sentence out loud: drop the clipped tail.
        head, dot, _ = spoken_body.rpartition(". ")
        spoken_body = head + dot.strip() if dot else ""
    # The connector depends on the story, not its position, so the same story sounds the same
    # in everyone's briefing and its audio can be shared.
    connector = CONNECTORS[int(story.id, 16) % len(CONNECTORS)]
    title = lead.title.rstrip(".")
    opener = f"{connector} {title}." if connector else f"{title}."
    spoken = f"{opener}\n{spoken_body}".strip()
    return StoryCopy(headline=lead.title, summary=summary, spoken=spoken, writer="built-in")


def section_leads(sections: list[str], city: str | None = None) -> dict[str, str]:
    """'First, ...', 'Next, ...', 'And finally, ...' in the order the sections are read."""
    leads = {}
    for i, key in enumerate(sections):
        topic = SECTIONS.get(key, {}).get("topic") or f"news from {SECTIONS.get(key, {}).get('title', key)}"
        topic = topic.replace("{city}", (city or "").split(",")[0].strip() or "town")
        if len(sections) == 1:
            leads[key] = f"{topic[0].upper()}{topic[1:]}."
        else:
            opener = "First" if i == 0 else "And finally" if i == len(sections) - 1 else "Next"
            leads[key] = f"{opener}, {topic}."
    return leads


def compose(picked: dict[str, list[Story]], copies: dict[str, StoryCopy], when: datetime,
            weather: str | None, name: str | None = None, say_sources: bool = False,
            city: str | None = None) -> Script:
    """Wrap shared story copy in a personal intro, section transitions and sign-off.

    The intro doesn't count stories: each section is announced as it starts, which is enough to
    find your way around by ear."""
    date = f"{when:%A}, {when:%B} {when.day}"
    hello = f"Good morning, {name}!" if name else "Good morning!"
    intro = f"{hello} It's {date}. {weather + ' ' if weather else ''}Here's your briefing."
    stories = {s.id: copies[s.id] for group in picked.values() for s in group}
    if say_sources:
        stories = {s.id: replace(copies[s.id], spoken=f"{copies[s.id].spoken}\n{credit(s)}")
                   for group in picked.values() for s in group}
    used = {c.writer for c in stories.values()}
    writer = "built-in" if used == {"built-in"} else ("groq" if "built-in" not in used else "mixed")
    return Script(
        intro=intro,
        section_leads=section_leads(list(picked), city),
        stories=stories,
        outro=f"That's your briefing for this {when:%A}. Have a wonderful day, and I'll talk to you tomorrow morning.",
        writer=writer,
    )


# ---------------------------------------------------------------------- Groq
SYSTEM_PROMPT = """You write copy for a warm, trustworthy morning audio news briefing for listeners in Canada.
The spoken text is read aloud by a text-to-speech voice, so it is written for the ear; the summary appears on a news card.

Return a JSON object with exactly these keys:
- "headline": a clear, neutral headline of at most 12 words.
- "summary": the card text, 40 to 60 words of plain factual prose built only from the supplied text.
- "spoken": what the host says, as an array of 2 to 4 beats, 45 to 85 words in all. The app leaves a short pause
  between beats, so each beat is one idea in one or two sentences. The first beat is the news itself, who did
  what, in one sentence; then the key detail; then why it matters or what happens next.

How the spoken beats should sound:
- Like a calm radio host talking to one listener: plain words, contractions, active voice.
- Sentences of 8 to 20 words, with the subject and verb near the start. No long lead-in clauses.
- Attribution after the fact, not before it: "The plant will close in March, the company said."
- Commas only where a speaker would breathe. No semicolons, colons, dashes, brackets or quotation marks;
  paraphrase quotes instead.
- Numbers the way people say them: rounded, at most two in a sentence, written as digits with "percent" and
  "dollars" in words (55 percent, 64 million dollars, 11 a.m.).
- Use a person's full name and role the first time, then the surname. Expand initials a listener
  might not know.
- Never name the news outlet or say "reports" or "according to" about it: the app credits the source
  separately. Start with the news itself, not a greeting or a transition: the app adds those.
- No URLs, emoji, lists or markdown.

Stay strictly factual and neutral. Never add facts that aren't in the text; if the text is thin, say less."""


def spoken_beats(value) -> str:
    """The spoken copy as beats, one per line: the voice pauses between lines."""
    beats = value if isinstance(value, list) else str(value or "").split("\n")
    return "\n".join(" ".join(str(b).split()) for b in beats if str(b).strip())


class LimitHit(Exception):
    """This model can't be used again in this run."""


class AuthFailed(Exception):
    """The API key was rejected: no Groq model will work in this run."""


def _retry_after(resp: httpx.Response) -> float:
    try:
        return float(resp.headers.get("retry-after", ""))
    except ValueError:
        pass
    # Groq also says "Please try again in 7.66s" / "in 2m59.5s" in the message.
    m = re.search(r"try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s", resp.text)
    if m:
        h, mins, s = (float(x) if x else 0.0 for x in m.groups())
        return h * 3600 + mins * 60 + s
    return 10.0


def _is_daily(resp: httpx.Response) -> bool:
    text = resp.text.lower()
    return "per day" in text or "(tpd)" in text or "(rpd)" in text or "daily" in text


class StoryWriter:
    """Writes copy for each story once, caches it on disk, and records every limit it runs into."""

    def __init__(self, cache_dir: Path, report: RunReport, *,
                 api_key: str | None = None, models: tuple[str, ...] = (),
                 gemini_api_key: str | None = None, gemini_models: tuple[str, ...] = (),
                 client: httpx.Client | None = None, sleep=time.sleep):
        self.cache_dir = cache_dir / "copy"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.report = report
        self.api_key = api_key
        self.gemini_api_key = gemini_api_key
        self.models: list[str] = []
        if gemini_api_key:
            self.models.extend(list(gemini_models or ("gemini-2.5-flash", "gemini-1.5-flash")))
        if api_key:
            self.models.extend(list(models))
        self.client = client or httpx.Client(timeout=60)
        self.sleep = sleep
        self.failures = 0
        if not (api_key or gemini_api_key):
            report.add("ai_off", "Neither GEMINI_API_KEY nor GROQ_API_KEY is set", level="info")

    # ---------------------------------------------------------------- public
    def copy(self, section: str, story: Story) -> StoryCopy:
        path = self.cache_dir / f"{story.id}.v3.json"  # v3: spoken copy in beats, one per line
        if path.exists():
            try:
                cached = StoryCopy(**json.loads(path.read_text()))
                self.report.writers[cached.writer] += 1
                return cached
            except (ValueError, TypeError):
                pass
        result = self._ai(section, story) or template_copy(story)
        self.report.writers[result.writer] += 1
        if result.writer != "built-in":  # retry the AI next run rather than caching the fallback
            path.write_text(json.dumps(result.__dict__, ensure_ascii=False))
        return result

    # --------------------------------------------------------------- private
    def _ai(self, section: str, story: Story) -> StoryCopy | None:
        while self.models:
            model = self.models[0]
            try:
                return self._call(model, section, story)
            except LimitHit as exc:
                log.warning("AI model %s unavailable for the rest of this run: %s", model, exc)
                self.models.pop(0)
            except AuthFailed as exc:
                self.report.add("ai_auth", str(exc), level="error")
                self.models.clear()
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                # One bad story (timeout, malformed JSON): fall back for this story only,
                # but give up on the service after repeated failures.
                self.failures += 1
                log.warning("AI failed on %s: %s", story.id, exc)
                if self.failures >= 3:
                    self.report.add("ai_unavailable", f"{exc.__class__.__name__}: {exc}"[:200])
                    self.models.clear()
                return None
        return None

    def _call(self, model: str, section: str, story: Story) -> StoryCopy:
        lead = story.lead
        payload = {
            "section": SECTIONS[section]["title"],
            "headline": lead.title,
            "text": (drop_boilerplate(lead.text) or lead.summary or lead.title)[:MAX_ARTICLE_CHARS],
        }
        is_gemini = model.startswith("gemini")
        url = GEMINI_URL if is_gemini else GROQ_URL
        token = self.gemini_api_key if is_gemini else self.api_key
        provider = "Gemini" if is_gemini else "Groq"

        body = {
            "model": model,
            "temperature": 0.4,
            "max_tokens": 1200,
            "response_format": {"type": "json_object"},
            **({"reasoning_effort": "low"} if model.startswith("openai/gpt-oss") else {}),
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        }
        for attempt in range(4):
            resp = self.client.post(url, json=body, headers={"Authorization": f"Bearer {token}"})
            if resp.status_code in (401, 403):
                raise AuthFailed(f"{provider} returned {resp.status_code}: {resp.text[:150]}")
            if resp.status_code == 429:
                wait = _retry_after(resp)
                if _is_daily(resp) or wait > MAX_WAIT:
                    self.report.add("ai_daily_limit", f"{model}: {resp.text[:200]}")
                    raise LimitHit(f"daily limit ({wait:.0f}s wait)")
                self.report.add("ai_rate_limited", f"{model}: waited {wait:.0f}s", level="info")
                self.sleep(wait + 0.5)
                continue
            if resp.status_code in (404, 400) and "model" in resp.text.lower():
                self.report.add("ai_model_gone", f"{model}: {resp.text[:150]}")
                raise LimitHit(f"model not available: {resp.text[:150]}")
            if resp.status_code >= 500:
                if attempt < 2:
                    self.sleep(2 * (attempt + 1))
                    continue
                resp.raise_for_status()
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
            headline, summary = (str(data.get(k, "")).strip() for k in ("headline", "summary"))
            spoken = spoken_beats(data.get("spoken"))
            if not (summary and spoken):
                raise ValueError("empty summary or spoken text")
            self.failures = 0
            return StoryCopy(headline=headline or lead.title, summary=summary, spoken=spoken, writer=model)
        self.report.add("ai_daily_limit", f"{model}: still rate limited after retries")
        raise LimitHit("still rate limited after retries")


def copy_key(text: str) -> str:
    return hashlib.sha1(text.encode()).hexdigest()[:16]
