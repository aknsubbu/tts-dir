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
python3 build.py demo                  # -> projects/demo/build/demo.mp4, demo.srt, demo.vtt
python3 build.py demo --quality low    # 480p, for a quick look
python3 projects/demo/check_sync.py    # measures the demo's sync in the built video
```

The build does four things:

1. **Narrate.** Runs `narrate.py` with the Kokoro Python. It writes one 24 kHz mono WAV per block, plus `build/manifest.json`. A block is only spoken again when its text, voice or speed changes, so moving a mark costs nothing.
2. **Render.** Renders each scene listed in `project.json`, in full, with `manimgl -w`. Partial renders (`-n`, `-s`) are never used, because manim drops sounds added while it skips.
3. **Join.** Concatenates the scene videos in the listed order with ffmpeg. Each scene's audio is padded or cut to its picture's length, so sound cannot drift.
4. **Caption.** Writes SRT and VTT from the word timings. Each caption is placed at the start time its scene recorded for the block, plus the real lengths of the earlier scenes as reported by ffprobe.

The TTS Studio dashboard can run builds too: open **Narrated video** in its left column, pick a project and a quality, and the finished video lands in the library with its captions. Builds share the dashboard's queue, so audio jobs wait while one runs.

Use `--no-narrate` to reuse the manifest as it is. `$KOKORO_PYTHON` and `$MANIMGL` override where the two environments are.

## A project

A project is a folder under `projects/`:

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
