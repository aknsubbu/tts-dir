"""Run a scene inside the macOS sandbox, so the Python in scenes.py is confined.

A scenes.py is run as written, and the lesson writer's scenes were written by a model
from notes that may have come from anywhere. check.py's import and name rules catch
accidents; this is what holds when code sets out to get around them. Inside the sandbox
a scene has

    no network           it cannot send anything anywhere, or fetch anything
    no writing           except in its own project folder and the temporary folders
    no reading           of the places keys and logins are kept (~/.ssh, keychains, ...)

Everything else manim needs still works: the GPU, fonts, LaTeX, ffmpeg.

`sandbox-exec` ships with macOS. Where it is missing (Linux) scenes run unconfined and
`available()` is False. Set VIDEO_SANDBOX=0 to turn it off for a hand-written project
that really does need the network or another folder.
"""
import os
import tempfile
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


def available():
    return os.environ.get("VIDEO_SANDBOX", "1") != "0" and Path(SANDBOX_EXEC).exists() and PROFILE.is_file()


def wrap(cmd, root):
    """`cmd` to run with writes confined to the project at `root`; unchanged where there is no sandbox."""
    if not available():
        return list(cmd)
    home = Path.home().resolve()
    params = {
        "PROJECT": Path(root).resolve(),
        "TMP": Path(tempfile.gettempdir()).resolve(),
        "HOME": home,
    }
    args = [SANDBOX_EXEC]
    for key, value in params.items():
        args += ["-D", f"{key}={value}"]
    deny = "".join(f'(deny file-read* (subpath "{home / p}"))' for p in PRIVATE)
    return [*args, "-p", PROFILE.read_text(encoding="utf-8") + deny, *cmd]
