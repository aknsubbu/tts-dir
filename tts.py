#!/usr/bin/env python3
"""Text file in, speech out, using the Kokoro model on this Mac. No key, no quota.

Usage:
    python3 tts.py script.txt                  # writes script.mp3 next to the input
    python3 tts.py script.txt -o out.wav       # .mp3, .wav, .flac or .ogg
    python3 tts.py - -o out.mp3 < script.txt   # read text from stdin
    python3 tts.py script.txt --voice bm_george --speed 1.1
    python3 tts.py --list-voices

One-time install:
    ./install.sh

This is a launcher. The engine is tts-studio/engine/kokoro_engine.py, and it runs
with the Python in .venv (or the one named by TTS_PYTHON).
"""
import os
import sys
from pathlib import Path

STUDIO = Path(__file__).resolve().parent / "tts-studio"
ENGINE = STUDIO / "engine" / "kokoro_engine.py"


def main():
    python = Path(os.environ.get("TTS_PYTHON") or STUDIO.parent / ".venv" / "bin" / "python")
    if not python.exists():
        sys.exit(f"Kokoro is not installed yet. Run this once:\n    {STUDIO.parent}/install.sh")
    os.execv(str(python), [str(python), str(ENGINE), *sys.argv[1:]])


if __name__ == "__main__":
    main()
