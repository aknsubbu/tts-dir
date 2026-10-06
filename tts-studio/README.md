# TTS Studio

A local dashboard for text-to-speech. Drop a `.txt` or `.md` script, get an MP3, and keep every script and its audio in a searchable library. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open model that runs on your Mac: no API key, no quota, and it works offline.

- **Drop or paste** one or many scripts. Audio generation starts straight away (or review a batch first).
- **Library** of everything you've generated, with full-text search over titles, script text and tags, plus filters for status, voice, favorites and tags.
- **Player** with speed control, seeking and 15-second skips, plus MP3 and script downloads.
- **Nothing leaves your Mac.** The model runs in a local Python process and the server binds to `127.0.0.1` only.
- **54 voices** in American and British English, Spanish, French, Hindi, Italian, Brazilian Portuguese and Mandarin, with Japanese as an optional extra. Each one has a preview.

## Run it

Requires Node 20 or newer and Python 3.10 to 3.12 (or [uv](https://docs.astral.sh/uv/), which fetches a suitable Python itself).

```bash
cd tts-studio
npm install
npm run setup      # once: installs Kokoro into .venv and downloads the model
npm run app        # builds the UI and starts everything on http://localhost:8787
```

Then open <http://localhost:8787>.

`npm run setup` needs the internet once. It downloads PyTorch and about 350 MB of model and voice files into `~/.cache/huggingface`, then speaks a test sentence in every language. After that everything works offline. Japanese needs a further 1 GB dictionary, so it is separate: `npm run setup:japanese`.

For development with hot reload, run `npm run dev` and open <http://localhost:5173>.

| Command | What it does |
| --- | --- |
| `npm run setup` | Install or repair the Kokoro engine (safe to re-run) |
| `npm run app` | Build the UI, then start the server (the everyday command) |
| `npm start` | Start the server using the last build |
| `npm run dev` | Server with auto-restart plus Vite dev server on port 5173 |
| `npm test` | Server and engine tests. The ones that load the real model are skipped until `npm run setup` has run |

## Using it

1. **Drop files anywhere on the page**, or click the drop zone. Multiple files are queued and generated one at a time.
2. Pick a **voice** and speed on the left, in the language your script is written in. **Preview** plays a sample. Settings are remembered.
3. Watch progress on the cards. Click a card (or its play button) to open the details panel with the player and the full script.
4. Use the **search box** to find any script you've ever generated. It matches word prefixes and stems, so `simmering` finds `simmer`. The matching words are highlighted in the list and in the script.
5. Add **tags** and **favorites** in the details panel, then filter by them.

Turn off **Generate immediately on drop** to collect files into a batch first. You can then edit titles and see character counts and estimated length before generating.

### Good to know

- **Duplicates are caught.** If the script text, voice and settings match something you already generated, it isn't generated twice. You get a toast offering "Open it" or "Generate again". Titles and tags don't count as a difference.
- **Long scripts are split automatically** at paragraph, line and sentence boundaries, with a short pause between paragraphs, and encoded once into a single MP3 (24 kHz mono, 80 kbps). Expect roughly 10 to 25 times faster than real time on Apple Silicon.
- **One voice speaks one language.** A British voice reads Spanish text with English pronunciation rules, so match the voice to the script.
- **Regenerate** in the details panel re-runs a stored script with whatever voice and settings are currently selected on the left. Handy for trying another voice.
- **Markdown is stripped** before speaking (headings, bold, links, code blocks, bullet markers). You can turn this off.
- **Cancel works mid-job.** It restarts the voice engine, which takes a few seconds. If the engine crashes during a job, the job is retried once. Other failures show the reason on the card, with a Retry button. If the server restarts mid-job, that job is marked failed so you can retry it.
## Explain it to me: a video from a topic

The panel at the top of the left column makes a narrated, animated explainer from a topic and your notes. It is built for mathematics: derivations, proofs, the maths behind machine learning.

1. Type a **topic** and what you want to understand.
2. Paste your **notes**, or drop `.txt` and `.md` files on the panel. Notes are optional, but with them the video uses your notation and your examples.
3. Pick a length, a quality and an English voice, then press **Make the video**.

The card in the library shows each stage, and the finished video plays in the details panel with captions.

| Stage on the card | What is happening |
| --- | --- |
| Writing the lesson | Claude writes the narration and the animation code, with `claude -p` |
| Checking the scenes | The narration is spoken and every scene is run once without drawing it |
| Fixing the scenes (1 of 3) | A scene failed, so Claude is shown the error and rewrites |
| Polishing timing and layout | It runs, but text overlaps or an animation ran past its word, so Claude gets one go at those |
| Building 2/5 | Rendering each scene and joining them, as for any narrated video |

A two-minute video takes roughly five to ten minutes from start to finish. Most of that is Claude writing.

**What it needs.** [Claude Code](https://claude.com/claude-code) installed and signed in (`claude` on your PATH), and the `video/` folder set up as its README describes (manim, ffmpeg, LaTeX). Each lesson uses your Claude plan or credits: one request to write, plus one for each fix.

**What you get on disk.** Every lesson is a normal project in `../video/projects/<topic>-<id>/`: `script.txt`, `scenes.py`, your `brief.json`, and under `build/author/` every prompt sent to Claude and every answer. Edit the script or the scenes and rebuild from the **Narrated video** panel, or with `python3 ../video/build.py <name>`.

**How it works.** The lesson writer is a second small Express server in `author/`. `npm start` runs it in the same process on port 8790; `npm run author` runs it alone. It gives Claude no tools, so Claude can only send text back, and that text is checked by `../video/check.py` before anything is built. The prompts are plain files you can edit without restarting:

| File | What it is |
| --- | --- |
| `author/prompts/guide.md` | The system prompt: how to plan a lesson, the script and scene formats, the ManimGL reference |
| `author/prompts/lesson.md` | The request, with `{{topic}}`, `{{goal}}`, `{{notes}}` and the length filled in |
| `author/prompts/repair.md` | The follow-up when the check finds problems |
| `author/prompts/example/` | The worked example shown to Claude. `npm test` checks it still passes |

**Good to know**

- The scenes are Python that Claude wrote and your machine runs, with your permissions. The check refuses imports beyond manim, numpy, `math`, `random`, `itertools` and `functools`, and names such as `open`, `eval`, `os`, `sys` and `getattr`, but that is a guard against accidents and not a sandbox: code written to get around it can. Notes are sent to Claude as material to teach from, so only use notes you trust, or read `scenes.py` before building when you are unsure.
- Lessons need an English voice, because animations follow individual words and only the English voices report word timings.
- If Claude cannot get the scenes to run in three fixes, the card fails with the last error. **Retry** carries on from the files already written.
- Cancel works at every stage, and stops Claude, the check or the build.

## Where things are stored

Everything lives in `data/` inside the project (override with `TTS_DATA_DIR`):

```
data/
  studio.db        SQLite database: scripts, settings, status, and the full-text index
  audio/<id>.mp3   one MP3 per finished generation
  previews/        cached voice samples
```

Back it up by copying that folder. Deleting an item in the UI removes its database row, its search entry and its MP3.

## Configuration

All optional. Put them in a `.env` in this folder or the one above it, or in the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TTS_VOICE` | `af_heart` | Voice preselected on first run |
| `TTS_DEVICE` | `auto` | `auto` uses the Apple GPU when there is one, else the CPU. Set `cpu` if you see audio glitches |
| `TTS_PYTHON` | `.venv/bin/python` | A Python that has `kokoro` installed |
| `PORT` | `8787` | Port for `npm start` |
| `TTS_DATA_DIR` | `./data` | Library location |
| `TTS_ENV_DIR` | none | Another folder to read `.env` from |
| `TTS_CLAUDE_BIN` | `claude` | The Claude Code command the lesson writer runs |
| `TTS_CLAUDE_MODEL` | Claude Code's default | Model for writing lessons, such as `opus` or `sonnet` |
| `TTS_CLAUDE_EFFORT` | Claude Code's default | Effort level: `low`, `medium`, `high`, `xhigh` or `max` |
| `TTS_CLAUDE_TIMEOUT_MIN` | `20` | Minutes one request to Claude may take |
| `TTS_AUTHOR_FIXES` | `3` | How many times Claude may be asked to fix failing scenes |
| `TTS_AUTHOR_POLISH` | `1` | `0` skips the extra round for timing and layout warnings |
| `AUTHOR_PORT` | `8790` | Port for the lesson writer |
| `TTS_AUTHOR_URL` | none | Use a lesson writer running elsewhere and do not start one |
| `TTS_VIDEO_DIR` | `../video` | The folder holding `build.py`, `check.py` and `projects/` |

## From the terminal

`tts.py` in the folder above uses the same engine without the dashboard:

```bash
python3 ../tts.py script.md                      # writes script.mp3 next to the input
python3 ../tts.py script.md -o out.wav --voice bm_george --speed 1.1
python3 ../tts.py --list-voices
python3 ../tts.py script.md -o out.wav --timings out.json   # plus word start/end times (English voices)
```

The dashboard also has a small JSON API, so scripts can be pushed into the library from the command line:

```bash
curl -s localhost:8787/api/generations \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile t script.txt '{title:"My script", text:$t, voiceId:"af_heart"}')"
```

A lesson can be started the same way:

```bash
curl -s localhost:8787/api/lessons \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile n notes.md '{topic:"Gradient of logistic regression", goal:"Why it collapses to (y_hat - y) x", notes:$n, minutes:2, quality:"low"}')"
```

They show up in the library like anything dropped in the UI. Other useful routes: `GET /api/generations?q=search+terms`, `GET /api/generations/:id/audio`, `GET /api/voices`, `GET /api/stats`.

## Project layout

```
engine/
  kokoro_engine.py  the Kokoro engine: command line tool and the worker the server runs
  test_engine.py    text splitting tests
  requirements.txt  Python packages
server/
  index.js        start-up
  app.js          REST API
  config.js       reads optional settings
  kokoro.js       starts the Python worker and talks to it
  runner.js       serial job queue
  db.js           SQLite schema, FTS5 index, queries
  text.js         markdown cleanup
  test/           node:test suite (fake engine, plus tests against the real one)
  lessons.js      follows a lesson through the lesson writer, then queues its build
  video.js        runs video/build.py
author/
  index.js        the lesson writer on its own (npm run author)
  app.js          its HTTP API: POST /lessons, GET /lessons/:id, POST /lessons/:id/cancel
  pipeline.js     write, check, fix, polish
  claude.js       runs `claude -p` and reads its answer
  prompts.js      fills the templates in prompts/
  prompts/        the prompt templates and the worked example
  test/           tests with a fake claude and a fake check
client/
  src/App.jsx     state, polling, drag and drop
  src/components/ Header, LessonPanel, Composer, VideoPanel, Library, Drawer, Toasts
scripts/setup.sh  creates .venv and downloads the model
```

## Troubleshooting

- **"Voice engine offline" in the header.** The red banner says why. Usually `npm run setup` hasn't been run, or was interrupted; run it again. The page reconnects by itself.
- **"Loading voice model…" for a long time.** The first start after a reboot takes 5 to 10 seconds. Longer than a minute means the worker is stuck; restart the server and look at its terminal output.
- **A Japanese voice is greyed out.** Run `npm run setup:japanese`.
- **A word is mispronounced (English voices only).** Write it as a link whose target is its phonemes between slashes, for example `[Kokoro](/kˈOkəɹO/)`. These hints are kept even when markdown is stripped.
- **`npm install` fails on `better-sqlite3`.** It normally installs a prebuilt binary. If your Node version has none, install Xcode command line tools (`xcode-select --install`) so it can compile, or switch to an LTS Node.
- **Port already in use.** Set `PORT=8788` in your `.env`.
