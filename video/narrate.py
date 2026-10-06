#!/usr/bin/env python3
"""Narrate pass: speak a project's script with Kokoro and write its manifest.

    ../tts-studio/.venv/bin/python narrate.py demo            # video/projects/demo
    ../tts-studio/.venv/bin/python narrate.py path/to/project --force

Reads <project>/project.json and its script, writes one WAV per block into
<project>/build/audio/ and <project>/build/manifest.json. A block is only spoken
again when its text, voice or speed changes.

Run it with the Python in tts-studio/.venv; build.py does that for you. Nothing
here imports torch until a block actually needs speaking.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE_DIR = HERE.parent / "tts-studio" / "engine"
CACHE_VERSION = 1  # bump when a change here or in the engine alters the audio or the timings

_BLOCK = re.compile(r"^\[([A-Za-z0-9_-]+)\]\s*$")
_MARK = re.compile(r"""<mark\s+name\s*=\s*["']([A-Za-z0-9_-]+)["']\s*/>""")
_TAG = re.compile(r"<[^>]*>")


class ScriptError(Exception):
    pass


# ---------- script ----------

def parse_script(source):
    """Split script text into [(block_id, text)]. Lines starting with # are comments."""
    blocks, cur = [], None
    for n, line in enumerate(source.lstrip("﻿").replace("\r\n", "\n").split("\n"), 1):
        if line.lstrip().startswith("#"):
            continue
        m = _BLOCK.match(line.strip())
        if m:
            if any(b[0] == m.group(1) for b in blocks):
                raise ScriptError(f"line {n}: block [{m.group(1)}] is defined twice")
            cur = [m.group(1), []]
            blocks.append(cur)
        elif cur is not None:
            cur[1].append(line.rstrip())
        elif line.strip():
            raise ScriptError(f"line {n}: text before the first [block-id] line")
    out = []
    for bid, lines in blocks:
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
        if not text:
            raise ScriptError(f"block [{bid}] has no text")
        out.append((bid, text))
    if not out:
        raise ScriptError("the script has no [block-id] lines")
    return out


def strip_marks(text):
    """Remove <mark name="x"/> tags. Returns (spoken_text, {name: char offset in spoken_text})."""
    out, marks, pos = "", {}, 0
    for m in _MARK.finditer(text):
        chunk = text[pos:m.start()]
        if out.endswith(" ") and chunk.startswith(" "):
            chunk = chunk[1:]  # "a <mark/> b" speaks as "a b", not "a  b"
        out += chunk
        if m.group(1) in marks:
            raise ScriptError(f'mark "{m.group(1)}" appears twice in one block')
        marks[m.group(1)] = len(out)
        pos = m.end()
    chunk = text[pos:]
    if out.endswith(" ") and chunk.startswith(" "):
        chunk = chunk[1:]
    out += chunk
    stray = _TAG.search(out)
    if stray:
        raise ScriptError(f'unknown tag {stray.group(0)!r}; the only tag is <mark name="x"/>')
    return out, marks


# ---------- timing ----------

def locate_words(text, words, window=40):
    """Character offset in `text` of each timed word, or None where it cannot be found.

    Kokoro's tokens are verbatim pieces of the input, in order, so each is matched at
    the cursor after skipping whitespace; a short forward search covers anything the
    tokenizer skipped (Kokoro drops untimed tokens such as a lone "$").
    """
    positions, cursor = [], 0
    for w in words:
        tok = w["text"]
        at = cursor
        while at < len(text) and text[at].isspace():
            at += 1
        if not tok:
            positions.append(None)
            continue
        if not text.startswith(tok, at):
            at = text.find(tok, cursor, cursor + window + len(tok))
        if at < 0:
            positions.append(None)
            continue
        positions.append(at)
        cursor = at + len(tok)
    return positions


def resolve_marks(text, marks, words):
    """Map each mark to the start time of the first spoken word at or after it.

    Returns ({name: seconds}, [warnings]). Punctuation-only tokens are not words,
    so a mark before an opening quote lands on the word inside it.
    """
    if not marks:
        return {}, []
    if not words:
        return {}, [f"no word timing for this voice, so marks {sorted(marks)} are ignored (block-level sync only)"]
    positions = locate_words(text, words)
    spoken = [(p, w) for p, w in zip(positions, words) if p is not None and any(c.isalnum() for c in w["text"])]
    out, warnings = {}, []
    missed = sum(p is None for p in positions)
    if missed:
        warnings.append(f"{missed} timed token(s) could not be matched to the script text; marks near them may be late")
    for name, offset in marks.items():
        hit = next((w for p, w in spoken if p >= offset), None)
        if hit is None:
            out[name] = round(words[-1]["end"], 4)
            warnings.append(f'mark "{name}" has no word after it; using the end of speech ({out[name]:.2f}s)')
        else:
            out[name] = hit["start"]
    return out, warnings


def block_key(text, voice, speed):
    payload = json.dumps({"text": text, "voice": voice, "speed": float(speed), "v": CACHE_VERSION}, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---------- project ----------

def project_dir(name_or_path):
    p = Path(name_or_path).expanduser()
    if not p.is_dir():
        p = HERE / "projects" / name_or_path
    if not (p / "project.json").is_file():
        raise ScriptError(f"No project.json in {p}. Projects live in video/projects/<name>/.")
    return p.resolve()


def load_project(root):
    config = json.loads((root / "project.json").read_text(encoding="utf-8"))
    config.setdefault("script", "script.txt")
    config.setdefault("voice", "af_heart")
    config.setdefault("speed", 1.0)
    return config


def narrate(root, synthesize, force=False, log=print):
    """Speak every block of the project at `root` and write build/manifest.json.

    `synthesize(text, out_path, voice, speed)` must write a WAV and return the
    engine's result dict (durationSec, words). Returns the manifest.
    """
    config = load_project(root)
    voice, speed = config["voice"], float(config["speed"])
    blocks = parse_script((root / config["script"]).read_text(encoding="utf-8"))
    build = root / "build"
    audio_dir = build / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    manifest = {"project": root.name, "voice": voice, "speed": speed, "sampleRate": 24000, "order": [], "blocks": {}}
    keep = set()
    for bid, raw in blocks:
        text, marks = strip_marks(raw)
        key = block_key(text, voice, speed)
        wav = audio_dir / f"{bid}-{key}.wav"
        meta = wav.with_suffix(".json")
        keep.update({wav.name, meta.name})
        if force or not (wav.is_file() and meta.is_file()):
            log(f"  speak  [{bid}]")
            tmp = wav.with_name(f".{wav.name}.part")
            try:
                result = synthesize(text, tmp, voice, speed)
            except BaseException:
                tmp.unlink(missing_ok=True)
                raise
            tmp.replace(wav)
            meta.write_text(json.dumps({"durationSec": result["durationSec"], "words": result["words"]}), encoding="utf-8")
        else:
            log(f"  cached [{bid}]")
        timing = json.loads(meta.read_text(encoding="utf-8"))
        resolved, warnings = resolve_marks(text, marks, timing["words"])
        for w in warnings:
            log(f"  warning [{bid}]: {w}")
        manifest["order"].append(bid)
        manifest["blocks"][bid] = {
            "wav": wav.relative_to(build).as_posix(),
            "duration": timing["durationSec"],
            "text": text,
            "words": timing["words"],
            "marks": resolved,
        }

    for f in audio_dir.iterdir():  # audio from edited or deleted blocks
        if f.name not in keep:
            f.unlink()
    out = build / "manifest.json"
    tmp = out.with_name(".manifest.json.part")
    tmp.write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(out)
    return manifest


def kokoro_synthesizer():
    """A synthesize() for narrate() backed by the real engine, loaded on first use."""
    sys.path.insert(0, str(ENGINE_DIR))
    from kokoro_engine import Engine

    engine = None

    def synthesize(text, out, voice, speed):
        nonlocal engine
        engine = engine or Engine()
        return engine.synthesize(text, out, voice=voice, speed=speed, fmt="WAV")  # never MP3: encoder padding shifts timing

    return synthesize


def main(argv=None):
    ap = argparse.ArgumentParser(description="Speak a video project's narration blocks with Kokoro.")
    ap.add_argument("project", help="project name under video/projects/, or a path to a project folder")
    ap.add_argument("--force", action="store_true", help="speak every block again, ignoring the cache")
    args = ap.parse_args(argv)
    try:
        root = project_dir(args.project)
        print(f"Narrating {root.name}", file=sys.stderr)
        manifest = narrate(root, kokoro_synthesizer(), force=args.force, log=lambda m: print(m, file=sys.stderr))
    except ScriptError as e:
        sys.exit(f"error: {e}")
    except Exception as e:
        if type(e).__name__ != "EngineError":  # bad voice, model missing: say so without a traceback
            raise
        sys.exit(f"error: {e}")
    total = sum(b["duration"] for b in manifest["blocks"].values())
    print(f"{len(manifest['order'])} blocks, {total:.1f}s of narration -> {root / 'build' / 'manifest.json'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
