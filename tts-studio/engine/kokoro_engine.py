#!/usr/bin/env python3
"""Local Kokoro text-to-speech engine. No API key, no quota, works offline.

Command line:
    kokoro_engine.py script.txt                 # writes script.mp3 next to the input
    kokoro_engine.py script.txt -o out.wav      # .mp3, .wav, .flac or .ogg
    kokoro_engine.py - -o out.mp3 < script.txt  # read text from stdin
    kokoro_engine.py script.txt --voice bm_george --speed 1.1
    kokoro_engine.py script.txt -o out.wav --timings out.json   # also save word start/end times
    kokoro_engine.py --list-voices

Other modes:
    kokoro_engine.py warmup   # download the model and voices once, then check they work
    kokoro_engine.py worker   # JSON lines on stdin/stdout; this is what the dashboard runs

Run it with the Python in the repo's .venv (../../install.sh creates it).
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import time
import warnings
from pathlib import Path

REPO_ID = "hexgrad/Kokoro-82M"
MODEL_FILE = "kokoro-v1_0.pth"
SAMPLE_RATE = 24000
DEFAULT_VOICE = "af_heart"
MAX_PHONEMES = 510  # Kokoro truncates anything longer, so segments must stay under it

# The first letter of a voice id picks the language. `needs` lists modules the
# language depends on, `setup` is the command that installs them, and `limit` is
# the longest segment in characters.
LANGUAGES = {
    "a": {"name": "American English", "limit": 400},
    "b": {"name": "British English", "limit": 400},
    "e": {"name": "Spanish", "limit": 220},
    "f": {"name": "French", "limit": 220},
    "h": {"name": "Hindi", "limit": 220},
    "i": {"name": "Italian", "limit": 220},
    "p": {"name": "Brazilian Portuguese", "limit": 220},
    "j": {"name": "Japanese", "limit": 80, "needs": ["pyopenjtalk", "unidic"], "setup": "npm run setup:japanese"},
    "z": {"name": "Mandarin Chinese", "limit": 80, "needs": ["pypinyin", "jieba", "cn2an"], "setup": "npm run setup"},
}

SAMPLES = {
    "a": "Hi there. This is how I sound when I read your scripts.",
    "b": "Hello there. This is how I sound when I read your scripts.",
    "e": "Hola. Así es como sueno cuando leo tus guiones.",
    "f": "Bonjour. Voici ma voix quand je lis vos textes.",
    "h": "नमस्ते। जब मैं आपकी स्क्रिप्ट पढ़ता हूँ तो मेरी आवाज़ ऐसी लगती है।",
    "i": "Ciao. Ecco come suona la mia voce quando leggo i tuoi testi.",
    "p": "Olá. É assim que eu soo quando leio os seus roteiros.",
    "j": "こんにちは。これが私の声です。",
    "z": "你好。这就是我朗读时的声音。",
}

PARAGRAPH_PAUSE = 0.45
LINE_PAUSE = 0.2
FORMATS = {".mp3": "MP3", ".wav": "WAV", ".flac": "FLAC", ".ogg": "OGG"}


class EngineError(Exception):
    pass


# ---------- text ----------

def clean(text, strip_markdown=True):
    """Strip markdown and tidy whitespace so the text reads naturally when spoken."""
    t = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    if strip_markdown:
        t = re.sub(r"```.*?```", "", t, flags=re.S)  # fenced code blocks
        t = re.sub(r"`([^`]*)`", r"\1", t)  # inline code
        t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", t)  # images
        # links -> link text, except Kokoro pronunciation hints like [word](/fəˈnɛtɪks/)
        t = re.sub(r"\[([^\]]+)\]\((?!/[^)]*/\))[^)]*\)", r"\1", t)
        t = re.sub(r"^#{1,6}[ \t]*", "", t, flags=re.M)  # heading markers
        t = re.sub(r"^[ \t]*[-*+][ \t]+", "", t, flags=re.M)  # bullet markers
        t = re.sub(r"(\*{1,3})([^*\n]+)\1", r"\2", t)  # *italic* **bold**
        t = re.sub(r"(?<!\w)(_{1,3})([^_\n]+)\1(?!\w)", r"\2", t)  # _italic_, not snake_case
    t = re.sub(r"[ \t]+\n", "\n", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+|(?<=[。！？])")
_LINE_END = tuple(".!?…:;。！？\"')”’")


def _hard_split(s, limit):
    out, rest = [], s.strip()
    while len(rest) > limit:
        cut = rest.rfind(" ", 0, limit)
        if cut < limit * 0.5:
            cut = limit
        out.append(rest[:cut].strip())
        rest = rest[cut:].strip()
    if rest:
        out.append(rest)
    return out


def _lines(paragraph):
    """Rejoin hard-wrapped prose, but keep real line breaks (list items, headings, verse)."""
    out = []
    for line in paragraph.split("\n"):
        line = line.strip()
        if not line:
            continue
        wrapped = out and len(out[-1]) >= 60 and not out[-1].endswith(_LINE_END)
        if wrapped:
            out[-1] = f"{out[-1]} {line}"
        else:
            out.append(line)
    return out


def split_segments(text, limit):
    """Cut text into [(segment, pause_after_seconds)], each at most `limit` characters.

    Prefers paragraph breaks, then line breaks, then sentence ends, then spaces.
    """
    segments = []
    for paragraph in re.split(r"\n\s*\n", text):
        for line in _lines(paragraph):
            cur = ""
            for sentence in _SENTENCE_END.split(line):
                sentence = sentence.strip() if sentence else ""
                if not sentence:
                    continue
                for piece in [sentence] if len(sentence) <= limit else _hard_split(sentence, limit):
                    if cur and len(cur) + 1 + len(piece) > limit:
                        segments.append([cur, 0.0])
                        cur = piece
                    else:
                        cur = f"{cur} {piece}" if cur else piece
            if cur:
                segments.append([cur, LINE_PAUSE])
        if segments:
            segments[-1][1] = PARAGRAPH_PAUSE
    if segments:
        segments[-1][1] = 0.0
    return [tuple(s) for s in segments]


# ---------- model files ----------

def _hub_cache():
    if os.environ.get("HF_HUB_CACHE"):
        return Path(os.environ["HF_HUB_CACHE"])
    home = os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface"
    return Path(home) / "hub"


def cached_snapshot():
    """Folder holding the downloaded model and voices, or None if they are not all there yet."""
    snapshots = _hub_cache() / f"models--{REPO_ID.replace('/', '--')}" / "snapshots"
    if not snapshots.is_dir():
        return None
    for snap in sorted(snapshots.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        voices = snap / "voices"
        if (snap / MODEL_FILE).exists() and (snap / "config.json").exists() and voices.is_dir():
            if len(list(voices.glob("*.pt"))) >= 20:
                return snap
    return None


def download():
    """Fetch the model weights and every voice (about 350 MB, once)."""
    from huggingface_hub import snapshot_download

    snapshot_download(REPO_ID, allow_patterns=["config.json", MODEL_FILE, "voices/*.pt"])


def language_status(code):
    info = LANGUAGES[code]
    missing = [m for m in info.get("needs", []) if importlib.util.find_spec(m) is None]
    if code == "j" and not missing:
        # The unidic package is only a stub until its dictionary has been downloaded.
        dicdir = Path(importlib.util.find_spec("unidic").origin).parent / "dicdir"
        missing = [] if (dicdir / "mecabrc").exists() else ["unidic dictionary"]
    return {
        "code": code,
        "name": info["name"],
        "available": not missing,
        "hint": f'Needs an extra install: run `{info["setup"]}` in tts-studio' if missing else None,
    }


def list_voices():
    snap = cached_snapshot()
    if not snap:
        return []
    voices = []
    for f in sorted((snap / "voices").glob("*.pt")):
        vid = f.stem
        if len(vid) < 4 or vid[0] not in LANGUAGES or vid[2] != "_":
            continue
        voices.append({
            "voiceId": vid,
            "name": vid[3:].replace("_", " ").title(),
            "lang": vid[0],
            "gender": {"f": "female", "m": "male"}.get(vid[1], ""),
        })
    return voices


# ---------- synthesis ----------

def speak_segments(pipeline, segments, voice, speed, write, pad, on_progress=None):
    """Run each (segment, pause) through the pipeline, handing audio to `write` and silence
    lengths to `pad`. Returns (samples, truncated, words).

    `words` is [{text, start, end}] in seconds from the start of the output. Kokoro times
    each token against its own result's audio, so each is offset by the samples written
    before that result, pauses included. Voices without word timing (anything but
    English) give an empty list.
    """
    samples = truncated = 0
    words = []
    for n, (segment, pause) in enumerate(segments, 1):
        for result in pipeline(segment, voice=voice, speed=speed, split_pattern=None):
            if result.audio is None:
                continue
            truncated += len(result.phonemes or "") >= MAX_PHONEMES
            offset = samples / SAMPLE_RATE
            for token in getattr(result, "tokens", None) or []:
                if token.start_ts is None or token.end_ts is None:
                    continue
                words.append({
                    "text": token.text,
                    "start": round(offset + token.start_ts, 4),
                    "end": round(offset + token.end_ts, 4),
                })
            audio = result.audio.detach().cpu().numpy()
            write(audio)
            samples += len(audio)
        if pause and samples:
            silence = int(pause * SAMPLE_RATE)
            pad(silence)
            samples += silence
        if on_progress:
            on_progress(n, len(segments))
    return samples, truncated, words

class Engine:
    def __init__(self, device=None):
        # "auto" uses the Apple GPU when there is one (about twice as fast), else the CPU.
        self.device = device or os.environ.get("TTS_DEVICE") or "auto"
        self.model = None
        self.pipelines = {}

    def load(self):
        if self.model is not None:
            return
        if cached_snapshot():
            # Everything is on disk, so never touch the network.
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
        else:
            try:
                download()
            except Exception as e:
                raise EngineError(
                    f"The Kokoro model is not downloaded yet and the download failed ({e}). "
                    "Connect to the internet once and run `npm run setup`."
                ) from e
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        warnings.filterwarnings("ignore", module=r"torch\..*")  # deprecation chatter from the model code
        import torch
        from kokoro import KModel

        if self.device == "auto":
            self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.model = KModel(repo_id=REPO_ID).to(self.device).eval()

    def warm(self):
        """Load the model and speak once, dropping back to the CPU if the GPU misbehaves."""
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            try:
                self.synthesize("Ready.", Path(tmp) / "warm.wav")
            except EngineError:
                raise
            except Exception as e:
                if self.device != "mps":
                    raise
                print(f"warning: GPU synthesis failed ({e}); using the CPU instead", file=sys.stderr)
                self.device, self.model, self.pipelines = "cpu", None, {}
                self.synthesize("Ready.", Path(tmp) / "warm.wav")

    def pipeline(self, lang):
        if lang not in self.pipelines:
            status = language_status(lang)
            if not status["available"]:
                raise EngineError(f"{status['name']} voices are not set up. {status['hint']}")
            self.load()
            from kokoro import KPipeline

            self.pipelines[lang] = KPipeline(lang_code=lang, repo_id=REPO_ID, model=self.model)
        return self.pipelines[lang]

    def synthesize(self, text, out, voice=DEFAULT_VOICE, speed=1.0, fmt=None, on_progress=None):
        """Speak `text` into the file `out`. Returns duration, size, segment count and word timings."""
        import numpy as np
        import soundfile as sf

        lang = voice[:1]
        if lang not in LANGUAGES or not re.fullmatch(r"[a-z]{2}_[a-z0-9_]+", voice):
            raise EngineError(f"Unknown voice '{voice}'. Use --list-voices, or the dashboard's voice menu, to see the choices.")
        self.load()
        if not (cached_snapshot() / "voices" / f"{voice}.pt").exists():
            raise EngineError(f"Unknown voice '{voice}'. Use --list-voices, or the dashboard's voice menu, to see the choices.")
        pipeline = self.pipeline(lang)
        segments = split_segments(text, LANGUAGES[lang]["limit"])
        if not segments:
            raise EngineError("There is nothing to speak.")

        out = Path(out)
        fmt = (fmt or FORMATS.get(out.suffix.lower()) or "MP3").upper()
        kwargs = {"bitrate_mode": "CONSTANT", "compression_level": 0.5} if fmt == "MP3" else {}
        with sf.SoundFile(str(out), "w", samplerate=SAMPLE_RATE, channels=1, format=fmt, **kwargs) as f:
            samples, truncated, words = speak_segments(
                pipeline,
                segments,
                voice,
                speed,
                write=f.write,
                pad=lambda n: f.write(np.zeros(n, dtype="float32")),
                on_progress=on_progress,
            )
        if not samples:
            out.unlink(missing_ok=True)
            raise EngineError("Kokoro produced no audio for this text.")
        if truncated:
            print(f"warning: {truncated} segment(s) hit the phoneme limit and may be cut short", file=sys.stderr)
        return {
            "durationSec": samples / SAMPLE_RATE,
            "bytes": out.stat().st_size,
            "segments": len(segments),
            "words": words,
        }


# ---------- modes ----------

def worker():
    """Serve JSON-line requests from the dashboard until stdin closes."""
    # Libraries print to stdout; keep the protocol on its own handle and send the rest to stderr.
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def send(**msg):
        proto.write(json.dumps(msg) + "\n")
        proto.flush()

    engine = Engine()
    try:
        engine.warm()
    except Exception as e:  # report it and exit; the server shows the message
        send(event="fatal", message=str(e))
        return 1
    send(
        event="ready",
        device=engine.device,
        voices=list_voices(),
        languages=[language_status(c) for c in LANGUAGES],
        samples=SAMPLES,
    )
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            result = engine.synthesize(
                req["text"],
                req["out"],
                voice=req.get("voice") or DEFAULT_VOICE,
                speed=float(req.get("speed") or 1.0),
                fmt=req.get("format"),
                on_progress=lambda done, total: send(id=rid, event="progress", done=done, total=total),
            )
            words = result.pop("words")
            if req.get("timings"):  # opt-in, so long jobs do not send a huge line nobody reads
                result["words"] = words
            send(id=rid, event="done", **result)
        except Exception as e:
            try:
                Path(req.get("out", "")).unlink(missing_ok=True)
            except OSError:
                pass
            send(id=rid, event="error", message=str(e) or type(e).__name__)
    return 0


def warmup():
    """Download everything once and prove each installed language can speak."""
    import tempfile

    if not cached_snapshot():
        print("Downloading the Kokoro model and voices (about 350 MB)...", file=sys.stderr)
        download()
    engine = Engine()
    engine.warm()
    voices = list_voices()
    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        for code in LANGUAGES:
            status = language_status(code)
            voice = next((v["voiceId"] for v in voices if v["lang"] == code), None)
            if not status["available"] or not voice:
                print(f"  skip  {status['name']}: {status['hint'] or 'no voices found'}", file=sys.stderr)
                continue
            try:
                t0 = time.time()
                r = engine.synthesize(SAMPLES[code], Path(tmp) / f"{code}.mp3", voice=voice)
                print(f"  ok    {status['name']} ({voice}, {r['durationSec']:.1f}s of audio in {time.time() - t0:.1f}s)", file=sys.stderr)
            except Exception as e:
                ok = False
                print(f"  FAIL  {status['name']}: {e}", file=sys.stderr)
    print(f"{len(voices)} voices ready on {engine.device}." if ok else "Some languages failed; see above.", file=sys.stderr)
    return 0 if ok else 1


def print_voices():
    voices = list_voices()
    if not voices:
        sys.exit("The model is not downloaded yet. Run `npm run setup` in tts-studio.")
    for code in LANGUAGES:
        status = language_status(code)
        mine = [v for v in voices if v["lang"] == code]
        if not mine:
            continue
        note = "" if status["available"] else f"  ({status['hint']})"
        print(f"{status['name']}{note}")
        for v in mine:
            print(f"  {v['voiceId']:<16} {v['name']} ({v['gender']})")
    return 0


def speak(argv):
    ap = argparse.ArgumentParser(prog="tts.py", description="Convert a text file to speech with Kokoro, locally.")
    ap.add_argument("input", nargs="?", help="path to a text/markdown file, or - for stdin")
    ap.add_argument("-o", "--output", help="output path: .mp3 (default), .wav, .flac or .ogg")
    ap.add_argument("--voice", default=os.environ.get("TTS_VOICE") or DEFAULT_VOICE, help=f"voice id (default {DEFAULT_VOICE})")
    ap.add_argument("--speed", type=float, default=1.0, help="speaking rate, 0.5 to 2.0 (default 1.0)")
    ap.add_argument("--raw", action="store_true", help="skip markdown cleanup")
    ap.add_argument("--timings", metavar="JSON", help="also write word start/end times (English voices only) to this file")
    ap.add_argument("--list-voices", action="store_true", help="show the available voices and exit")
    args = ap.parse_args(argv)

    if args.list_voices:
        return print_voices()
    if not args.input:
        ap.error("an input file is required (or - for stdin)")
    if not 0.5 <= args.speed <= 2.0:
        ap.error("--speed must be between 0.5 and 2.0")

    if args.input == "-":
        text = sys.stdin.read()
        out = Path(args.output or "output.mp3").expanduser()
    else:
        src = Path(args.input).expanduser()
        if not src.is_file():
            sys.exit(f"Input file not found: {src}")
        text = src.read_text(encoding="utf-8")
        out = Path(args.output).expanduser() if args.output else src.with_suffix(".mp3")
    if out.suffix.lower() not in FORMATS:
        sys.exit(f"Unsupported output type '{out.suffix}'. Use one of: {', '.join(FORMATS)}")

    text = text.strip() if args.raw else clean(text)
    if not text:
        sys.exit("Input text is empty.")

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.part")
    t0 = time.time()

    def progress(done, total):
        print(f"\rSynthesizing {done}/{total}...", end="", file=sys.stderr, flush=True)

    try:
        result = Engine().synthesize(text, tmp, voice=args.voice, speed=args.speed, fmt=FORMATS[out.suffix.lower()], on_progress=progress)
    except EngineError as e:
        tmp.unlink(missing_ok=True)
        sys.exit(f"\n{e}")
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    tmp.replace(out)
    if args.timings:
        timings = Path(args.timings).expanduser()
        timings.parent.mkdir(parents=True, exist_ok=True)
        timings.write_text(json.dumps({"durationSec": result["durationSec"], "words": result["words"]}, indent=1), encoding="utf-8")
    print(f"\r{result['durationSec']:.1f}s of audio in {time.time() - t0:.1f}s.   ", file=sys.stderr)
    print(str(out.resolve()))
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["worker"]:
        return worker()
    if argv[:1] == ["warmup"]:
        return warmup()
    return speak(argv)


if __name__ == "__main__":
    sys.exit(main())
