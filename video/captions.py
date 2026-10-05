"""SRT and VTT captions from narration word timings. Standard library only."""
import re

MAX_CHARS = 42  # one comfortable line
MAX_GAP = 0.6  # a longer silence starts a new caption
_OPENERS = tuple("“‘([¿¡")
_ENDS = tuple(".!?…。！？")


def join_tokens(words):
    """Fold punctuation-only tokens into their neighbours: [("Hello,", start, end), ...].

    Kokoro times commas and quotes as tokens of their own; captions want them on the words.
    """
    out, prefix, straight = [], "", 0
    for w in words:
        text = w["text"].strip()
        if not text:
            continue
        if not any(c.isalnum() for c in text):
            opens = text.startswith(_OPENERS)
            if text == '"':  # opens or closes depending on how many came before
                opens, straight = straight % 2 == 0, straight + 1
            if opens:
                prefix += text
            elif out:
                out[-1][0] += text
                out[-1][2] = max(out[-1][2], w["end"])
            continue
        out.append([prefix + text, w["start"], w["end"]])
        prefix = ""
    return [tuple(w) for w in out]


def group_cues(words, offset=0.0, max_chars=MAX_CHARS, max_gap=MAX_GAP):
    """Turn timed words into [(start, end, text)] captions, shifted by `offset` seconds."""
    cues, cur = [], []
    for word in join_tokens(words):
        if cur:
            text = " ".join(w[0] for w in cur)
            if (
                len(text) + 1 + len(word[0]) > max_chars
                or word[1] - cur[-1][2] > max_gap
                or cur[-1][0].endswith(_ENDS)
            ):
                cues.append(cur)
                cur = []
        cur.append(word)
    if cur:
        cues.append(cur)
    return [(offset + c[0][1], offset + c[-1][2], " ".join(w[0] for w in c)) for c in cues]


def block_cues(text, start, duration):
    """Captions for a block without word timing: sentences, timed by their share of the characters."""
    sentences = [s for s in re.split(r"(?<=[.!?…。！？])\s+", " ".join(text.split())) if s]
    total = sum(len(s) for s in sentences) or 1
    cues, t = [], start
    for s in sentences:
        end = t + duration * len(s) / total
        cues.append((t, end, s))
        t = end
    return cues


def _stamp(seconds, sep):
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02}{sep}{ms:03}"


def _tidy(cues):
    """Sort, and stop each caption before the next starts so players never show two."""
    cues = sorted(cues)
    out = []
    for i, (a, b, text) in enumerate(cues):
        if i + 1 < len(cues):
            b = min(b, cues[i + 1][0])
        if b > a:
            out.append((a, b, text))
    return out


def to_srt(cues):
    return "".join(
        f"{n}\n{_stamp(a, ',')} --> {_stamp(b, ',')}\n{text}\n\n" for n, (a, b, text) in enumerate(_tidy(cues), 1)
    )


def to_vtt(cues):
    return "WEBVTT\n\n" + "".join(f"{_stamp(a, '.')} --> {_stamp(b, '.')}\n{text}\n\n" for a, b, text in _tidy(cues))
