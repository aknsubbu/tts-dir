#!/usr/bin/env python3
"""Build a narrated video: narrate, render every scene, join them, write captions.

    python3 build.py demo                 # video/projects/demo -> projects/demo/build/demo.mp4
    python3 build.py demo --quality low   # quicker 480p check
    python3 build.py demo --no-narrate    # reuse build/manifest.json as it is
    python3 build.py demo --no-cache      # render every scene, even unchanged ones

A scene is rendered again only when something that decides its picture or sound has
changed (see scene_keys); otherwise its video from an earlier build is reused from
build/cache/. Narration is cached the same way, per block, by narrate.py.

Needs ffmpeg and ffprobe on PATH, tts-studio/.venv (npm run setup in tts-studio)
and video/.venv (see README). Any Python 3.10+ can run this file; it only starts
the other two. Override their locations with $KOKORO_PYTHON and $MANIMGL.
"""
import argparse
import ast
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import project_ast
import sandbox
from captions import block_cues, group_cues, to_srt, to_vtt

HERE = Path(__file__).resolve().parent
KOKORO_PYTHON = os.environ.get("KOKORO_PYTHON") or str(HERE.parent / "tts-studio" / ".venv" / "bin" / "python")
MANIMGL = os.environ.get("MANIMGL") or str(HERE / ".venv" / "bin" / "manimgl")
QUALITY = {"low": ["-l"], "medium": ["-m"], "hd": ["--hd"], "4k": ["--uhd"], "default": []}
SCENE_TIMEOUT = float(os.environ.get("VIDEO_SCENE_TIMEOUT") or 45 * 60)  # seconds for one scene's full render
CACHE_VERSION = 1  # bump when a change here alters what a cached render would contain
KEEP_BUILDS = 3  # the scene cache keeps what the last few builds used

# A server started from a login item or an old shell may not have Homebrew or TeX on its
# PATH, and manim needs ffmpeg, latex and dvisvgm. Add the usual places when they exist.
for _dir in ("/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin"):
    if Path(_dir).is_dir() and _dir not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = os.pathsep.join(filter(None, [os.environ.get("PATH"), _dir]))


class BuildError(Exception):
    pass


# ---------- steps ----------

def run(cmd, failed=None, timeout=None, **kw):
    print("$ " + " ".join(str(c) for c in cmd), file=sys.stderr, flush=True)
    # No stdin: given a scene name it does not know, manimgl would otherwise wait for one to be typed.
    # Their output goes to stderr, so stdout carries only the paths this command prints at the end.
    try:
        code = subprocess.call([str(c) for c in cmd], stdin=subprocess.DEVNULL, stdout=sys.stderr, timeout=timeout, **kw)
    except subprocess.TimeoutExpired:
        raise BuildError(f"{failed or Path(str(cmd[0])).name}: it did not finish within {timeout / 60:.0f} minutes") from None
    if code:
        raise BuildError(failed or f"{Path(str(cmd[0])).name} failed (exit {code})")


def narrate(root):
    if not Path(KOKORO_PYTHON).exists():
        raise BuildError(f"No Kokoro Python at {KOKORO_PYTHON}. Run `npm run setup` in tts-studio, or set KOKORO_PYTHON.")
    run([KOKORO_PYTHON, HERE / "narrate.py", root])


def render(root, config, scene, quality):
    """Render one scene in full with manimgl -w. Returns (mp4, timeline json)."""
    if not Path(MANIMGL).exists():
        raise BuildError(f"No manimgl at {MANIMGL}. Set up video/.venv (see video/README.md), or set MANIMGL.")
    build = root / "build"
    timeline = build / "timeline" / f"{scene}.json"
    timeline.unlink(missing_ok=True)  # a stale one would put last build's timings in the captions
    env, manim_args, limits = sandbox.prepare(root, {
        "VOICEOVER_MANIFEST": str(build / "manifest.json"),
        "VOICEOVER_TIMELINE": str(timeline),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH")])),
    })
    started = time.time()
    # Never -n or -s: manim drops add_sound() while skipping, so a partial render loses audio.
    # The scene's own Python runs here, so this is the step that is sandboxed (see sandbox.py).
    cmd = [MANIMGL, root / config["scenes_file"], scene, "-w", *QUALITY[quality], "--video_dir", build / "scenes", *manim_args]
    run(
        sandbox.wrap(cmd, root),
        failed=f"rendering {scene} failed; see the manimgl output above",
        timeout=SCENE_TIMEOUT,
        cwd=root,
        env=env,
        preexec_fn=limits,
    )
    found = [p for p in (build / "scenes").rglob(f"{scene}.mp4") if p.stat().st_mtime >= started - 1]
    if not found:
        raise BuildError(f"manimgl finished but wrote no {scene}.mp4 under {build / 'scenes'}")
    return max(found, key=lambda p: p.stat().st_mtime), timeline


# ---------- scene cache ----------

def manim_fingerprint():
    """Which manimgl is installed: the commit or version its package records, else where it is."""
    venv = Path(MANIMGL).resolve().parent.parent
    for info in sorted(venv.glob("lib/python*/site-packages/manimgl-*.dist-info")):
        direct = info / "direct_url.json"
        return info.name + (direct.read_text(encoding="utf-8") if direct.is_file() else "")
    return str(Path(MANIMGL).resolve())


def scene_keys(root, config, manifest, quality):
    """{scene: cache key}. A key changes when anything that decides that scene's video changes:
    the shared code in scenes.py and the scene's own class, the narration it plays (audio, length,
    marks), the quality, the voiceover runtime, manim's own config in the project, or manim itself."""
    source = (root / config["scenes_file"]).read_text(encoding="utf-8")
    tree = ast.parse(source)
    classes = project_ast.scene_classes(tree)
    custom = root / "custom_config.yml"
    shared = {
        "v": CACHE_VERSION,
        "quality": quality,
        "runtime": hashlib.sha256((HERE / "voiceover.py").read_bytes()).hexdigest(),
        "manim": manim_fingerprint(),
        "custom_config": custom.read_text(encoding="utf-8") if custom.is_file() else None,
    }
    keys = {}
    for scene in config["scenes"]:
        blocks = project_ast.blocks_played(classes[scene]) if scene in classes else []
        narration = [
            {k: manifest["blocks"][b].get(k) for k in ("wav", "duration", "marks")} if b in manifest["blocks"] else b
            for b in blocks
        ]
        payload = {**shared, "scene": scene, "code": project_ast.scene_fingerprint(source, tree, scene), "narration": narration}
        keys[scene] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:20]
    return keys


def cached_render(root, config, scene, quality, key, use_cache=True):
    """render(), unless build/cache already holds this scene's video for `key`. Returns (mp4, timeline)."""
    cache = root / "build" / "cache"
    mp4, saved = cache / f"{scene}-{key}.mp4", cache / f"{scene}-{key}.timeline.json"
    timeline = root / "build" / "timeline" / f"{scene}.json"
    if use_cache and mp4.is_file() and saved.is_file():
        print(f"$ cached {scene} (unchanged since an earlier build)", file=sys.stderr, flush=True)
        timeline.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(saved, timeline)
        return mp4, timeline
    rendered, timeline = render(root, config, scene, quality)
    cache.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(rendered, mp4)
    if timeline.is_file():
        shutil.copyfile(timeline, saved)
    else:
        saved.write_text("null", encoding="utf-8")  # a scene that plays no narration has no timeline
    return mp4, timeline


def prune_cache(root, used):
    """Keep the cached scenes the last KEEP_BUILDS builds used; delete the rest."""
    cache = root / "build" / "cache"
    index = cache / "index.json"
    try:
        builds = json.loads(index.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        builds = []
    builds = (builds + [sorted(used)])[-KEEP_BUILDS:]
    keep = {name for b in builds for name in b}
    for f in cache.glob("*"):
        stem = f.name.split(".")[0]
        if f.name != "index.json" and stem not in keep:
            f.unlink()
    index.write_text(json.dumps(builds), encoding="utf-8")


def probe(path):
    """Duration of the video stream (the picture is what the audio must fit) and whether there is audio."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration,nb_frames,r_frame_rate",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    info = json.loads(out)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise BuildError(f"{path} has no video stream")
    duration = video.get("duration")
    if duration in (None, "N/A") and video.get("nb_frames"):
        num, den = map(float, video["r_frame_rate"].split("/"))
        duration = int(video["nb_frames"]) * den / num
    if duration in (None, "N/A"):
        duration = info["format"]["duration"]
    return {"duration": float(duration), "audio": any(s.get("codec_type") == "audio" for s in streams)}


def concat_args(clips, out):
    """ffmpeg arguments joining [(mp4, duration, has_audio)] in order.

    Each clip's audio is padded or cut to its picture's length, and a clip with no
    audio gets silence, so the narration can never drift against the video.
    """
    args, links, graph = ["ffmpeg", "-y", "-v", "error"], [], []
    for i, (path, duration, has_audio) in enumerate(clips):
        args += ["-i", str(path)]
        d = f"{duration:.6f}"
        graph.append(f"[{i}:v:0]setpts=PTS-STARTPTS[v{i}]")
        source = f"[{i}:a:0]aresample=48000," if has_audio else "anullsrc=r=48000:cl=stereo,"
        graph.append(f"{source}aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end={d},asetpts=PTS-STARTPTS[a{i}]")
        links.append(f"[v{i}][a{i}]")
    graph.append(f"{''.join(links)}concat=n={len(clips)}:v=1:a=1[v][a]")
    return args + [
        "-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    ]


def poster(video, duration, out):
    """A still for the library card, from late enough that the screen has something on it. Returns its name, or None."""
    code = subprocess.call(
        ["ffmpeg", "-y", "-v", "error", "-ss", f"{duration * 0.62:.2f}", "-i", str(video), "-frames:v", "1",
         "-vf", "scale=960:-2", "-q:v", "3", str(out)],
        stdin=subprocess.DEVNULL, stdout=sys.stderr,
    )
    return out.name if code == 0 and out.is_file() else None  # a video without a poster is still a video


def caption_cues(manifest, scenes):
    """Captions for the joined video. `scenes` is [(offset_seconds, timeline or None)] in order."""
    cues, used = [], set()
    for offset, timeline in scenes:
        for entry in (timeline or {}).get("blocks", []):
            block = manifest["blocks"][entry["id"]]
            used.add(entry["id"])
            start = offset + entry["start"]
            if block["words"]:
                cues += group_cues(block["words"], start)
            else:
                cues += block_cues(block["text"], start, block["duration"])
    unused = [b for b in manifest["order"] if b not in used]
    return cues, unused


# ---------- command ----------

def build(root, quality="default", narrate_first=True, use_cache=True):
    config = json.loads((root / "project.json").read_text(encoding="utf-8"))
    config.setdefault("scenes_file", "scenes.py")
    if not config.get("scenes"):
        raise BuildError('project.json needs "scenes": the scene classes to render, in order')
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise BuildError(f"{tool} is not on PATH (brew install ffmpeg)")
    build_dir = root / "build"
    if narrate_first:
        narrate(root)
    manifest_path = build_dir / "manifest.json"
    if not manifest_path.is_file():
        raise BuildError(f"No {manifest_path}. Run without --no-narrate.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    try:
        keys = scene_keys(root, config, manifest, quality)
    except (OSError, SyntaxError, KeyError):
        keys = {}  # an unreadable scenes.py fails in render() with manim's own message
    clips, timed, offset, summary = [], [], 0.0, []
    for scene in config["scenes"]:
        if scene in keys:
            mp4, timeline_path = cached_render(root, config, scene, quality, keys[scene], use_cache)
        else:
            mp4, timeline_path = render(root, config, scene, quality)
        info = probe(mp4)
        timeline = json.loads(timeline_path.read_text(encoding="utf-8")) if timeline_path.is_file() else None
        clips.append((mp4, info["duration"], info["audio"]))
        timed.append((offset, timeline))
        summary.append({"scene": scene, "file": mp4.relative_to(build_dir).as_posix(), "offset": offset, "duration": info["duration"], "key": keys.get(scene)})
        offset += info["duration"]

    name = root.name
    video = build_dir / f"{name}.mp4"
    tmp = build_dir / f".{name}.part.mp4"
    run(concat_args(clips, tmp))
    tmp.replace(video)

    if keys:
        prune_cache(root, [f"{scene}-{key}" for scene, key in keys.items()])
    cues, unused = caption_cues(manifest, timed)
    for bid in unused:
        print(f"warning: narration block [{bid}] is not used by any scene", file=sys.stderr)
    (build_dir / f"{name}.srt").write_text(to_srt(cues), encoding="utf-8")
    (build_dir / f"{name}.vtt").write_text(to_vtt(cues), encoding="utf-8")
    result = {"video": video.name, "duration": probe(video)["duration"], "scenes": summary}
    result["poster"] = poster(video, result["duration"], build_dir / f"{name}.jpg")
    (build_dir / "build.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description="Narrate, render and join a video project.")
    ap.add_argument("project", help="project name under video/projects/, or a path to a project folder")
    ap.add_argument("--quality", choices=list(QUALITY), default="default", help="manim resolution (default: manim's config)")
    ap.add_argument("--no-narrate", action="store_true", help="skip the narrate pass and use build/manifest.json as it is")
    ap.add_argument("--no-cache", action="store_true", help="render every scene again, even ones unchanged since an earlier build")
    args = ap.parse_args(argv)

    root = Path(args.project).expanduser()
    if not (root / "project.json").is_file():
        root = HERE / "projects" / args.project
    if not (root / "project.json").is_file():
        sys.exit(f"error: no project.json in {root}. Projects live in video/projects/<name>/.")
    t0 = time.time()
    try:
        result = build(root.resolve(), args.quality, narrate_first=not args.no_narrate, use_cache=not args.no_cache)
    except BuildError as e:
        sys.exit(f"error: {e}")
    out = root.resolve() / "build"
    print(f"\n{result['video']}: {result['duration']:.2f}s, {len(result['scenes'])} scenes, built in {time.time() - t0:.0f}s", file=sys.stderr)
    for f in (result["video"], f"{root.name}.srt", f"{root.name}.vtt", result.get("poster")):
        if f:
            print(out / f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
