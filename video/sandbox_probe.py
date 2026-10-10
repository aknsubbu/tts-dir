"""Find what rendering on this Mac needs that the scene sandbox does not allow.

    python3 sandbox_probe.py                  the smoke scenes and the example lesson
    python3 sandbox_probe.py --project demo   and a project of yours, under projects/
    python3 sandbox_probe.py --json           the findings as JSON

Each one is rendered twice, from a copy, at low quality. First with VIDEO_SANDBOX=report,
which allows what the strict rules would stop and writes each such read, start or lookup
to the macOS log; then under the strict rules, to see whether it renders. The probe then
reads the log and prints what was reported, as rules that would allow it. Nothing it renders
is kept, and your projects are not touched.

Run it once after setting up video/ (see README.md), and when a project renders with
VIDEO_SANDBOX=0 but not without it. It needs macOS: the sandbox and the log are macOS's.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import build
import sandbox

HERE = Path(__file__).resolve().parent
EXAMPLE = HERE.parent / "tts-studio" / "author" / "prompts" / "example"
# A sandbox report in the log: "Sandbox: python3.12(4242) allow(1) file-read-data /opt/homebrew/etc/fonts/fonts.conf"
LINE = re.compile(r"Sandbox: (?P<proc>.+?)\((?P<pid>\d+)\) (?P<verdict>allow|deny)(?:\(\d+\))? (?P<op>[\w*-]+)(?: (?P<target>.*))?$")
# What the probe's renders start; anything else in the log is another program's.
OURS = re.compile(r"^(python|Python|manimgl|latex|pdftex|xelatex|xetex|dvisvgm|kpsewhich|mktex|ffmpeg|ffprobe|sh|bash|perl|env)", re.I)


def renders(work, extra_projects):
    """[(name, root, command)]: copies of what to render, each with the command that renders it."""
    out = []
    smoke = work / "smoke"
    (smoke / "build").mkdir(parents=True)
    shutil.copy(HERE / "smoke" / "smoke_scene.py", smoke / "smoke_scene.py")
    for scene in ("SmokeText", "SmokeTex"):
        if scene == "SmokeTex" and not shutil.which("latex"):
            print("(skipping SmokeTex: no latex on PATH)", file=sys.stderr)
            continue
        cmd = [build.MANIMGL, smoke / "smoke_scene.py", scene, "-w", *build.QUALITY["low"], "--video_dir", smoke / "build" / "out"]
        out.append((f"smoke {scene}", smoke, cmd))
    lessons = []
    if (EXAMPLE / "scenes.py").is_file():
        example = work / "example"
        shutil.copytree(EXAMPLE, example)
        scenes = re.findall(r"^class (\w+)\(VoiceoverScene", (example / "scenes.py").read_text(encoding="utf-8"), re.M)
        (example / "project.json").write_text(json.dumps({"voice": "af_heart", "speed": 1.0, "script": "script.txt", "scenes_file": "scenes.py", "scenes": scenes}))
        lessons.append(("the example lesson", example))
    for name in extra_projects:
        source = Path(name).expanduser()
        source = source if (source / "project.json").is_file() else HERE / "projects" / name
        if not (source / "project.json").is_file():
            sys.exit(f"error: no project.json in {source}")
        copy = work / f"project-{source.name}"
        shutil.copytree(source, copy, ignore=shutil.ignore_patterns("build", "versions"))
        lessons.append((f"project {source.name}", copy))
    for label, root in lessons:
        if not Path(build.KOKORO_PYTHON).exists():
            print(f"(skipping {label}: it needs the narration, and there is no Kokoro Python at {build.KOKORO_PYTHON})", file=sys.stderr)
            continue
        out.append((label, root, [sys.executable, HERE / "build.py", root, "--quality", "low", "--no-cache"]))
    return out


def run(label, root, cmd, how):
    """Render once with VIDEO_SANDBOX=`how`. Returns (ok, seconds, the end of its output)."""
    env = {**os.environ, "VIDEO_SANDBOX": how}
    started = time.time()
    if Path(str(cmd[1])).name == "build.py":
        # build.py sandboxes its own scenes; narration and joining run outside, as always.
        args, kw = [str(c) for c in cmd], {"env": env}
    else:
        os.environ["VIDEO_SANDBOX"] = how
        try:
            scene_env, manim_args, limits = sandbox.prepare(root, {"PYTHONPATH": str(sandbox.RUNTIME)})
            args = [str(c) for c in sandbox.wrap([*cmd, *manim_args], root)]
        finally:
            os.environ.pop("VIDEO_SANDBOX", None)
        kw = {"env": scene_env, "preexec_fn": limits}
    print(f"  {how:<7} {label} …", file=sys.stderr, flush=True)
    done = subprocess.run(args, cwd=root, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3600, **kw)
    tail = "\n".join((done.stdout + done.stderr).strip().splitlines()[-12:])
    return done.returncode == 0, time.time() - started, tail


def from_log(since):
    """Every sandbox report since `since` (a datetime), from the macOS log."""
    cmd = ["/usr/bin/log", "show", "--style", "ndjson", "--start", since.strftime("%Y-%m-%d %H:%M:%S"),
           "--predicate", 'sender == "Sandbox" OR eventMessage CONTAINS "Sandbox: "']
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode:
        sys.exit(f"error: could not read the log: {done.stderr.strip()}")
    found = []
    for line in done.stdout.splitlines():
        try:
            message = json.loads(line).get("eventMessage", "")
        except ValueError:
            continue
        m = LINE.search(message)
        if m:
            found.append(m.groupdict())
    return found


def rule_for(op, target):
    """A rule that would allow one report, kept as narrow as is useful."""
    if op.startswith("mach-lookup"):
        return f'(allow mach-lookup (global-name "{target}"))'
    if op.startswith("process-exec"):
        return f'(allow process-exec* (literal "{target}"))'
    path = Path(target)
    if path == Path.home() or Path.home() in path.parents:
        return f'(allow file-read* (literal "{path}"))'  # in your home folder, only the file itself
    parts = path.parts
    # Elsewhere, the tree the file belongs to, four levels down at most.
    folder = Path(*parts[:min(len(parts) - 1, 5)]) if len(parts) > 2 else path
    return f'(allow file-read* (subpath "{folder}"))'


def main(argv=None):
    ap = argparse.ArgumentParser(description="Find what rendering needs that the scene sandbox does not allow.")
    ap.add_argument("--project", action="append", default=[], help="also render this project (a name under projects/, or a path)")
    ap.add_argument("--json", action="store_true", help="print the findings as JSON")
    args = ap.parse_args(argv)
    if sys.platform != "darwin" or not Path(sandbox.SANDBOX_EXEC).exists():
        sys.exit("error: the probe needs macOS, where scenes run inside sandbox-exec.")
    if not Path(build.MANIMGL).exists():
        sys.exit(f"error: no manimgl at {build.MANIMGL}. Run ../install.sh first.")

    with tempfile.TemporaryDirectory(prefix="sandbox-probe-") as tmp:
        work = Path(tmp).resolve()
        todo = renders(work, args.project)
        since = datetime.datetime.now() - datetime.timedelta(seconds=2)
        print("Rendering with VIDEO_SANDBOX=report, which allows and logs what the strict rules would stop:", file=sys.stderr)
        reported = {label: run(label, root, cmd, "report") for label, root, cmd in todo}
        time.sleep(2)  # the log takes a moment to catch up
        reports = from_log(since)
        print("Rendering under the strict rules:", file=sys.stderr)
        strict = {}
        for label, root, cmd in todo:
            shutil.rmtree(root / "build", ignore_errors=True)
            (root / "build").mkdir()
            strict[label] = run(label, root, cmd, "strict")

    ours = [r for r in reports if OURS.match(r["proc"])]
    others = sorted({r["proc"] for r in reports if not OURS.match(r["proc"])})
    needed = {}
    for r in ours:
        target = (r.get("target") or "").strip()
        if r["op"] == "file-read-metadata" or not target:
            continue
        needed.setdefault(rule_for(r["op"], target), set()).add(f"{r['proc']} {r['op']} {target}")

    if args.json:
        print(json.dumps({
            "renders": {label: {"report": reported[label][0], "strict": strict[label][0]} for label in reported},
            "rules": {rule: sorted(seen) for rule, seen in sorted(needed.items())},
            "other_processes": others,
        }, indent=1))
        return 0 if all(ok for ok, _, _ in strict.values()) else 1

    print("\nRenders:")
    for label in reported:
        r_ok, r_s, r_tail = reported[label]
        s_ok, s_s, s_tail = strict[label]
        print(f"  {label:<28} report {'ok' if r_ok else 'FAILED':<7} strict {'ok' if s_ok else 'FAILED':<7} ({s_s:.0f}s)")
        if not r_ok:
            print("    It fails even with the sandbox only reporting, so the cause is not the sandbox:\n    " + r_tail.replace("\n", "\n    "))
        elif not s_ok:
            print("    The end of its output under the strict rules:\n    " + s_tail.replace("\n", "\n    "))
    if needed:
        print("\nWhat the strict rules stopped, as rules for scene.sb (each with what asked for it):")
        for rule, seen in sorted(needed.items()):
            print(f"  {rule}")
            for s in sorted(seen)[:3]:
                print(f"      {s}")
            if len(seen) > 3:
                print(f"      and {len(seen) - 3} more")
    else:
        print("\nThe strict rules stopped nothing these renders needed.")
    if others:
        print(f"\nThe log also had sandbox reports from other programs, left out: {', '.join(others)}.")
    print("\nAdd the rules you trust to scene.sb, or send this output to whoever looks after the sandbox rules.")
    return 0 if all(ok for ok, _, _ in strict.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
