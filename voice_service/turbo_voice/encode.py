"""Encode synthesised audio to MP3 for the shared daily story clips.

The app streams a *playlist* of small clips, so the pack is stored compressed: WAV at
24 kHz mono is ~1.4 MB per 30-second story, against ~0.24 MB as 64 kbps MP3. Because
every clip is rendered by the same engine from the same reference voice, a plain
concatenation of the MP3s is already seamless — no re-encoding is needed.

``lameenc`` is a small self-contained encoder; when it is missing we fall back to
ffmpeg, which the GPU image already ships.
"""
from __future__ import annotations

import logging
import shutil
import subprocess

import numpy as np

log = logging.getLogger(__name__)

MP3_BITRATE = 64  # kbps, mono speech


def to_mp3(samples: np.ndarray, rate: int, bitrate: int = MP3_BITRATE) -> bytes:
    """MP3 bytes for mono float32 samples. Raises RuntimeError if no encoder is available."""
    pcm16 = (np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    try:
        import lameenc
    except ImportError:
        return _ffmpeg(pcm16.tobytes(), rate, bitrate)

    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate)
    encoder.set_in_sample_rate(rate)
    encoder.set_channels(1)
    encoder.set_quality(5)
    return bytes(encoder.encode(pcm16.tobytes()) + encoder.flush())


def _ffmpeg(pcm: bytes, rate: int, bitrate: int) -> bytes:
    if not shutil.which("ffmpeg"):
        raise RuntimeError("MP3 output needs the 'lameenc' package or ffmpeg on PATH")
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
        "-codec:a", "libmp3lame", "-b:a", f"{bitrate}k", "-f", "mp3", "pipe:1",
    ]
    result = subprocess.run(cmd, input=pcm, capture_output=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg could not encode MP3: {result.stderr.decode()[:200]}")
    return result.stdout
