"""Render a bundle of story scripts to one WAV per story — the nightly story pack.

    .venv/bin/python scripts/batch.py stories.json --voice her_reference --out out

``stories.json`` is::

    {"date": "2026-10-07", "stories": [
        {"id": "abc123", "section": "tech", "rank": 1, "title": "...", "script": "..."}]}

Writes ``out/pack/<voice>/<section>-<rank>-<id>.wav`` plus ``index.json`` with each
clip's duration and pause marks. The app then concatenates only the clips a user
asked for — no story is ever voiced twice, so TTS cost does not grow with users.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from turbo_voice import SAMPLE_RATE, TurboVoice  # noqa: E402


def slug(story: dict) -> str:
    section = story.get("section") or "story"
    rank = story.get("rank")
    sid = story.get("id") or "0"
    return f"{section}-{rank}-{sid}" if rank else f"{section}-{sid}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Render a story pack to WAV files.")
    ap.add_argument("pack", type=Path, help="JSON file with the stories to voice")
    ap.add_argument("--voice", default=None, help="Reference clip name (default: the service's own)")
    ap.add_argument("--out", type=Path, default=Path("out"), help="Where to write the pack")
    args = ap.parse_args()

    data = json.loads(args.pack.read_text(encoding="utf-8"))
    stories = data.get("stories") or (data if isinstance(data, list) else [])
    if not stories:
        print("No stories in the pack", file=sys.stderr)
        return 1

    reference = None
    if args.voice:
        reference = Path("data/voices") / (args.voice if args.voice.endswith(".wav") else f"{args.voice}.wav")

    voice = TurboVoice(reference)
    voice_name = (reference or voice.reference or Path("default.wav")).stem
    out = args.out / "pack" / voice_name
    out.mkdir(parents=True, exist_ok=True)
    print(f"device : {voice.device}   voice: {voice_name}   stories: {len(stories)}")

    index = []
    total = 0.0
    for story in stories:
        text = (story.get("script") or story.get("text") or "").strip()
        if not text:
            print(f"  skip  {story.get('id')} — empty script")
            continue
        audio, marks = voice.render(text, reference=reference)
        seconds = audio.size / SAMPLE_RATE
        name = f"{slug(story)}.wav"
        sf.write(out / name, audio, SAMPLE_RATE, subtype="PCM_16")
        total += seconds
        index.append({
            "id": story.get("id"), "section": story.get("section"), "rank": story.get("rank"),
            "title": story.get("title"), "url": story.get("url"), "source": story.get("source"),
            "voice": voice_name, "file": name, "duration": round(seconds, 3),
            "marks": [{"text": t, "start": s, "end": e} for t, s, e in marks],
        })
        print(f"  {name:32} {seconds:6.2f}s  {len(marks)} span(s)")

    (out / "index.json").write_text(
        json.dumps({"date": data.get("date"), "voice": voice_name,
                    "total_seconds": round(total, 3), "stories": index}, indent=2),
        encoding="utf-8",
    )
    print(f"\ntotal  : {total:.2f}s audio in {len(index)} clips")
    print(f"wrote  : {out}  (+ index.json)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
