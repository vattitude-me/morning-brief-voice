"""Smoke-test the voice end to end without starting the API.

    .venv/bin/python scripts/smoke.py [reference.wav]

Reports the device, the time each span takes against the audio it produces, and
writes the results to ``out/``. The first run also downloads the model weights.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from turbo_voice import SAMPLE_RATE, TurboVoice, parse  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LINES = [
    "Good morning! It's Tuesday, October 6th. Here's your briefing.",
    "The port strike is over. [[pause:0.6]] Union leaders said a deal was reached late last night.",
    "Meanwhile, [sigh] the city council has pushed its budget vote to next week...",
]


def main() -> int:
    reference = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "voices" / "reference.wav"
    out = ROOT / "out"
    out.mkdir(exist_ok=True)

    print(f"reference : {reference}")
    if not reference.exists():
        print("  ✗ missing — a clip longer than 5 seconds is required")
        return 1

    voice = TurboVoice(reference)
    print(f"device    : {voice.device}")

    load_started = time.time()
    voice.say("Ready.")  # forces the model download and MPS warm-up
    print(f"load      : {time.time() - load_started:.1f}s")

    total_audio = total_time = 0.0
    for i, line in enumerate(LINES):
        started = time.time()
        audio, marks = voice.render(line)
        elapsed = time.time() - started
        seconds = audio.size / SAMPLE_RATE
        total_audio += seconds
        total_time += elapsed
        sf.write(out / f"line{i}.wav", audio, SAMPLE_RATE)
        print(f"\nline {i}    : {len(marks)} span(s), {seconds:.2f}s audio in {elapsed:.1f}s")
        for item in parse(line):
            label = f"{item.seconds}s pause" if hasattr(item, "seconds") else item.text
            print(f"            {type(item).__name__:6} {label}")

    if total_audio:
        print(f"\ntotal     : {total_audio:.2f}s audio in {total_time:.1f}s "
              f"({total_audio / total_time:.2f}x realtime)")
    print(f"wrote     : {out.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
