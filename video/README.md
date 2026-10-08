# video

Narrated manim videos, with audio from the Kokoro engine in `../tts-studio`.

Two Python environments, kept apart so torch never loads while rendering:

- `../tts-studio/.venv` speaks the narration (`narrate.py`). `npm run setup` in tts-studio creates it.
- `video/.venv` renders the scenes with ManimGL (set up below).

`build.py` runs both. It only needs the standard library, so plain `python3` runs it.

## Setup (macOS)

```bash
brew install ffmpeg
brew install --cask basictex        # asks for your password; needed for Tex()
eval "$(/usr/libexec/path_helper)"  # or open a new terminal, to pick up /Library/TeX/texbin
sudo tlmgr update --self
sudo tlmgr install dvisvgm standalone preview babel-english doublestroke setspace tipa relsize rsfs calligra fundus-calligra wasysym wasy ragged2e physics xcolor microtype cm-super

cd video
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

If `SmokeTex` fails on a missing `.sty`, install the package it names with `sudo tlmgr install <name>`.
LaTeX is only needed for `Tex()`; the demo project uses `Text()` and runs without it.

## Check it works

```bash
.venv/bin/manimgl smoke/smoke_scene.py SmokeText -w --hd --video_dir smoke/out    # shapes and Text
.venv/bin/manimgl smoke/smoke_scene.py SmokeTex -w --hd --video_dir smoke/out     # needs LaTeX
echo "The derivative measures how fast a function changes." | python3 ../tts.py - -o smoke/out/line.wav
.venv/bin/manimgl smoke/smoke_scene.py SmokeAudio -w --hd --video_dir smoke/out   # needs line.wav
```

`-w` renders without opening a window. Leave it off to preview in a window, which is silent.

## Build a narrated video

```bash
python3 build.py demo                  # -> projects/demo/build/demo.mp4, .srt, .vtt, .jpg and .words.json
python3 build.py demo --quality low    # 480p, for a quick look
python3 build.py demo --no-cache       # render every scene, even unchanged ones
python3 projects/demo/check_sync.py    # measures the demo's sync in the built video
```

The build does four things:

1. **Narrate.** Runs `narrate.py` with the Kokoro Python. It writes one 24 kHz mono WAV per block, plus `build/manifest.json`. A block is only spoken again when its text, voice or speed changes, so moving a mark costs nothing.
2. **Render.** Renders each scene listed in `project.json`, in full, with `manimgl -w`. Partial renders (`-n`, `-s`) are never used, because manim drops sounds added while it skips. A scene is rendered again only when something that decides its picture or sound changed: the shared code in `scenes.py` and the scene's own class (and any scene it inherits from), the narration blocks it plays, the quality, the runtime (`runtime/voiceover.py`, `runtime/kit.py`) or manimgl itself. Otherwise its video from an earlier build is reused from `build/cache/`, which keeps what the last three builds used. Each scene's render may take 45 minutes (`VIDEO_SCENE_TIMEOUT`, in seconds).
3. **Join.** Concatenates the scene videos in the listed order with ffmpeg. Each scene's audio is padded or cut to its picture's length, so sound cannot drift.
4. **Caption.** Writes SRT and VTT from the word timings. Each caption is placed at the start time its scene recorded for the block, plus the real lengths of the earlier scenes as reported by ffprobe. The same times go into `<name>.words.json`, every spoken word with its start and end in the finished video, block by block, which the dashboard shows as a transcript beside the player.

A project in chapters is built a chapter at a time: each chapter is a project of its own in `chapters/<id>/`, built as above with its own cache, and the chapters are then joined in order into one MP4 with chapter markers (players such as QuickTime and VLC list them), captions and `<name>.words.json` across every chapter (each block names its chapter), and `<name>.chapters.vtt` with the chapters' start times. With `"title_cards": true`, a three-second card rendered from `runtime/cards.py` ("Chapter 2", then its title) comes before each chapter, kept in `build/cards/` until its text or the quality changes.

The Narrated Proofs dashboard can run builds too: on its **Lessons** tab open **Narrated video** under the lesson form, pick a project and a quality, and the finished video lands in the library with its captions. Builds share the dashboard's queue, so audio jobs wait while one runs.

Use `--no-narrate` to reuse the manifest as it is. `$KOKORO_PYTHON` and `$MANIMGL` override where the two environments are.

## Check a project before building

```bash
python3 check.py demo            # read the files, speak the script, run every scene once
python3 check.py demo --static   # only read the files
```

`check.py` prints a JSON report. An **error** means the build would fail: a block no scene plays, a mark that does not exist, a scene that raises. A **warning** means it would build but look or sound wrong: an animation that ran more than 0.3 seconds past its word or past the end of its block, text that crosses the edge of the frame, text on top of other text. Each warning names its block. Every problem says `where` it is in words, and, when it can be pinned down, the `file` and `line` it is on and its `block` or `scene`: a failing scene points at the last line of `scenes.py` its traceback passed through, and a timing or layout warning at the line that plays its block. The dashboard's editor underlines them. Each scene is run with `manimgl -s -w`, which executes every line without drawing the animations, so a two-minute video is checked in a few seconds.

A full check also leaves a **storyboard**: a picture of the screen at every mark and at the end of every block in `build/check/frames/`, described by `build/check/storyboard.json` (per scene, per block: the narration with its marks, its length, its stills and its problems). Animations are skipped, so each picture shows where things end up. A play that runs up to a mark is pictured as it ends; a wait that runs up to a mark is pictured after the animation that follows it, since that is the reveal the viewer sees on that word. The dashboard shows the storyboard and plays it as an animatic.

```bash
python3 splice.py projects/<name> --edit edit.json   # apply an edit that names only what changes
```

`splice.py` applies an answer that names only what changes: narration blocks by id (new ones after a block it names), scene classes by name (replaced by their exact line range from Python's `ast`, decorators and the comments directly above included; new ones after a class it names), and the code above the first class. Blocks keep their place, their `[id]` line and their comments. Anything that cannot be applied (an unknown block or class, code that does not parse) is reported and nothing is written. The lesson writer uses it for fixes, the polish and revisions.

`runtime/kit.py` is a small kit for scenes, importable as `from kit import ...` like `voiceover`: `derivation(*lines)` (equations one under another, lined up on their equals signs), `boxed(m)`, `cancel(m)`, `plot(f, x_range, y_range)` (axes, a graph and labels) and `note(text)`. A change to it re-renders cached scenes, as a change to `voiceover.py` does.

```bash
python3 autofix.py projects/<name> --report check.json   # fix common mistakes, given check.py's report
```

`autofix.py` fixes, without asking anyone, the mistakes a model makes most often: names from Manim Community that ManimGL does not have (`MathTex`, `Create`, `axes.plot`, `self.camera.frame`, `GRAY`) and a mark or block name one typo away from a real one, on the line the report names. The lesson writer runs it before every fix round.

This is what the dashboard's **Explain it to me** panel runs on the scenes Claude writes; see `../tts-studio/README.md`. It also limits what a `scenes.py` may import to manim, `voiceover`, numpy and a few standard modules.

## The sandbox

A `scenes.py` is ordinary Python, and a lesson's was written by a model. So `check.py` and `build.py` run every scene inside the macOS sandbox (`sandbox.py`, with the fixed rules in `scene.sb`):

| | |
| --- | --- |
| Network | None |
| Writing | Only the project's `build/` folder, the system's temporary folders, and one cache kept for scenes (`~/Library/Caches/narrated-proofs-scenes`, or `VIDEO_SCENE_CACHE`). Not the project's own script, scenes or notes, and not the caches other programs keep in your home folder, such as Kokoro's model files in `~/.cache` |
| Reading | Only what rendering needs: the project itself, the scene runtime (`runtime/`), the Python that runs manim (its prefix, the Python it was made from, its import path), the system's libraries, frameworks and fonts, the TeX installation, ffmpeg and the Homebrew libraries it loads, and the scene cache. Never `~/.ssh`, `~/.aws`, `~/.config`, `~/.claude`, keychains, browser profiles or mail. File metadata stays readable everywhere, so paths resolve: a scene can tell that a file exists, but not read it or list its folder |
| Starting programs | Only that Python, `ffmpeg` and `ffprobe`, and the TeX programs (`latex`, `xelatex`, `dvisvgm` and the rest of the TeX tree). Not `open`, `osascript`, a shell or anything else |
| Other programs | No Apple Events, no Launch Services (so it cannot have the browser open a URL) and no clipboard |
| Environment | A short list: `PATH`, `HOME`, the locale, a temporary folder and the variables manim and the voiceover runtime need. No API keys or tokens |
| Limits | Two hours of CPU per process and files of at most 4 GB |

The places to read and the programs to start are found when the scene runs, not written down: the Python from `manimgl`'s first line and what it reports, TeX from `kpsewhich` (MacTeX, BasicTeX, Homebrew's or MacPorts' TeX Live), and `ffmpeg` and `ffprobe` from `PATH`, so another Mac's layout works. A folder many programs share, such as `/usr/bin` or `/opt/homebrew/bin`, is never opened whole; what is needed in it is named one by one.

To make that possible, `sandbox.prepare()` points the caches manim, matplotlib, fontconfig and TeX would keep in your home folder at the scene cache, and passes manimgl a `--config_file` (`build/manim-config.json`) that moves its LaTeX working folder into `build/`. Scenes import `voiceover`, `kit` and nothing else of this toolchain from `runtime/`, which is all of `video/` they can read. The environment and the limits apply everywhere, sandbox or not.

**When a project fails only inside the sandbox.** A scene the sandbox stopped fails with "Operation not permitted", and the error says what to do next:

```bash
VIDEO_SANDBOX=report python3 build.py <name>   # allow and log what the reading, starting and asking rules would stop
python3 sandbox_probe.py --project <name>      # render it (and the smoke scenes and example lesson) and list what was stopped
VIDEO_SANDBOX=0 python3 build.py <name>        # no sandbox at all, for a hand-written project you trust
```

`VIDEO_SANDBOX=report` keeps the network, writing and private-folder rules, and only reports the rest: each read, start or lookup the strict rules would stop is allowed and written to the macOS log. `sandbox_probe.py` renders the smoke scenes, the example lesson and any projects you name from copies, once reporting and once strict, reads the log and prints what was stopped as rules for `scene.sb`, each with what asked for it. Run it once after setting up `video/`: a Mac whose rendering needs something these rules did not foresee (a font folder, a TeX helper script) shows it there.

`sandbox-exec` ships with macOS; on a system without it scenes run unconfined. CI renders the Text smoke scene inside the strict sandbox on macOS, when the runner can render at all.

## A project

A project is a folder under `projects/`:

```
projects/demo/
  project.json   voice, speed, and the scenes to render in order
  script.txt     the narration
  scenes.py      the manim scenes
  build/         everything generated (git ignores it)
```

A project the dashboard's lesson writer made also has `brief.json` (the topic and notes it was written from), `notes/` (attached photos and PDFs), `author.json` (written once the scenes passed their check, with what Claude cost) and `versions/` (each version's script, scenes and storyboard as they were). Git ignores `brief.json` and `notes/` for new lessons, because they hold your own notes. The example lesson's `brief.json` was committed before that rule and is still tracked.

```json
{ "voice": "af_heart", "speed": 1.0, "script": "script.txt", "scenes_file": "scenes.py", "scenes": ["Slope", "SyncCheck"] }
```

### A lesson in chapters

A long lesson's `project.json` lists its chapters instead of scenes, and each chapter folder is a project like the one above:

```json
{ "title": "Backpropagation", "voice": "af_heart", "speed": 1.0, "scenes": [],
  "chapters": ["01-one-neuron", "02-chain"],
  "chapter_titles": { "01-one-neuron": "One neuron", "02-chain": "The chain rule" },
  "title_cards": true }
```

```
projects/backprop-1/
  project.json   the chapters in order, their titles, and whether each gets a title card
  outline.json   the outline the chapters were written from (lessons only)
  chapters/01-one-neuron/   project.json, script.txt, scenes.py, build/
  chapters/02-chain/        the same
  build/         the joined video, captions, transcript and chapters
```

`check.py` checks one chapter at a time: `python3 check.py projects/backprop-1/chapters/02-chain`.

### Writing a script

Each `[block-id]` line starts a narration block, and the text under it is what is spoken. Lines starting with `#` are comments. A blank line inside a block is a paragraph break, and the speaker pauses a little longer there.

```
[intro]
Every straight line has a <mark name="slope"/>slope.
It tells you how far the line <mark name="rise"/>rises for each step to the right.
```

`<mark name="x"/>` is a bookmark. It is removed before the text is spoken, and it resolves to the moment the first word after it starts. Punctuation is skipped, so a mark before an opening quote lands on the word inside the quote. A mark after the last word resolves to the end of the speech.

Word timing only exists for English voices (ids starting with `a` or `b`). With any other voice, marks are ignored with a warning, and scenes sync to whole blocks only.

Keep the narration as WAV, never MP3: MP3 encoder padding shifts every timing.

### Writing a scene

Put `VoiceoverScene` first in the class bases, then play a block with `self.voiceover(id)`:

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
- `vo.until(mark)` gives the seconds from now until that word starts. `vo.remaining()` gives the seconds until the block's audio ends. `vo.duration` is the block's length, and `vo.time_of(mark)` is the mark's absolute scene time.
- Every duration is measured from the scene's clock as it is right now, to an absolute target. `play` and `wait` round up to whole frames, so each animation ends at most one frame late, and that error never adds up.
- Leaving the block waits until its audio has finished, so narration never runs past the video. If your animations ran longer than the narration, you get a warning with the overrun. The same applies when a mark has already passed: that animation gets one frame instead.
- Blocks cannot overlap. An unknown block id or mark raises an error that lists the valid ones.

Code that is not inside a `with` block runs with no narration, as usual.

Running `manimgl scenes.py Intro -w` directly also works. To make that possible, the demo's scenes add `video/` to `sys.path` and set `voiceover_manifest` to the project's `build/manifest.json`. A window preview is silent, and so is `-n` / `-s`.

### Timing details

manim advances its clock before it draws each frame. So frame *n* of a scene shows scene time (n+1)/fps, while sound added at scene time *t* plays at video time *t*. When an animation runs until a mark and the next one starts on the following frame, the change is on screen exactly when the word starts. `check_sync.py` measures this in the built demo, and reports the offset in milliseconds for both the audio placement and the first yellow frame.
