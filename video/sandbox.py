"""Run a scene inside the macOS sandbox, so the Python in scenes.py is confined.

A scenes.py is run as written, and the lesson writer's scenes were written by a model
from notes that may have come from anywhere. check.py's import and name rules catch
accidents; this is what holds when code sets out to get around them. Inside the sandbox
a scene has

    no network           it cannot send anything anywhere, or fetch anything
    no writing           except in its project's build/ folder, a temporary folder of its
                         own, and one cache folder kept for scenes
    reading only         its own project, the scene runtime (runtime/), the Python that runs
                         manim, the system's libraries and fonts, the TeX installation, ffmpeg,
                         and the scene cache; never the places keys and logins are kept
    starting only        that Python, ffmpeg and ffprobe, and the TeX programs
    no other programs    no Apple Events, Launch Services or pasteboard: it cannot ask another
                         app to open a URL or a file for it
    no secrets           it gets a short list of environment variables, not the server's

The places to read and the programs to start are found when the scene runs (the Python's
prefixes and import path, `kpsewhich`, `ffmpeg` on PATH), so another Mac's layout works.
File metadata stays readable everywhere, since paths must resolve: a scene can tell that a
file exists, but not read it or list its folder.

The caches manim, matplotlib, fontconfig and TeX would keep in your home folder are pointed
at the scene cache instead, so a scene cannot change files that other programs on this Mac
trust (Kokoro's model files live in ~/.cache, for one).

VIDEO_SANDBOX=report keeps the network, writing and private-folder rules but only reports
what the reading, starting and asking rules would stop: each such access is allowed and
logged to the macOS log, where `sandbox_probe.py` collects it. VIDEO_SANDBOX=0 turns the
sandbox off, for a hand-written project that really does need the network or another folder.

`sandbox-exec` ships with macOS. Where it is missing (Linux) scenes run unconfined, though
still with the short environment and the limits, and `available()` is False.
"""
import functools
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
HERE = Path(__file__).resolve().parent
PROFILE = HERE / "scene.sb"
RUNTIME = HERE / "runtime"  # what scenes import besides manim: voiceover.py, kit.py, cards.py

# Folders under the home directory that hold credentials or private data a scene has no use for.
# Denied last, so nothing found at run time can open them again.
PRIVATE = (
    ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials",
    ".config", ".claude", ".claude.json",
    "Library/Keychains", "Library/Cookies", "Library/Mail", "Library/Messages", "Library/Safari",
    "Library/Application Support/Google", "Library/Application Support/Firefox",
    "Library/Application Support/com.apple.TCC", "Library/Application Support/Claude",
)

# The environment a scene is given. Anything else the server has (API keys, tokens) stays out.
PASS_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "__CF_USER_TEXT_ENCODING")

# What every scene may read: the system's libraries, frameworks, fonts and settings, and the
# temporary folders it may write to. /System holds the frameworks, the GPU drivers and the
# shared library cache; /private/var/folders the GPU's shader cache.
SYSTEM_READ = (
    "/System", "/usr/lib", "/usr/share", "/Library/Apple", "/Library/Fonts", "/Library/Preferences",
    "/private/etc", "/private/var/db/timezone", "/private/var/db/dyld", "/private/var/folders", "/private/tmp", "/dev",
)
# The links at the top of the disk, so paths through them resolve. Exactly these, not what is under them.
SYSTEM_LINKS = ("/", "/etc", "/tmp", "/var")
# What a Homebrew prefix holds that programs installed with it load: never its var/ (databases) or etc/ (settings).
BREW_READ = ("Cellar", "opt", "lib", "share", "Frameworks", "etc/fonts")
# Folders shared by many programs. No rule covers one whole: a Python whose prefix is /usr must
# not open every program in /usr/bin. What is needed inside them is named one by one.
SHARED = (
    "/", "/usr", "/usr/bin", "/usr/sbin", "/bin", "/sbin", "/usr/local", "/usr/local/bin", "/usr/local/sbin",
    "/opt", "/opt/homebrew", "/opt/homebrew/bin", "/opt/homebrew/sbin",
    "/opt/local", "/opt/local/bin", "/Library", "/Applications", "/private", "/private/var", "/Users",
)
# Every Homebrew program, each in its own folder. Readable whole, since a program's libraries are
# in other programs' folders there (opt/ and lib/ only link into it); never startable whole.
CELLARS = ("/opt/homebrew/Cellar", "/usr/local/Cellar")
# The TeX programs manim starts (latex or xelatex, then dvisvgm), and what they start themselves.
TEX_PROGRAMS = ("latex", "xelatex", "pdftex", "xetex", "dvisvgm", "kpsewhich")

# Services that would let a scene ask another program to act for it: open a URL or a file
# (Launch Services), or read and write the clipboard.
SERVICES = ("com.apple.coreservices.launchservicesd", "com.apple.pasteboard.1")

CPU_SECONDS = 2 * 60 * 60  # per process; a long 4K scene is well inside this
MAX_FILE_BYTES = 4 * 1024 ** 3  # the largest file a scene may write


def mode():
    """"strict" (the default), "report" (VIDEO_SANDBOX=report) or "off" (VIDEO_SANDBOX=0)."""
    value = os.environ.get("VIDEO_SANDBOX", "1").strip().lower()
    if value in ("0", "off", "no", "false"):
        return "off"
    return "report" if value == "report" else "strict"


def available():
    return mode() != "off" and Path(SANDBOX_EXEC).exists() and PROFILE.is_file()


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


# ---------- what this Mac's rendering reads and starts ----------

def _output(cmd, timeout=30):
    """A trusted helper's answer, or None. Run outside the sandbox, before the scene."""
    try:
        done = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout.strip() if done.returncode == 0 else None


def interpreter(executable):
    """The program that really runs `executable`: itself, or the one its #! line names."""
    path = Path(executable)
    try:
        with open(path, "rb") as f:
            first = f.readline(512)
    except OSError:
        return path
    if not first.startswith(b"#!"):
        return path
    words = first[2:].decode("utf-8", "replace").split()
    if not words:
        return path
    if Path(words[0]).name == "env":
        name = next((w for w in words[1:] if not w.startswith("-")), None)
        found = name and shutil.which(name)
        return Path(found) if found else path
    return Path(words[0])


PYTHON_INFO = "import json, sys; print(json.dumps([sys.prefix, sys.base_prefix, sys.executable, [p for p in sys.path if p]]))"


@functools.lru_cache(maxsize=None)
def python_paths(executable):
    """(read, start) for the Python that runs `executable`: its prefix, the Python it was made
    from, and its import path (which also finds packages installed from a source folder)."""
    program = interpreter(executable)
    read, start = [executable, program], [executable, program]
    found = _output([program, "-E", "-c", PYTHON_INFO])
    if found:
        try:
            prefix, base, exe, path = json.loads(found.splitlines()[-1])
        except (ValueError, IndexError):
            return tuple(read), tuple(start)
        read += [prefix, base, exe, *path]
        start += [Path(prefix) / "bin", base, exe]
    return tuple(read), tuple(start)


@functools.lru_cache(maxsize=None)
def tex_paths(search):
    """(read, start) for the TeX installation on `search` (a PATH): its TeX Live folder (every
    year's tree and texmf-local, for MacTeX and Homebrew alike), the trees kpsewhich names,
    the TeX programs manim starts, and the TeX folder in your home if there is one. A folder
    of links that other programs share (/opt/homebrew/bin) is never opened whole."""
    kpsewhich = shutil.which("kpsewhich", path=search)
    if not kpsewhich:
        return (), ()

    def var(name):
        return _output([kpsewhich, f"-var-value={name}"])

    programs = [p for p in (shutil.which(name, path=search) for name in TEX_PROGRAMS) if p]
    read, start = [*programs], [*programs]
    tree = next((t for t in (var("SELFAUTOGRANDPARENT"), var("SELFAUTOPARENT")) if t and "texlive" in Path(t).name.lower()), None)
    if tree:
        read.append(tree)
        start.append(tree)
    trees = (var(v) for v in ("TEXMFDIST", "TEXMFMAIN", "TEXMFLOCAL", "TEXMFSYSVAR", "TEXMFSYSCONFIG"))
    read += [Path(t.lstrip("!")) for t in trees if t and Path(t.lstrip("!")).is_dir()]
    links = Path(kpsewhich).parent
    if str(links).startswith("/Library/TeX/"):  # MacTeX's links
        read.append("/Library/TeX")
        start.append(links)
    home = var("TEXMFHOME")
    if home and Path(home).expanduser().is_dir():
        read.append(Path(home).expanduser())
    return tuple(read), tuple(start)


@functools.lru_cache(maxsize=None)
def ffmpeg_paths(search):
    """(read, start) for ffmpeg and ffprobe on `search`: manim writes its video through ffmpeg,
    and reads sounds with ffprobe. Their libraries come with them (see BREW_READ)."""
    found = [p for p in (shutil.which(name, path=search) for name in ("ffmpeg", "ffprobe")) if p]
    return tuple(found), tuple(found)


def _brew_prefix(real):
    """The Homebrew prefix a real path is in (/opt/homebrew, /usr/local), or None."""
    text = str(real)
    return Path(text.split("/Cellar/")[0]) if "/Cellar/" in text else None


def _too_wide(real, start=False):
    """Paths no rule may cover: the home folder and the folders above it, and the folders many
    programs share; for starting programs, Homebrew's Cellar too."""
    home = Path.home().resolve()
    wide = SHARED + (CELLARS if start else ())
    return real == home or real in home.parents or str(real) in wide or any(str(real) == os.path.realpath(s) for s in wide)


def _paths(items, brew=False, start=False):
    """Each path as given and as it really is (the sandbox sees real paths), with what its
    Homebrew prefix provides when `brew`, without duplicates or anything too wide for reading
    (or, with `start`, for starting programs)."""
    out = []
    for item in items:
        if not item:
            continue
        given = Path(item).expanduser()
        real = Path(os.path.realpath(given))
        found = [given, real]
        prefix = _brew_prefix(real) if brew else None
        if prefix:
            found += [prefix / sub for sub in BREW_READ]
        for p in found:
            if p.is_absolute() and not _too_wide(Path(os.path.realpath(p)), start) and p not in out:
                out.append(p)
    return out


def allowed(cmd, root, search=None):
    """(read, start): every path a run of `cmd` for the project at `root` may read, and every
    program it may start, as paths whose whole folder (or the file itself) is allowed."""
    search = search if search is not None else os.environ.get("PATH", os.defpath)
    py_read, py_start = python_paths(str(cmd[0]))
    tex_read, tex_start = tex_paths(search)
    av_read, av_start = ffmpeg_paths(search)
    start = [*py_start, *tex_start, *av_start]
    read = [
        Path(root).resolve(), RUNTIME, cache_root(), Path.home() / "Library" / "Fonts", *SYSTEM_READ,
        *py_read, *tex_read, *av_read, *start,
    ]
    return _paths(read, brew=True), _paths(start, start=True)


def private_folders():
    """The folders keys and logins are kept in, each as named and, when it is a link, as it really is."""
    home = Path.home().resolve()
    out = []
    for name in PRIVATE:
        named, real = home / name, Path(os.path.realpath(home / name))
        for p in (named, real):
            if p not in out and (p == named or not _too_wide(p)):  # a link to the home folder itself would deny everything
                out.append(p)
    return out


# ---------- the profile ----------

def _quote(path):
    return '"' + str(path).replace("\\", "\\\\").replace('"', '\\"') + '"'


def profile(cmd, root, how=None, search=None):
    """The sandbox profile for running `cmd` on the project at `root`: scene.sb, then the rules
    for reading, starting programs and asking services, then the private folders."""
    how = how or mode()
    read, start = allowed(cmd, root, search)

    def stop(op, *filters):
        # Strict: denied. Report: allowed, and written to the macOS log for sandbox_probe.py.
        body = " ".join(filters)
        return f"(allow {op} (with report){' ' + body if body else ''})" if how == "report" else f"(deny {op}{' ' + body if body else ''})"

    rules = [
        PROFILE.read_text(encoding="utf-8").rstrip(),
        "",
        "; Reading: only what rendering needs, found on this Mac (sandbox.py). Metadata everywhere,",
        "; so paths resolve.",
        stop("file-read*"),
        "(allow file-read-metadata)",
        "(allow file-read*",
        *(f"  (literal {_quote(p)})" for p in SYSTEM_LINKS),
        *(f"  (subpath {_quote(p)})" for p in read),
        ")",
        "",
        "; Starting programs: the Python that runs manim, ffmpeg and ffprobe, and TeX.",
        stop("process-exec*"),
        "(allow process-exec*",
        *(f"  (subpath {_quote(p)})" for p in start),
        ")",
        "",
        "; No asking Launch Services to open something, and no clipboard.",
        stop("mach-lookup", *(f"(global-name {_quote(s)})" for s in SERVICES)),
        "",
        "; Never where keys and logins are kept, whatever was allowed above: as named, and where",
        "; they really are when they link elsewhere (a dotfiles folder, say).",
        *(f"(deny file-read* (subpath {_quote(p)}))" for p in private_folders()),
    ]
    return "\n".join(rules) + "\n"


def wrap(cmd, root):
    """`cmd` to run inside the sandbox for the project at `root`; unchanged where there is no sandbox."""
    if not available():
        return list(cmd)
    params = {"BUILD": (Path(root) / "build").resolve(), "CACHE": cache_root()}
    args = [SANDBOX_EXEC]
    for key, value in params.items():
        args += ["-D", f"{key}={value}"]
    return [*args, "-p", profile(cmd, root), *cmd]


DENIED = re.compile(r"Operation not permitted|PermissionError|\[Errno 1\]|Permission denied", re.I)


def hint(output=None):
    """What to add to a scene's failure when the sandbox may be what stopped it: always when
    the output is not known, else only when it shows something was refused."""
    if not available() or mode() != "strict" or (output is not None and not DENIED.search(output)):
        return ""
    return ("The sandbox may have stopped it: scenes may read only what rendering needs and start only Python, ffmpeg and TeX. "
            "If it works with VIDEO_SANDBOX=0, run it with VIDEO_SANDBOX=report, then `python3 sandbox_probe.py` "
            "lists what it needed (see video/README.md).")
