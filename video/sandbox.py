"""Run a scene inside the macOS sandbox, so the Python in scenes.py is confined.

A scenes.py is run as written, and the lesson writer's scenes were written by a model
from notes that may have come from anywhere. check.py's import and name rules catch
accidents; this is what holds when code sets out to get around them. Inside the sandbox
a scene has

    no network           it cannot send anything anywhere, or fetch anything
    no writing           except in its project's build/ folder, a temporary folder of its
                         own, and one cache folder kept for scenes
    no reading           of the places keys and logins are kept (~/.ssh, keychains, ...)
    no Apple Events      it cannot ask another app to act for it
    no secrets           it gets a short list of environment variables, not the server's

Everything else manim needs still works: the GPU, fonts, LaTeX, ffmpeg. The caches manim,
matplotlib, fontconfig and TeX would keep in your home folder are pointed at the scene
cache instead, so a scene cannot change files that other programs on this Mac trust (Kokoro's
model files live in ~/.cache, for one).

`sandbox-exec` ships with macOS. Where it is missing (Linux) scenes run unconfined, though
still with the short environment and the limits, and `available()` is False. Set
VIDEO_SANDBOX=0 to turn the sandbox off for a hand-written project that really does need
the network or another folder.
"""
import json
import os
import sys
from pathlib import Path

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
PROFILE = Path(__file__).resolve().parent / "scene.sb"

# Folders under the home directory that hold credentials or private data a scene has no use for.
PRIVATE = (
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    ".config", ".claude", ".claude.json",
    "Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari",
    "Library/Application Support/Google", "Library/Application Support/Firefox",
    "Library/Application Support/com.apple.TCC", "Library/Application Support/Claude",
)

# The environment a scene is given. Anything else the server has (API keys, tokens) stays out.
PASS_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "__CF_USER_TEXT_ENCODING")

CPU_SECONDS = 2 * 60 * 60  # per process; a long 4K scene is well inside this
MAX_FILE_BYTES = 4 * 1024 ** 3  # the largest file a scene may write


def available():
    return os.environ.get("VIDEO_SANDBOX", "1") != "0" and Path(SANDBOX_EXEC).exists() and PROFILE.is_file()


def cache_root():
    """The one cache folder scenes share: manim's disk cache, TeX, matplotlib and fontconfig."""
    override = os.environ.get("VIDEO_SCENE_CACHE")
    if override:
        return Path(override).expanduser().resolve()
    base = Path.home() / ("Library/Caches" if sys.platform == "darwin" else ".cache")
    return (base / "narrated-proofs-scenes").resolve()


def prepare(root, extra_env=None):
    """Everything a scene run needs besides its command: (env, manim arguments, preexec_fn).

    Makes build/tmp and the scene cache, and writes build/manim-config.json, which moves
    manim's LaTeX working folder and disk cache to where a scene may write. The config is
    JSON, which manim reads as YAML.
    """
    root = Path(root).resolve()
    build = root / "build"
    tmp = build / "tmp"
    cache = cache_root()
    for d in (tmp, cache / "manim", cache / "matplotlib", cache / "texmf-var"):
        d.mkdir(parents=True, exist_ok=True)
    config = build / "manim-config.json"
    config.write_text(json.dumps({
        "directories": {
            "cache": str(cache / "manim"),
            "temporary_storage": str(tmp),
            "downloads": str(cache / "downloads"),
            "subdirs": {"latex_cache": str(build / "latex_cache")},  # absolute, so the base folder is ignored
        },
    }, indent=1), encoding="utf-8")
    env = {k: os.environ[k] for k in PASS_ENV if k in os.environ}
    env.update({
        "TMPDIR": str(tmp),
        "XDG_CACHE_HOME": str(cache),  # fontconfig, and anything else that follows XDG
        "MPLCONFIGDIR": str(cache / "matplotlib"),
        "TEXMFVAR": str(cache / "texmf-var"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    env.update(extra_env or {})
    return env, ["--config_file", str(config)], limits


def limits():
    """Run in the child before it starts: CPU time and file size limits, inherited by what it starts."""
    try:
        import resource
    except ImportError:  # not POSIX
        return
    for name, value in (("RLIMIT_CPU", CPU_SECONDS), ("RLIMIT_FSIZE", MAX_FILE_BYTES)):
        kind = getattr(resource, name, None)
        if kind is None:
            continue
        soft, hard = resource.getrlimit(kind)
        cap = value if hard == resource.RLIM_INFINITY else min(value, hard)
        if soft == resource.RLIM_INFINITY or soft > cap:
            resource.setrlimit(kind, (cap, hard))


def wrap(cmd, root):
    """`cmd` to run with writes confined to the project's build/ folder; unchanged where there is no sandbox."""
    if not available():
        return list(cmd)
    home = Path.home().resolve()
    params = {"BUILD": (Path(root) / "build").resolve(), "CACHE": cache_root()}
    args = [SANDBOX_EXEC]
    for key, value in params.items():
        args += ["-D", f"{key}={value}"]
    deny = "".join(f'(deny file-read* (subpath "{home / p}"))' for p in PRIVATE)
    return [*args, "-p", PROFILE.read_text(encoding="utf-8") + deny, *cmd]
