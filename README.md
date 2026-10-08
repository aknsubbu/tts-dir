# Narrated Proofs

Type a topic, drop in your notes, and get a narrated maths explainer in the style of [3Blue1Brown](https://www.3blue1brown.com/): equations that build up line by line, shapes that move, and a voice that explains each step as it appears on screen.

Claude writes the lesson. It is rendered with [ManimGL](https://github.com/3b1b/manim), the animation library Grant Sanderson wrote for the 3Blue1Brown videos. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open model that runs on your Mac. This project is not affiliated with 3Blue1Brown.

Built for and tested on macOS with Apple Silicon.

## What it does

1. **You give it a topic**, what you want to understand, and optionally your notes: typed text, photos of handwritten pages, screenshots, PDFs or Word files.
2. **Claude writes the lesson** through [Claude Code](https://claude.com/claude-code): a narration script and the ManimGL scenes that go with it, using your notation and your examples.
3. **The scenes are checked.** Every scene is run once without drawing it. Common mistakes are fixed on the spot without asking Claude; if a scene still fails, or text overlaps, or an animation runs past its word, Claude is shown the problem and rewrites.
4. **You can look before it renders.** The check leaves a storyboard: a still of the screen at every marked word and at the end of every block, with its narration. Play it as an animatic, then approve it, or let lessons render straight away.
5. **The narration is spoken locally** by Kokoro, which also reports when each word starts.
6. **The animations are timed to the words.** A mark in the script, such as `<mark name="slope"/>`, makes an animation land on the exact frame that word is spoken.
7. **You get an MP4** with captions, in a searchable library. Each lesson shows what Claude cost to write it, and a rebuild renders only the scenes that changed.

A two-minute video takes roughly five to ten minutes, most of it Claude writing. The one example in this repo, on the gradient of logistic regression, cost about $0.70 of Claude usage.

## How the narration stays in sync

Each block of narration is spoken first, so its length and the start time of every word are known before anything is drawn. A scene then asks for durations instead of guessing them:

```python
class Intro(VoiceoverScene, Scene):
    def construct(self):
        with self.voiceover("intro") as vo:
            self.play(Write(title), run_time=vo.until("slope"))      # ends as "slope" is spoken
            self.play(ShowCreation(line), run_time=vo.until("rise"))
            self.play(GrowArrow(arrow), run_time=vo.remaining())     # ends with the sentence
```

The demo project measures this in the finished video: the change on screen lands within one frame of the word.

## What is here

| Path | What it is |
| --- | --- |
| [tts-studio/](tts-studio/) | The dashboard you use (Node, React, SQLite), the lesson writer that asks Claude, and the Kokoro voice engine. [README](tts-studio/README.md) |
| [video/](video/) | The video toolchain (Python): speak a script, check and render ManimGL scenes, join them, write captions. Usable on its own for videos you write by hand. [README](video/README.md) |
| [tts.py](tts.py) | Optional command-line launcher for the voice engine: `python3 tts.py script.txt` writes `script.mp3` |

```
topic + notes ──> tts-studio/author ──> claude -p            writes script.txt and scenes.py
                        │
                        └──> video/check.py                  runs every scene once; errors go back to Claude
                                  │
tts-studio/server ──> video/build.py ──> video/narrate.py    Kokoro speaks, with word timings
                                    ├──> manimgl             renders each scene, in a sandbox
                                    └──> ffmpeg              joins scenes, adds captions and a poster
```

## Setup

1. **Dashboard and voice.** Node 20 or newer, and Python 3.10 to 3.12 or [uv](https://docs.astral.sh/uv/).

   ```bash
   cd tts-studio
   npm install
   npm run setup      # once: installs Kokoro into .venv and downloads about 350 MB of model files
   ```

2. **Video toolchain.** ffmpeg, BasicTeX for the equations, and ManimGL in `video/.venv`. The commands are in [video/README.md](video/README.md#setup-macos).

3. **Claude Code.** [Install it](https://claude.com/claude-code), sign in, and have `claude` on your PATH. Each lesson uses your Claude plan or credits: one request to write it, plus one for each fix.

## Run

```bash
cd tts-studio
npm run app        # builds the UI and serves it on http://localhost:8787
```

Open the page, fill in **Explain it to me** on the Lessons tab, and press **Make the video**. The card in the library shows each stage, and the finished video plays there with captions.

Every lesson is also a normal project folder in `video/projects/`, so you can edit Claude's `script.txt` or `scenes.py` and rebuild:

```bash
python3 video/check.py <project>     # check it without rendering
python3 video/build.py <project>     # render it again
python3 video/build.py demo          # the hand-written demo project
```

The dashboard's **Audio** tab does plain script-to-MP3 with the same voice, with no Claude and no network. `python3 tts.py script.md` does the same from the terminal.

## What leaves your machine

- **Sent to Claude:** a lesson's topic, notes and attached files.
- **Stays local:** speech, rendering and the library. The server listens on `127.0.0.1` only and refuses requests from pages on other sites.
- **The code Claude writes runs in a sandbox:** no network, no Apple Events, no writing outside the lesson's `build/` folder and a cache kept for scenes, and none of the environment's API keys or tokens. It can still read most files, so it is confinement, not isolation. Details are in [video/README.md](video/README.md#the-sandbox).

## Tests

```bash
cd tts-studio
npm test           # server, lesson writer, page, engine and video tests
npm run lint
```

None of the tests call Claude, and the ones that load the real voice model are skipped until `npm run setup` has run. GitHub Actions runs lint, the tests and a build on every push to `master` and every pull request ([ci.yml](.github/workflows/ci.yml)).

## Where your files go

| Path | Contents | In git |
| --- | --- | --- |
| `tts-studio/data/` | The library: SQLite database, MP3s, finished videos | no |
| `video/projects/<name>/` | One folder per video: script, scenes, `project.json`, and `build/` (renders, the scene cache, the storyboard) | everything except `build/` and `versions/` |
| `video/projects/<name>/versions/` | Each version of a lesson: its script, scenes and storyboard as they were | no |
| `video/projects/<name>/notes/`, `brief.json` | Your notes and attached files for a lesson | no, for new lessons; the example lesson's `brief.json` is tracked |
| `.env` | Optional settings; see [tts-studio/.env.example](tts-studio/.env.example) | no |

## Future improvements

None of these exist yet.

- **MCP connector.** An MCP server in front of the dashboard's API, so Claude (in Claude Code, the desktop app or claude.ai) can make a lesson from inside a conversation: start one from a topic and notes, follow its stages, search the library and fetch the finished video. Today the only ways in are the web page and `curl`.
- **Edit and rebuild in the dashboard.** Change Claude's script or scenes in the page and rebuild, instead of opening the project folder in an editor.
- **Ask for a revision.** Tell Claude what to change in a finished lesson ("slow down the second scene", "use my notation for the loss") and have it rewrite only that.
- **Longer lessons.** Videos are limited to about five minutes. Longer ones need a chapter outline first, with each chapter written and checked on its own.
- **Stronger isolation for scenes.** The sandbox blocks the network, Apple Events and writes outside `build/`, and scenes no longer see the environment's secrets, but a scene can still read most files, start other programs and reach system services. Reading could be limited to the project, the ManimGL install, fonts and TeX, and starting programs to ffmpeg and TeX, once a probe on a Mac shows exactly what rendering needs.
- **Other platforms.** Attached photos and documents, and the sandbox, rely on tools that ship with macOS. Linux needs replacements for `sips`, `textutil` and `sandbox-exec`.
- **Word-level sync in other languages.** Only the English voices report word timings, so lessons are English only.
- **More of the page under test.** The lesson form, the lesson workspace, the storyboard, the library's cards, the API wrapper and the helpers are tested; the audio details panel and drag and drop are not.
