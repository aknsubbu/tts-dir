#!/usr/bin/env python3
"""Apply an edit that names only what changes to a project's script.txt and scenes.py.

    python3 splice.py projects/<name> --edit edit.json      # prints what changed, as JSON

A model revising a lesson, or fixing it, answers with the parts it changes instead of whole
files, which is shorter, cheaper, and leaves everything else exactly as it was:

    {
      "blocks":         [{"id": "chain", "text": "...", "after": ""},       replaced by id
                         {"id": "chain2", "text": "...", "after": "chain"}], new, after another block
      "remove_blocks":  ["old"],
      "classes":        [{"name": "Chain", "code": "class Chain(...):...", "after": ""}],
      "remove_classes": ["Unused"],
      "preamble":       ""        # the code above the first class, when it must change ("" keeps it)
    }

Blocks keep their place, their [id] line and the comments around them. A class is replaced by its
exact line range from Python's ast, decorators and the comment lines directly above it included;
a new one goes after the class `after` names, or at the end. Anything that cannot be applied
(an unknown block or class, code that does not parse, a class that does not define what it says)
is reported and nothing is written, so it can go back to the model like a check error.

Prints {"ok": bool, "errors": [...], "changed": {"blocks": [...], "new_blocks": [...],
"removed_blocks": [...], "classes": [...], "new_classes": [...], "removed_classes": [...],
"preamble": bool}}. Standard library only.
"""
import argparse
import ast
import json
import re
import sys
import textwrap
from pathlib import Path

import project_ast

_BLOCK = re.compile(r"^\s*\[([A-Za-z0-9_-]+)\]\s*$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,80}$")


class SpliceError(Exception):
    pass


# ---------- script.txt ----------

def split_script(source):
    """[{"id": None or block id, "lines": [...]}]: a lead-in, then one part per block. A block's part
    runs from its [id] line to the next one; comment and blank lines at its end belong to the next
    block, since they introduce it."""
    lines = source.replace("\r\n", "\n").split("\n")
    parts = [{"id": None, "lines": []}]
    for line in lines:
        m = _BLOCK.match(line)
        if m:
            prev = parts[-1]["lines"]
            tail = []
            while prev and (not prev[-1].strip() or prev[-1].lstrip().startswith("#")) and parts[-1]["id"] is not None:
                tail.insert(0, prev.pop())
            parts.append({"id": m.group(1), "lines": tail + [line], "header": len(tail)})
        else:
            parts[-1]["lines"].append(line)
    return parts


def _block_lines(part, text):
    """The block with new text: its lead-in comments, its [id] line, comments directly under it, then the text."""
    lines = part["lines"]
    head = part["header"]
    keep = lines[: head + 1]
    i = head + 1
    while i < len(lines) and lines[i].lstrip().startswith("#"):
        keep.append(lines[i])
        i += 1
    return keep + text.strip("\n").split("\n") + [""]


def splice_script(source, blocks, remove):
    parts = split_script(source)
    ids = [p["id"] for p in parts if p["id"]]
    changed, new, removed = [], [], []
    for bid in remove:
        if bid not in ids:
            raise SpliceError(f'remove_blocks names [{bid}], which is not in the script. Blocks: {", ".join(ids)}')
        parts = [p for p in parts if p["id"] != bid]
        ids.remove(bid)
        removed.append(bid)
    for b in blocks:
        bid, text, after = str(b.get("id", "")).strip(), str(b.get("text", "")), str(b.get("after") or "").strip()
        if not _ID.match(bid):
            raise SpliceError(f'"{bid}" is not a block id: letters, digits, - and _ only')
        if not text.strip():
            raise SpliceError(f"block [{bid}] has no text; to remove it, list it in remove_blocks")
        if bid in ids:
            part = next(p for p in parts if p["id"] == bid)
            old = "\n".join(part["lines"])
            part["lines"] = _block_lines(part, text)
            if "\n".join(part["lines"]) != old:
                changed.append(bid)
            continue
        if not after:
            raise SpliceError(f'block [{bid}] is not in the script. To add it, give "after": the block it comes after. Blocks: {", ".join(ids)}')
        if after not in ids:
            raise SpliceError(f'block [{bid}] is to go after [{after}], which is not in the script. Blocks: {", ".join(ids)}')
        at = next(i for i, p in enumerate(parts) if p["id"] == after) + 1
        part = {"id": bid, "lines": ["", f"[{bid}]"], "header": 1}
        part["lines"] = _block_lines(part, text)
        parts.insert(at, part)
        ids.insert(ids.index(after) + 1, bid)
        new.append(bid)
    out = "\n".join(line for p in parts for line in p["lines"])
    out = re.sub(r"\n{3,}", "\n\n", out).strip("\n") + "\n"
    return out, changed, new, removed


# ---------- scenes.py ----------

def _parse(code, what):
    try:
        return ast.parse(code)
    except SyntaxError as e:
        raise SpliceError(f"{what} does not parse: line {e.lineno}: {e.msg}: {(e.text or '').strip()}") from None


def _top_classes(tree):
    return {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}


def splice_scenes(source, classes, remove, preamble):
    tree = _parse(source, "scenes.py")
    lines = source.replace("\r\n", "\n").split("\n")
    existing = _top_classes(tree)
    changed, new, removed = [], [], []
    # Each operation replaces lines start..end (1-based, inclusive) of the original file with
    # `body`; with end = start - 1 it inserts before line start. They are applied bottom-up.
    ops = []

    def op(key, start, end, body):
        ops.append(((key, len(ops)), start, end, body))

    for name in remove:
        if name not in existing:
            raise SpliceError(f'remove_classes names {name}, which is not a class in scenes.py. Classes: {", ".join(existing)}')
        a, b = project_ast.class_span(existing[name], lines)
        op(a, a, b, [])
        removed.append(name)
    for c in classes:
        name, after = str(c.get("name", "")).strip(), str(c.get("after") or "").strip()
        code = textwrap.dedent(str(c.get("code", ""))).strip("\n")
        if not _NAME.match(name):
            raise SpliceError(f'"{name}" is not a class name')
        if name not in _top_classes(_parse(code, f"The code for {name}")):
            raise SpliceError(f"The code given for {name} does not define class {name}")
        if name in remove:
            raise SpliceError(f"{name} is both replaced and removed")
        if name in existing:
            a, b = project_ast.class_span(existing[name], lines)
            if "\n".join(lines[a - 1:b]) != code:
                op(a, a, b, code.split("\n"))
                changed.append(name)
            continue
        if after and after not in existing:
            raise SpliceError(f'{name} is to go after {after}, which is not a class in scenes.py. Classes: {", ".join(existing)}')
        at = project_ast.class_span(existing[after], lines)[1] if after else len(lines)
        op(at + 0.5, at + 1, at, ["", ""] + code.split("\n") + ([""] if after else []))
        new.append(name)

    first_class = min((project_ast.class_span(c, lines)[0] for c in existing.values()), default=len(lines) + 1)
    preamble_changed = False
    if preamble and preamble.strip():
        pre = textwrap.dedent(preamble).strip("\n")
        _parse(pre, "The preamble")
        if "\n".join(lines[: first_class - 1]).strip("\n") != pre:
            op(0, 1, first_class - 1, pre.split("\n") + ["", ""])
            preamble_changed = True

    out = list(lines)
    for _key, start, end, body in sorted(ops, key=lambda o: o[0], reverse=True):
        out[start - 1:end] = body
    result = re.sub(r"\n{4,}", "\n\n\n", "\n".join(out)).strip("\n") + "\n"
    _parse(result, "scenes.py after the edit")
    return result, changed, new, removed, preamble_changed


def apply(root, edit):
    """Apply `edit` to the project at `root`. Returns the report; writes only when everything applies."""
    root = Path(root)
    script_path, scenes_path = root / "script.txt", root / "scenes.py"
    report = {"ok": True, "errors": [], "changed": {}}
    try:
        script, b_changed, b_new, b_removed = splice_script(
            script_path.read_text(encoding="utf-8"), edit.get("blocks") or [], edit.get("remove_blocks") or [])
        scenes, c_changed, c_new, c_removed, pre = splice_scenes(
            scenes_path.read_text(encoding="utf-8"), edit.get("classes") or [], edit.get("remove_classes") or [], edit.get("preamble") or "")
    except SpliceError as e:
        return {"ok": False, "errors": [str(e)], "changed": {}}
    script_path.write_text(script, encoding="utf-8")
    scenes_path.write_text(scenes, encoding="utf-8")
    report["changed"] = {
        "blocks": b_changed, "new_blocks": b_new, "removed_blocks": b_removed,
        "classes": c_changed, "new_classes": c_new, "removed_classes": c_removed, "preamble": pre,
    }
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description="Apply an edit naming only what changes to a project's script and scenes.")
    ap.add_argument("project", help="path to a project folder")
    ap.add_argument("--edit", required=True, help="the edit as a JSON file, or - for stdin")
    args = ap.parse_args(argv)
    raw = sys.stdin.read() if args.edit == "-" else Path(args.edit).read_text(encoding="utf-8")
    try:
        edit = json.loads(raw)
    except ValueError as e:
        print(json.dumps({"ok": False, "errors": [f"The edit is not JSON: {e}"], "changed": {}}))
        return 1
    result = apply(args.project, edit)
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
