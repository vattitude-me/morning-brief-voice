"""Exercise the running voice API exactly as a client (or Postman) would.

    .venv/bin/python scripts/api_smoke.py
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

import requests
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:8090"

NEWS = (
    "Good morning! It's Wednesday, October 8th. [[pause:0.6]] "
    "Here's what's happening. [[pause:0.5]] "
    "The port strike is over. Union leaders said a deal was reached late last night... "
    "after three days of talks. [sigh] It was a long week for everyone. "
    "[[pause:0.8]] And finally, your weather. Cloudy, with a high of 14 degrees."
)


def main() -> int:
    out = ROOT / "out"
    out.mkdir(exist_ok=True)

    voices = requests.get(f"{BASE}/voices", timeout=30).json()
    print(f"default: {voices['default']}")
    print(f"clips  : {[c['name'] for c in voices['clips']]}\n")

    for clip in voices["clips"]:
        if not clip["usable"]:
            print(f"  skip {clip['name']} — {clip['seconds']}s, needs >5s")
            continue
        resp = requests.post(f"{BASE}/synthesize",
                             json={"text": NEWS, "voice": clip["name"]}, timeout=900)
        resp.raise_for_status()
        path = out / f"api_{clip['name']}.wav"
        path.write_bytes(resp.content)
        audio, rate = sf.read(io.BytesIO(resp.content))
        print(f"  {clip['name']:20} {len(audio) / rate:6.2f}s  -> {path.relative_to(ROOT)}")

    first = voices["clips"][0]["name"]
    resp = requests.post(f"{BASE}/news/sample", json={"voice": first}, timeout=900)
    resp.raise_for_status()
    data = resp.json()
    print(f"\nsample : {data['voice']} | {data['duration']}s | {data['spans']} spans "
          f"| warnings={data['warnings']}")
    for mark in data["marks"][:3]:
        print(f"   {mark['start']:6.2f}-{mark['end']:6.2f}  {mark['text'][:58]}")
    (out / "api_sample.wav").write_bytes(base64.b64decode(data["audio_b64"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
