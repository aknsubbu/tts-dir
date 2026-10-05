#!/usr/bin/env python3
"""Build a narrated video: narrate, render every scene, join them, write captions.

    python3 build.py demo                 # video/projects/demo -> projects/demo/build/demo.mp4
    python3 build.py demo --quality low   # quicker 480p check
    python3 build.py demo --no-narrate    # reuse build/manifest.json as it is

Needs ffmpeg and ffprobe on PATH, tts-studio/.venv (npm run setup in tts-studio)
and video/.venv (see README). Any Python 3.10+ can run this file; it only starts
the other two. Override their locations with $KOKORO_PYTHON and $MANIMGL.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from captions import block_cues, group_cues, to_srt, to_vtt

HERE = Path(__file__).resolve().parent
KOKORO_PYTHON = os.environ.get("KOKORO_PYTHON") or str(HERE.parent / "tts-studio" / ".venv" / "bin" / "python")
MANIMGL = os.environ.get("MANIMGL") or str(HERE / ".venv" / "bin" / "manimgl")
QUALITY = {"low": ["-l"], "medium": ["-m"], "hd": ["--hd"], "4k": ["--uhd"], "default": []}


class BuildError(Exception):
    pass


# ---------- steps ----------

def run(cmd, failed=None, **kw):
    print("$ " + " ".join(str(c) for c in cmd), file=sys.stderr, flush=True)
    # No stdin: given a scene name it does not know, manimgl would otherwise wait for one to be typed.
    code = subprocess.call([str(c) for c in cmd], stdin=subprocess.DEVNULL, **kw)
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
    env = {
        **os.environ,
        "VOICEOVER_MANIFEST": str(build / "manifest.json"),
        "VOICEOVER_TIMELINE": str(timeline),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH")])),
    }
    started = time.time()
    # Never -n or -s: manim drops add_sound() while skipping, so a partial render loses audio.
    run(
        [MANIMGL, root / config["scenes_file"], scene, "-w", *QUALITY[quality], "--video_dir", build / "scenes"],
        failed=f"rendering {scene} failed; see the manimgl output above",
        cwd=root,
        env=env,
    )
    found = [p for p in (build / "scenes").rglob(f"{scene}.mp4") if p.stat().st_mtime >= started - 1]
    if not found:
        raise BuildError(f"manimgl finished but wrote no {scene}.mp4 under {build / 'scenes'}")
    return max(found, key=lambda p: p.stat().st_mtime), timeline


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

def build(root, quality="default", narrate_first=True):
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

    clips, timed, offset, summary = [], [], 0.0, []
    for scene in config["scenes"]:
        mp4, timeline_path = render(root, config, scene, quality)
        info = probe(mp4)
        timeline = json.loads(timeline_path.read_text(encoding="utf-8")) if timeline_path.is_file() else None
        clips.append((mp4, info["duration"], info["audio"]))
        timed.append((offset, timeline))
        summary.append({"scene": scene, "file": mp4.relative_to(build_dir).as_posix(), "offset": offset, "duration": info["duration"]})
        offset += info["duration"]

    name = root.name
    video = build_dir / f"{name}.mp4"
    tmp = build_dir / f".{name}.part.mp4"
    run(concat_args(clips, tmp))
    tmp.replace(video)

    cues, unused = caption_cues(manifest, timed)
    for bid in unused:
        print(f"warning: narration block [{bid}] is not used by any scene", file=sys.stderr)
    (build_dir / f"{name}.srt").write_text(to_srt(cues), encoding="utf-8")
    (build_dir / f"{name}.vtt").write_text(to_vtt(cues), encoding="utf-8")
    result = {"video": video.name, "duration": probe(video)["duration"], "scenes": summary}
    (build_dir / "build.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description="Narrate, render and join a video project.")
    ap.add_argument("project", help="project name under video/projects/, or a path to a project folder")
    ap.add_argument("--quality", choices=list(QUALITY), default="default", help="manim resolution (default: manim's config)")
    ap.add_argument("--no-narrate", action="store_true", help="skip the narrate pass and use build/manifest.json as it is")
    args = ap.parse_args(argv)

    root = Path(args.project).expanduser()
    if not (root / "project.json").is_file():
        root = HERE / "projects" / args.project
    if not (root / "project.json").is_file():
        sys.exit(f"error: no project.json in {root}. Projects live in video/projects/<name>/.")
    t0 = time.time()
    try:
        result = build(root.resolve(), args.quality, narrate_first=not args.no_narrate)
    except BuildError as e:
        sys.exit(f"error: {e}")
    out = root.resolve() / "build"
    print(f"\n{result['video']}: {result['duration']:.2f}s, {len(result['scenes'])} scenes, built in {time.time() - t0:.0f}s", file=sys.stderr)
    for f in (result["video"], f"{root.name}.srt", f"{root.name}.vtt"):
        print(out / f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
