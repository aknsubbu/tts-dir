# video

Narrated manim videos, with audio from the Kokoro engine in `../tts-studio`.

`../install.sh` sets up ffmpeg, LaTeX and one Python environment, `../.venv`, with ManimGL (renders the scenes) and Kokoro (speaks the narration). Rendering never imports torch, so sharing the environment costs nothing. `build.py` uses only the standard library, so plain `python3` (3.9 or newer) runs it.

ManimGL is pinned to the GitHub commit these scenes are checked against; PyPI's is older. Rendering draws through Metal, so it needs a Mac with a GPU, not a virtual machine. LaTeX is only needed for `Tex()`.

## Check it works

```bash
python3 build.py demo --quality low    # narrated and rendered as lessons are: projects/demo/build/demo.mp4
python3 sandbox_probe.py               # renders inside the sandbox; should report it stopped nothing
```

## Build a video

```bash
python3 build.py demo                  # -> build/demo.mp4, .srt, .vtt, .jpg and .words.json
python3 build.py demo --quality low    # 480p, for a quick look
python3 build.py demo --no-cache       # render every scene, even unchanged ones
python3 build.py demo --no-narrate     # reuse the manifest as it is
python3 projects/demo/check_sync.py    # measure the demo's sync in the built video
```

A build does four things:

1. **Narrate.** `narrate.py` writes one 24 kHz mono WAV per block, plus `build/manifest.json`. A block is spoken again only when its text, voice or speed changes.
2. **Render.** Each scene in `project.json` is rendered in full with `manimgl -w`. A scene is rendered again only when its code, the shared code in `scenes.py`, its narration blocks, the quality, the runtime (`runtime/`) or manimgl changed; otherwise it comes from `build/cache/`, which keeps the last three builds. One scene may take 45 minutes (`VIDEO_SCENE_TIMEOUT`).
3. **Join.** ffmpeg concatenates the scenes. Each scene's audio is padded or cut to its picture's length, so sound cannot drift.
4. **Caption.** SRT and VTT come from the word timings. `<name>.words.json` holds every word's start and end, which the dashboard shows as a transcript.

A project in chapters is built a chapter at a time, each in `chapters/<id>/` with its own cache, then joined into one MP4 with chapter markers and captions across all of them. With `"title_cards": true`, a three-second card (`runtime/cards.py`) comes before each chapter.

The dashboard runs builds too: **Narrated video** on the Lessons tab. Builds share its queue, so audio jobs wait while one runs.

## Check a project

```bash
python3 check.py demo            # read the files, speak the script, run every scene once
python3 check.py demo --static   # only read the files
```

`check.py` prints a JSON report. An **error** means the build would fail: a block no scene plays, a mark that doesn't exist, a scene that raises. A **warning** means it builds but looks or sounds wrong: an animation more than 0.3 seconds past its word or block, or text crossing the frame edge or covering other text. Each problem says where it is, with the `file`, `line`, `block` or `scene` when known. Scenes run with `manimgl -s -w`, which executes every line without drawing, so two minutes of video checks in seconds.

A full check also writes a **storyboard** to `build/check/`: a still at every mark and at the end of every block, with the narration, length and problems. The dashboard plays it as an animatic.

Two helpers the lesson writer uses:

```bash
python3 splice.py projects/<name> --edit edit.json       # apply an edit that names only what changes
python3 autofix.py projects/<name> --report check.json   # fix the commonest model mistakes
```

`splice.py` replaces narration blocks by id and scene classes by name, and writes nothing if any part can't be applied. `autofix.py` fixes, without asking, Manim Community names ManimGL lacks (`MathTex`, `Create`, `GRAY` and so on) and block or mark names one typo off.

`runtime/kit.py` gives scenes `derivation()`, `boxed()`, `cancel()`, `plot()` and `note()`. A `scenes.py` may import only manim, `voiceover`, numpy and a few standard modules.

## The sandbox

A lesson's `scenes.py` was written by a model, so `check.py` and `build.py` run every scene inside the macOS sandbox (`sandbox.py`, rules in `scene.sb`):

| | |
| --- | --- |
| Network | None |
| Writing | The project's `build/`, the temporary folders, and one scene cache (`~/Library/Caches/narrated-proofs-scenes`, or `VIDEO_SCENE_CACHE`) |
| Reading | Only what rendering needs: the project, `runtime/`, the Python and its libraries, system libraries and fonts, TeX, ffmpeg and its libraries. Never `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude`, keychains, browsers or mail |
| Programs | Python, `ffmpeg`, `ffprobe` and the TeX tools. Not `open`, `osascript` or a shell |
| Other | No Apple Events, Launch Services or clipboard |
| Environment | `PATH`, `HOME`, the locale and what manim needs. No API keys or tokens |
| Limits | Two hours of CPU per process, files up to 4 GB |

The Python, TeX and ffmpeg locations are found when the scene runs, so another Mac's layout works. Folders many programs share, such as `/usr/bin`, are never opened whole.

### When a project fails only inside the sandbox

The error is usually "Operation not permitted", and says what to try:

```bash
VIDEO_SANDBOX=report python3 build.py <name>   # allow and log what the rules would stop
python3 sandbox_probe.py --project <name>      # render it and list what was stopped, as rules for scene.sb
VIDEO_SANDBOX=0 python3 build.py <name>        # no sandbox, for a hand-written project you trust
```

For dashboard lessons, set the variable when you start it: `VIDEO_SANDBOX=report npm start`. `.env` doesn't reach builds; they read only the environment.

Without `sandbox-exec` (Linux, Docker), scenes keep the short environment and the limits but are otherwise unconfined. In Docker the container holds, but a scene could still use the network and read what the container keeps: Claude Code's sign-in and saved keys. Don't render a project someone else wrote.

## A project

```
projects/demo/
  project.json   voice, speed, and the scenes to render in order
  script.txt     the narration
  scenes.py      the manim scenes
  build/         everything generated (git ignores it)
```

```json
{ "voice": "af_heart", "speed": 1.0, "script": "script.txt", "scenes_file": "scenes.py", "scenes": ["Slope", "SyncCheck"] }
```

A lesson from the dashboard also has `brief.json` (what it was written from), `notes/` (attached files), `author.json` (cost, once checked) and `versions/`. Git ignores every project except `demo`.

A lesson in chapters lists them instead of scenes, and each is a project of its own:

```json
{ "title": "Backpropagation", "voice": "af_heart", "speed": 1.0, "scenes": [],
  "chapters": ["01-one-neuron", "02-chain"],
  "chapter_titles": { "01-one-neuron": "One neuron", "02-chain": "The chain rule" },
  "title_cards": true }
```

Check one chapter with `python3 check.py projects/backprop-1/chapters/02-chain`.

### Writing a script

Each `[block-id]` line starts a block; the text under it is spoken. `#` lines are comments. The voice rests after each sentence (a little longer after `?` and `…`), longer at a blank line, and for half a second at the end of a block, so sections do not run together.

```
[intro]
Every straight line has a <mark name="slope"/>slope.
It tells you how far the line <mark name="rise"/>rises for each step to the right.
```

`<mark name="x"/>` is removed before speaking and resolves to the moment the next word starts (punctuation skipped). A mark after the last word resolves to the end. Marks need an English voice (ids starting `a` or `b`); with others they are ignored with a warning. Keep narration as WAV, never MP3, whose padding shifts every timing.

### Writing a scene

Put `VoiceoverScene` first in the bases and play a block with `self.voiceover(id)`:

```python
from manimlib import *
from voiceover import VoiceoverScene

class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.play(Write(title), run_time=vo.until("slope"))
            self.play(ShowCreation(line), run_time=vo.until("rise"))
            self.play(GrowArrow(arrow), run_time=vo.remaining())
```

- Entering the block adds its audio at the current scene time.
- `vo.until(mark)` is the seconds until that word; `vo.remaining()` until the audio ends; `vo.duration` is the block's length; `vo.time_of(mark)` is the mark's scene time.
- Durations aim at absolute times, so each animation ends at most one frame late and the error never adds up.
- Leaving the block waits for its audio. Animations that outrun the narration give a warning; a mark already passed gets one frame.
- Blocks can't overlap. An unknown block or mark raises an error listing the valid ones.

`manimgl scenes.py Intro -w` also works if the scene adds `video/runtime/` to `sys.path` and sets `voiceover_manifest`, as the demo does. Previews and `-n` / `-s` are silent.

manim advances its clock before drawing a frame, so frame *n* shows time (n+1)/fps while sound added at *t* plays at *t*. An animation that runs to a mark, followed by one on the next frame, puts the change on screen exactly when the word starts. `check_sync.py` measures this.

## Settings

Read from the environment, not `.env`. Set them in your shell, or when you start the dashboard.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIDEO_SANDBOX` | `1` | `1` strict rules, `report` allow and log, `0` none |
| `VIDEO_SCENE_CACHE` | `~/Library/Caches/narrated-proofs-scenes` | Cache for manim, TeX, matplotlib, fontconfig |
| `VIDEO_SCENE_TIMEOUT` | `2700` | Seconds one scene's render may take |
| `KOKORO_PYTHON` | `../.venv/bin/python` | Python that speaks the narration |
| `MANIMGL` | `../.venv/bin/manimgl` | The manimgl that renders |

## Troubleshooting

- **`No manimgl at …` or `No Kokoro Python at …`.** Run `../install.sh` again, or set `MANIMGL` / `KOKORO_PYTHON`.
- **`File 'something.sty' not found`.** `sudo tlmgr install something`; if `tlmgr` is missing, open a new terminal.
- **`latex`, `dvisvgm` or `ffmpeg` not found.** `build.py` adds `/Library/TeX/texbin`, `/opt/homebrew/bin` and `/usr/local/bin` to PATH when they exist; otherwise add them yourself.
- **A render fails about an adapter, a device or Metal.** Render on the Mac itself, not in a virtual machine.
- **"Operation not permitted".** See [the sandbox section](#when-a-project-fails-only-inside-the-sandbox).
- **Voice and picture drift apart.** Keep narration as WAV and run `check_sync.py` after building the demo.
- **The first build is slow.** It fills the scene cache; later builds render only what changed.
