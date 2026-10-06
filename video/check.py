#!/usr/bin/env python3
"""Check a video project before it is built, and say what is wrong in plain words.

    python3 check.py demo                  # read the files, speak the script, try every scene
    python3 check.py demo --static         # only read the files; nothing is spoken or run
    python3 check.py demo --sync-scenes    # also set project.json's "scenes" to the classes found

Prints one JSON object on stdout:

    {"ok": false, "errors": [{"where": "scenes.py", "message": "..."}], "warnings": [...],
     "scenes": ["Intro"], "blocks": [{"id": "intro", "words": 41, "duration": 15.2}], "duration": 15.2}

An error means the build would fail. A warning means it would build but look or
sound wrong: animations that ran past a word or past the end of a block, text off
the edge of the frame, text on top of other text.

Each scene is tried with `manimgl -s -w`, which runs every line of it without
drawing the animations, so a broken scene is found in seconds. This is what the
lesson writer in tts-studio/author runs on what Claude wrote.
"""
import argparse
import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import build
import sandbox
from narrate import _MARK, ScriptError, load_project, parse_script

HERE = Path(__file__).resolve().parent

# What a scenes.py may import and call. The scenes are run as written, so keep this short.
# These rules catch accidents and the obvious ways out, and give Claude an error it can fix.
# They are not what confines a scene: sandbox.py is, by running it with no network and no
# writing outside its project.
ALLOWED_IMPORTS = {"manimlib", "voiceover", "numpy", "math", "random", "itertools", "functools", "sys", "pathlib"}
FORBIDDEN_NAMES = {"eval", "exec", "compile", "__import__", "open", "input", "breakpoint", "globals"}
# --strict is for scenes a model wrote (the lesson writer passes it). They have no reason to
# touch the system at all, so the modules a hand-written project uses to find its own files go
# too, along with the names that reach other modules indirectly.
STRICT_IMPORTS = ALLOWED_IMPORTS - {"sys", "pathlib"}
STRICT_NAMES = FORBIDDEN_NAMES | {
    "sys", "os", "sp", "subprocess", "shutil", "importlib", "builtins", "__builtins__", "pathlib", "Path",
    "getattr", "setattr", "delattr", "vars", "locals", "socket", "urllib", "requests", "pickle", "ctypes",
}
STRICT_ATTRS = {"system", "popen", "Popen", "load", "save", "savez", "savetxt", "loadtxt", "fromfile", "tofile", "memmap", "modules"}
SCENE_TIMEOUT = 600  # seconds for one scene to run without drawing; far more than any real one needs

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_PROGRESS = re.compile(r"\d+it \[|it/s\]|\|\s*\d+/\d+")


class Report:
    def __init__(self):
        self.errors, self.warnings = [], []

    def error(self, where, message):
        self.errors.append({"where": where, "message": message})

    def warn(self, where, message):
        self.warnings.append({"where": where, "message": message})


# ---------- reading the files ----------

def read_script(root, config, report):
    """{block_id: {"marks": set, "words": int}} in script order, or None if it cannot be read."""
    name = config["script"]
    try:
        blocks = parse_script((root / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return report.error(name, f"{name} is missing")
    except ScriptError as e:
        return report.error(name, str(e))
    out = {}
    for bid, text in blocks:
        marks = _MARK.findall(text)
        for m in sorted({m for m in marks if marks.count(m) > 1}):
            report.error(name, f'block [{bid}] uses the mark name "{m}" more than once')
        spoken = _MARK.sub("", text)
        if "<" in spoken and re.search(r"<[^>]*>", spoken):
            report.error(name, f'block [{bid}] has a tag that is not a mark; the only tag allowed is <mark name="x"/>')
        out[bid] = {"marks": set(marks), "words": len(spoken.split())}
    return out


def _literal(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _is_call_to(node, attr):
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == attr


def read_scenes(root, config, blocks, report, strict=False):
    """Scene class names in the order they are defined, or None if the file cannot be read."""
    name = config.get("scenes_file", "scenes.py")
    try:
        source = (root / name).read_text(encoding="utf-8")
    except FileNotFoundError:
        return report.error(name, f"{name} is missing")
    try:
        tree = ast.parse(source, filename=name)
    except SyntaxError as e:
        return report.error(name, f"line {e.lineno}: {e.msg}: {(e.text or '').strip()}")

    imports = STRICT_IMPORTS if strict else ALLOWED_IMPORTS
    names = STRICT_NAMES if strict else FORBIDDEN_NAMES
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for mod in mods:
                if mod.split(".")[0] not in imports:
                    report.error(name, f"line {node.lineno}: importing {mod} is not allowed; use only {', '.join(sorted(imports))}")
        elif isinstance(node, ast.Name) and node.id in names:
            report.error(name, f"line {node.lineno}: {node.id} is not allowed in a scene")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr.endswith("__") and node.attr != "__init__":
            report.error(name, f"line {node.lineno}: {node.attr} is not allowed in a scene")
        elif strict and isinstance(node, ast.Attribute) and node.attr in STRICT_ATTRS:
            report.error(name, f"line {node.lineno}: .{node.attr} is not allowed in a scene; scenes may not read or write files or run programs")
        elif strict and isinstance(node, ast.Constant) and isinstance(node.value, str) and re.search(r"__\w+__", node.value):
            report.error(name, f"line {node.lineno}: a string naming a double-underscore attribute is not allowed in a scene")

    scenes, used = [], {}
    for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
        bases = [b.id if isinstance(b, ast.Name) else getattr(b, "attr", "") for b in cls.bases]
        if "VoiceoverScene" not in bases:
            continue
        if bases[0] != "VoiceoverScene":
            report.error(name, f"line {cls.lineno}: class {cls.name} must list VoiceoverScene first, as in class {cls.name}(VoiceoverScene, Scene)")
        scenes.append(cls.name)
        for node in ast.walk(cls):
            if not isinstance(node, ast.With):
                continue
            for item in node.items:
                if not _is_call_to(item.context_expr, "voiceover"):
                    continue
                bid = _literal(item.context_expr.args[0]) if item.context_expr.args else None
                if bid is None:
                    report.error(name, f'line {node.lineno}: self.voiceover() needs the block id written out as a string, like self.voiceover("intro")')
                    continue
                if blocks is not None and bid not in blocks:
                    report.error(name, f'line {node.lineno}: self.voiceover("{bid}") names a block that is not in the script. Blocks: {", ".join(blocks)}')
                    continue
                if bid in used:
                    report.error(name, f'line {node.lineno}: block "{bid}" is already played by {used[bid]}; each block may be played once')
                used[bid] = cls.name
                var = item.optional_vars.id if isinstance(item.optional_vars, ast.Name) else None
                for call in ast.walk(node):
                    if not (_is_call_to(call, "until") or _is_call_to(call, "time_of")):
                        continue
                    if not (isinstance(call.func.value, ast.Name) and call.func.value.id == var):
                        continue
                    mark = _literal(call.args[0]) if call.args else None
                    if mark is None:
                        report.error(name, f'line {call.lineno}: {var}.{call.func.attr}() needs the mark name written out as a string')
                    elif blocks is not None and mark not in blocks[bid]["marks"]:
                        known = ", ".join(sorted(blocks[bid]["marks"])) or "none"
                        report.error(name, f'line {call.lineno}: block "{bid}" has no mark "{mark}". Its marks: {known}')
    if not scenes:
        report.error(name, "no scene classes found; each needs VoiceoverScene first in its bases, as in class Intro(VoiceoverScene, Scene)")
    for bid in blocks or {}:
        if bid not in used:
            report.error(name, f'narration block "{bid}" is never played; some scene must contain: with self.voiceover("{bid}") as vo:')
    return scenes


def check_static(root, report, sync_scenes=False, strict=False):
    """Read project.json, the script and the scenes. Returns (config, blocks, scenes)."""
    try:
        config = load_project(root)
    except (OSError, ValueError) as e:
        report.error("project.json", f"cannot be read: {e}")
        return None, None, None
    config.setdefault("scenes_file", "scenes.py")
    blocks = read_script(root, config, report)
    scenes = read_scenes(root, config, blocks, report, strict)
    if scenes and sync_scenes and config.get("scenes") != scenes:
        saved = json.loads((root / "project.json").read_text(encoding="utf-8"))
        saved["scenes"] = scenes
        (root / "project.json").write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")
        config["scenes"] = scenes
    elif scenes:
        for s in config.get("scenes") or []:
            if s not in scenes:
                report.error("project.json", f'"scenes" lists {s}, which is not a scene class in {config["scenes_file"]}')
        if not config.get("scenes"):
            report.error("project.json", '"scenes" is empty; list the scene classes to render, in order')
    return config, blocks, scenes


# ---------- running the scenes ----------

def tidy(output, limit=45):
    """The end of a command's output, without colour codes, progress bars or blank lines."""
    lines = []
    for raw in _ANSI.sub("", output).replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        if line.strip() and not _PROGRESS.search(line):
            lines.append(line)
    return "\n".join(lines[-limit:])


def narrate(root, report):
    if not Path(build.KOKORO_PYTHON).exists():
        report.error("narration", f"no Kokoro Python at {build.KOKORO_PYTHON}; run `npm run setup` in tts-studio")
        return None
    print(f"$ narrate.py {root}", file=sys.stderr, flush=True)
    done = subprocess.run(
        [build.KOKORO_PYTHON, str(HERE / "narrate.py"), str(root)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    for line in done.stdout.splitlines():
        if "warning [" in line:  # a mark that could not be placed on a word
            report.warn("script.txt", line.strip().replace("warning ", "", 1))
    if done.returncode:
        report.error("narration", tidy(done.stdout, 12))
        return None
    return json.loads((root / "build" / "manifest.json").read_text(encoding="utf-8"))


def try_scene(root, config, scene, report):
    """Run one scene without drawing its animations, and collect what it reports."""
    out = root / "build" / "check"
    result = out / f"{scene}.json"
    result.unlink(missing_ok=True)
    env = {
        **os.environ,
        "VOICEOVER_MANIFEST": str(root / "build" / "manifest.json"),
        "VOICEOVER_REPORT": str(result),
        "VOICEOVER_SNAPSHOTS": str(out / "frames"),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH")])),
        "COLUMNS": "200", "NO_COLOR": "1", "TERM": "dumb",
    }
    print(f"$ manimgl {config['scenes_file']} {scene} -s", file=sys.stderr, flush=True)
    try:
        done = subprocess.run(
            sandbox.wrap([build.MANIMGL, str(root / config["scenes_file"]), scene, "-s", "-w", "-l", "--video_dir", str(out)], root),
            cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=SCENE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return report.error(scene, f"the scene did not finish within {SCENE_TIMEOUT} seconds; it may loop forever")
    if done.returncode:
        return report.error(scene, tidy(done.stdout))
    if not result.is_file():
        return report.error(scene, "the scene ran but played no narration; it needs at least one `with self.voiceover(...)` block")
    for issue in json.loads(result.read_text(encoding="utf-8")).get("issues", []):
        report.warn(scene, issue["message"])


def check(root, static_only=False, sync_scenes=False, strict=False):
    report = Report()
    config, blocks, scenes = check_static(root, report, sync_scenes, strict)
    info = {"scenes": scenes or [], "blocks": [{"id": b, "words": v["words"]} for b, v in (blocks or {}).items()]}
    if not report.errors and not static_only:
        if not Path(build.MANIMGL).exists():
            report.error("render", f"no manimgl at {build.MANIMGL}; set up video/.venv (see video/README.md)")
        manifest = narrate(root, report) if not report.errors else None
        if manifest:
            for b in info["blocks"]:
                b["duration"] = round(manifest["blocks"][b["id"]]["duration"], 2)
            info["duration"] = round(sum(b["duration"] for b in info["blocks"]), 1)
            for scene in config["scenes"]:
                try_scene(root, config, scene, report)
    return {"ok": not report.errors, "errors": report.errors, "warnings": report.warnings, **info}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check a video project before building it.")
    ap.add_argument("project", help="project name under video/projects/, or a path to a project folder")
    ap.add_argument("--static", action="store_true", help="only read the files; speak and run nothing")
    ap.add_argument("--sync-scenes", action="store_true", help='set "scenes" in project.json to the scene classes found, in order')
    ap.add_argument("--strict", action="store_true", help="the tighter rules for scenes a model wrote: no sys, pathlib, files or programs")
    args = ap.parse_args(argv)
    root = Path(args.project).expanduser()
    if not (root / "project.json").is_file():
        root = HERE / "projects" / args.project
    if not (root / "project.json").is_file():
        sys.exit(f"error: no project.json in {root}. Projects live in video/projects/<name>/.")
    result = check(root.resolve(), static_only=args.static, sync_scenes=args.sync_scenes, strict=args.strict)
    print(json.dumps(result, indent=1))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
