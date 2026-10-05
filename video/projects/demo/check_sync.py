#!/usr/bin/env python3
"""Measure the demo's sync in the built video: run after `python3 build.py demo`.

Checks two things in build/demo.mp4, using only ffmpeg and the standard library:
  audio   where the "sync" narration really sits, found by matching the block's WAV
          against the video's soundtrack, compared with where the build put it;
  picture the first frame in which the square is yellow, compared with the moment
          the bookmarked word "now" starts in that soundtrack.
Both should be within one frame.
"""
import array
import json
import subprocess
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
RATE = 1000  # envelope samples per second: 1 ms resolution


def envelope(samples, rate):
    step = rate // RATE
    return [sum(abs(x) for x in samples[i:i + step]) / step for i in range(0, len(samples) - step + 1, step)]


def soundtrack(video, start, length, rate=24000):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(video),
         "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    return array.array("h", raw)


def best_lag(needle, hay):
    """Offset into `hay` (in envelope steps) where `needle` matches best."""
    def score(lag):
        return sum(a * b for a, b in zip(needle, hay[lag:lag + len(needle)]))

    return max(range(len(hay) - len(needle) + 1), key=score)


def first_yellow(video, start, length, fps):
    """Seconds into the video of the first frame whose centre is yellow."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(video),
         "-vf", "crop=8:8:iw/2-4:ih/2-4", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True,
    ).stdout
    size = 8 * 8 * 3
    for n in range(len(raw) // size):
        r, g, b = raw[n * size + 3 * 36:n * size + 3 * 36 + 3]
        if r > 180 and g > 180 and b < 100:
            return start + n / fps
    return None


def main():
    build = json.loads((BUILD / "build.json").read_text())
    manifest = json.loads((BUILD / "manifest.json").read_text())
    scene = next(s for s in build["scenes"] if s["scene"] == "SyncCheck")
    timeline = json.loads((BUILD / "timeline" / "SyncCheck.json").read_text())
    entry = next(b for b in timeline["blocks"] if b["id"] == "sync")
    block = manifest["blocks"]["sync"]
    fps = timeline["fps"]
    video = BUILD / build["video"]

    planned = scene["offset"] + entry["start"]
    with wave.open(str(BUILD / block["wav"])) as w:
        speech = array.array("h", w.readframes(w.getnframes()))
        speech_rate = w.getframerate()
    margin = 0.3
    hay = envelope(soundtrack(video, max(0, planned - margin), block["duration"] + 2 * margin, speech_rate), speech_rate)
    needle = envelope(speech, speech_rate)
    actual = max(0, planned - margin) + best_lag(needle, hay) / RATE
    word = actual + block["marks"]["flash"]

    yellow = first_yellow(video, scene["offset"], scene["duration"], fps)
    frame = 1 / fps
    print(f"narration placed at {planned:.3f}s, found at {actual:.3f}s  (off by {(actual - planned) * 1000:+.0f} ms)")
    if yellow is None:
        print("no yellow frame found")
        return 1
    print(f'"now" starts at {word:.3f}s, first yellow frame at {yellow:.3f}s  (off by {(yellow - word) * 1000:+.0f} ms, one frame is {frame * 1000:.0f} ms)')
    ok = abs(actual - planned) <= frame and abs(yellow - word) <= frame
    print("OK: within one frame" if ok else "OUT OF SYNC")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
