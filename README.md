# tts-dir

Local text-to-speech, and narrated maths videos built on top of it. You give a topic and your notes; Claude writes a script and ManimGL animations; the [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) voice model reads the script on your Mac; the animations are timed to the spoken words. Plain script-to-MP3 works too, with no account and no network.

Built for and tested on macOS with Apple Silicon.

## What is here

| Path | What it is |
| --- | --- |
| [tts-studio/](tts-studio/) | The dashboard (Node, React, SQLite), the Kokoro engine it runs, and the lesson writer that asks Claude for a script and scenes. [README](tts-studio/README.md) |
| [video/](video/) | The video toolchain (Python): speak a script, check and render ManimGL scenes, join them, write captions. [README](video/README.md) |
| [tts.py](tts.py) | Command-line launcher for the engine: `python3 tts.py script.txt` writes `script.mp3` |

How the parts call each other:

```
topic + notes ──> tts-studio/author ──> claude -p            writes script.txt and scenes.py
                        │
                        └──> video/check.py                  runs every scene once; errors go back to Claude
                                  │
tts-studio/server ──> video/build.py ──> video/narrate.py    Kokoro, in tts-studio/.venv
                                    ├──> manimgl             in video/.venv
                                    └──> ffmpeg              join scenes, captions, poster
```

There are two Python environments on purpose: `tts-studio/.venv` holds Kokoro and PyTorch, `video/.venv` holds ManimGL, and PyTorch never loads while rendering.

## Setup

Audio only needs step 1. Videos need all three.

1. **Dashboard and voice.** Node 20 or newer, and Python 3.10 to 3.12 or [uv](https://docs.astral.sh/uv/).

   ```bash
   cd tts-studio
   npm install
   npm run setup      # once: installs Kokoro into .venv and downloads about 350 MB of model files
   ```

2. **Video toolchain.** ffmpeg, BasicTeX and `video/.venv`. The commands are in [video/README.md](video/README.md#setup-macos).

3. **Claude Code**, for lessons written from a topic: [install it](https://claude.com/claude-code), sign in, and have `claude` on your PATH. Each lesson uses your Claude plan or credits.

## Run

```bash
cd tts-studio
npm run app        # builds the UI and serves it on http://localhost:8787
```

The server listens on `127.0.0.1` only and refuses requests from pages on other sites. Speech never leaves the machine. A lesson's topic, notes and attached files are sent to Claude. The animation code Claude writes runs in a sandbox with no network and no writing outside its own project.

Without the dashboard:

```bash
python3 tts.py script.md -o out.mp3 --voice bm_george     # text to speech
python3 video/build.py demo                               # build the demo video
python3 video/check.py demo                               # check a project without rendering it
```

## Tests

```bash
cd tts-studio && npm test
```

This runs the server and lesson writer tests (Node), the page's tests (vitest), then the engine and `video/` tests (Python). None of them call Claude, and the ones that load the real voice model are skipped until `npm run setup` has run. `npm run lint` runs ESLint. GitHub Actions runs lint, the tests and a build on every push to `master` and every pull request ([ci.yml](.github/workflows/ci.yml)).

## Where your files go

| Path | Contents | In git |
| --- | --- | --- |
| `tts-studio/data/` | The library: SQLite database, MP3s, finished videos | no |
| `video/projects/<name>/` | One folder per video: script, scenes, `project.json`, and `build/` | everything except `build/` |
| `video/projects/<name>/notes/`, `brief.json` | Your notes and attached files for a lesson | no, for new lessons; the example lesson's `brief.json` is tracked |
| `.env` | Optional settings; see [tts-studio/.env.example](tts-studio/.env.example) | no |
