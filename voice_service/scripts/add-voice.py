"""Turn any recording into a reference clip the voice service can clone from.

    python scripts/add-voice.py --id nora_reference --name Nora --gender female --audio clip.m4a

Writes `data/voices/<id>.wav` (mono 24 kHz, leading and trailing silence trimmed) and prints the
lines to register the new narrator. Run it again with an existing id — `her_reference`, say — to give
that narrator a different voice; the pack then needs `--force` to re-record the days already voiced.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_SECONDS = 5.0      # Chatterbox refuses a reference shorter than this
GOOD_SECONDS = (8.0, 30.0)


def probe(path: Path, *entries: str) -> str:
    out = subprocess.run(["ffprobe", "-v", "error", *entries, str(path)],
                         check=True, capture_output=True, text=True).stdout.strip()
    return out


def duration(path: Path) -> float:
    return float(probe(path, "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id", required=True, help="voice id, e.g. nora_reference (the file's name)")
    ap.add_argument("--name", help="what listeners see, e.g. Nora")
    ap.add_argument("--gender", choices=["female", "male"], help="which line the clients show")
    ap.add_argument("--audio", required=True, help="the recording to clone, any format ffmpeg reads")
    ap.add_argument("--dir", default=str(ROOT / "data/voices"), help="voice directory")
    ap.add_argument("--force", action="store_true", help="overwrite an existing clip with this id")
    args = ap.parse_args()

    if not shutil.which("ffmpeg"):
        print("✗ ffmpeg is not on PATH")
        return 1
    source = Path(args.audio).expanduser()
    if not source.is_file():
        print(f"✗ No such file: {source}")
        return 1
    target_dir = Path(args.dir).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)
    dest = target_dir / f"{args.id}.wav"
    replacing = dest.exists()
    if replacing and not args.force:
        print(f"✗ {dest} already exists. Pass --force to replace that narrator's voice.")
        return 1

    # Mono 24 kHz, the format the engine works in, with the dead air at each end removed so the
    # clone does not learn the room tone as part of the voice.
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
        "-af", "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB:"
               "stop_periods=-1:stop_silence=0.1:stop_threshold=-45dB",
        "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(dest),
    ], check=True)

    seconds = duration(dest)
    info = " ".join(probe(dest, "-show_entries", "stream=sample_rate,channels", "-of", "default=nw=1").split())
    print(f"✓ {dest}  ({seconds:.1f}s, {info})")
    if seconds < MIN_SECONDS:
        print(f"✗ Too short: the engine needs more than {MIN_SECONDS:.0f} seconds. Use a longer clip.")
        return 1
    if not GOOD_SECONDS[0] <= seconds <= GOOD_SECONDS[1]:
        print(f"! Between {GOOD_SECONDS[0]:.0f} and {GOOD_SECONDS[1]:.0f} seconds clones best.")

    # A cached embedding belongs to the clip it was made from.
    for sidecar in target_dir.glob(f"{args.id}.*.conds.pt"):
        sidecar.unlink()
        print(f"  removed the stale embedding {sidecar.name}")

    name = args.name or args.id
    gender = args.gender or "female"
    print("\nRegister the narrator, then re-voice:" if not replacing else
          "\nThis replaced a narrator that already exists. Register nothing new, then re-voice:")
    print(f"  app/storypack.py   VOICES[\"{args.id}\"] = {{'name': \"{name}\", 'gender': \"{gender}\"}}")
    print(f"  web/js/api.js      {{ id: '{args.id}', name: '{name}', gender: '{gender}' }}")
    print(f"  android/.../pipeline/Voices.kt   PackVoice(\"{args.id}\", \"{name}\", \"{gender}\")")
    print(f"  deployment         STORY_VOICES={args.id} (comma-separated, with the others)")
    print(f"\n  python -m app pack --voice {args.id}" + (" --force" if replacing else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
