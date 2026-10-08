#!/usr/bin/env python3
"""Fix the mistakes a model makes most often in scenes.py, without asking a model.

    python3 autofix.py <project> --report check.json    # prints {"changed": true, "fixes": [...]}

Two kinds of fix, both safe to apply blindly:

  names that never exist in ManimGL, from the other Manim or from habit:
      MathTex -> Tex, Create -> ShowCreation, axes.plot -> axes.get_graph,
      self.camera.frame -> self.frame, GRAY -> GREY, LIGHT_GREY -> GREY_B, ...
  a mark or block name one typo away from a real one, when check.py's report names
  the line and lists the real ones and exactly one of them is close.

The lesson writer runs this before asking Claude to fix a failing check, and asks only
about what is left. Standard library only.
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

# (name, pattern, replacement, what to say). Each pattern only matches names ManimGL does not
# have; `name` is skipped when the file defines it itself, as a class, function or variable.
RENAMES = [
    ("MathTex", r"\bMathTex\(", "Tex(", "MathTex is Tex in ManimGL"),
    ("Create", r"(?<![\w.])Create\(", "ShowCreation(", "Create is ShowCreation in ManimGL"),
    (None, r"\.plot\(", ".get_graph(", "axes.plot is axes.get_graph in ManimGL"),
    (None, r"\bself\.camera\.frame\b", "self.frame", "the camera frame is self.frame in ManimGL"),
    (None, r"^from manim import \*", "from manimlib import *", "the module is manimlib"),
    ("LIGHT_GREY", r"\bLIGHT_GR[EA]Y\b", "GREY_B", "ManimGL has no LIGHT_GREY; GREY_B is the light grey"),
    ("DARK_GREY", r"\bDARK_GR[EA]Y\b", "GREY_D", "ManimGL has no DARK_GREY; GREY_D is the dark grey"),
    ("GRAY", r"\bGRAY(_[A-E])?\b", r"GREY\1", "ManimGL spells it GREY"),
]

_UNKNOWN_MARK = re.compile(r'^line (\d+): block "([^"]+)" has no mark "([^"]+)"\. Its marks: (.*)$')
_UNKNOWN_BLOCK = re.compile(r'^line (\d+): self\.voiceover\("([^"]+)"\) names a block that is not in the script\. Blocks: (.*)$')


def closest(wrong, known):
    """The one known name close to `wrong`, or None when there is none or more than one."""
    if not known:
        return None
    same_case = [k for k in known if k.lower() == wrong.lower()]
    if len(same_case) == 1:
        return same_case[0]
    close = difflib.get_close_matches(wrong, known, n=2, cutoff=0.75)
    return close[0] if len(close) == 1 else None


def rename_on_line(lines, number, wrong, right):
    """Swap the string literal "wrong" for "right" on one line. True if it was there."""
    i = number - 1
    if not 0 <= i < len(lines):
        return False
    new = re.sub(rf'(["\']){re.escape(wrong)}\1', lambda m: f"{m.group(1)}{right}{m.group(1)}", lines[i])
    if new == lines[i]:
        return False
    lines[i] = new
    return True


def fix_source(source, errors=()):
    """Return (new source, [what was fixed])."""
    fixes = []
    defined = set(re.findall(r"^\s*(?:class|def)\s+(\w+)|^(\w+)\s*=", source, re.M))
    defined = {a or b for a, b in defined}
    for name, pattern, replacement, why in RENAMES:
        if name and name in defined:
            continue
        new, n = re.subn(pattern, replacement, source, flags=re.M)
        if n:
            source = new
            fixes.append(f"{why} ({n}x)")
    lines = source.split("\n")
    for e in errors:
        if e.get("where", "").endswith("script.txt"):
            continue
        message = e.get("message", "")
        m = _UNKNOWN_MARK.match(message)
        if m:
            number, block, wrong, known = int(m.group(1)), m.group(2), m.group(3), m.group(4)
            right = closest(wrong, [k.strip() for k in known.split(",") if k.strip() and k.strip() != "none"])
            if right and rename_on_line(lines, number, wrong, right):
                fixes.append(f'line {number}: mark "{wrong}" in block "{block}" is "{right}"')
            continue
        m = _UNKNOWN_BLOCK.match(message)
        if m:
            number, wrong, known = int(m.group(1)), m.group(2), m.group(3)
            right = closest(wrong, [k.strip() for k in known.split(",") if k.strip()])
            if right and rename_on_line(lines, number, wrong, right):
                fixes.append(f'line {number}: block "{wrong}" is "{right}"')
    return "\n".join(lines), fixes


def autofix(root, errors=()):
    path = Path(root) / "scenes.py"
    config = Path(root) / "project.json"
    if config.is_file():
        path = Path(root) / json.loads(config.read_text(encoding="utf-8")).get("scenes_file", "scenes.py")
    source = path.read_text(encoding="utf-8")
    new, fixes = fix_source(source, errors)
    if new != source:
        path.write_text(new, encoding="utf-8")
    return {"changed": new != source, "fixes": fixes}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Fix common mistakes in a project's scenes.py.")
    ap.add_argument("project", help="path to a project folder")
    ap.add_argument("--report", help="check.py's JSON report, for fixes that need its errors")
    args = ap.parse_args(argv)
    errors = json.loads(Path(args.report).read_text(encoding="utf-8")).get("errors", []) if args.report else []
    print(json.dumps(autofix(Path(args.project), errors)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
