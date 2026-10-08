# Narrated Proofs: the dashboard

A local dashboard with two tabs. **Lessons** turns a topic and your notes into a narrated, animated explainer video. **Audio** turns a `.txt` or `.md` script into an MP3. Everything you make is kept in a searchable library. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open model that runs on your Mac: no API key, no quota, and it works offline.

- **Drop or paste** one or many scripts. Audio generation starts straight away (or review a batch first).
- **Library** of everything you've generated, with full-text search over titles, script text and tags, plus filters for status, voice, favorites and tags.
- **Player** with speed control, seeking and 15-second skips, plus MP3 and script downloads.
- **Speech never leaves your Mac.** The model runs in a local Python process. The server binds to `127.0.0.1` and refuses requests that come from a page on another site.
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
| `npm run author` | The lesson writer on its own, for running it apart from the dashboard |
| `npm test` | Everything: server and lesson writer (`test:server`), the page (`test:client`), engine and `../video` (`test:python`). The ones that load the real model are skipped until `npm run setup` has run |
| `npm run lint` | ESLint over the server, the lesson writer and the page |

## Using it

The page opens on the **Lessons** tab, described in the next section. Switch to **Audio** in the header for plain text-to-speech:

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

The **Lessons** tab makes a narrated, animated explainer from a topic and your notes. It is built for mathematics: derivations, proofs, the maths behind machine learning.

1. Type a **topic** and what you want to understand.
2. Add your **notes**: type or paste them, drop files anywhere on the page, or paste a screenshot. Notes are optional, but with them the video uses your notation and your examples.
3. Pick a length, a quality and an English voice. Under **Before it renders**, choose **Render right away**, or **Show me the storyboard** to look the lesson over first. Then press **Make the video**.

The card in the library shows each stage. Click it to open the lesson's workspace, a full-width page with three tabs, each with its own address (`#lesson/<id>/watch`, `/storyboard`, `/notes`):

- **Watch**: the video with captions, or what is happening to it. Below it, what writing the lesson took: who wrote each step, the cost, the tokens read (and how many came from the cache) and written, how many fixes the writer made and how many common mistakes were fixed without it.
- **Storyboard**: every narration block, scene by scene, with a still of the screen at each marked word and at the end of the block, its narration with the marks shown, any timing or layout problem, and a button to hear it. **Play as animatic** plays the narration block after block and changes the picture on the marked words, so a lesson can be judged before it is rendered. The stills come from the check, which skips animations, so each shows where things end up, not how they move.
- **Notes**: what you asked for, the files you attached and the narration.

A lesson that waits for you says **Storyboard ready** on its card, and the header counts them. In its workspace, **Approve and render** renders it at the quality you pick there, and **Don't render** cancels it (Retry renders it after all). While a lesson is rebuilt, it keeps playing its last built version.

**Let the writer look over its own frames** sends the storyboard's end-of-block stills in one more request, to catch what the checks cannot measure: a shape over a label, a crowded frame, colours hard to tell apart. Its changes are kept only if they break nothing. A polisher that cannot see pictures gets the warnings alone.

Notes can be more than text:

| Kind of file | What happens to it |
| --- | --- |
| `.txt`, `.md` | Read in the browser and added to the notes box |
| Images (PNG, JPEG, WebP, GIF, HEIC, TIFF, BMP) | Shown to Claude as pictures: handwritten working, textbook pages, diagrams. Each is re-encoded as a JPEG of at most 1400 pixels on its long side (`TTS_NOTES_IMAGE_EDGE`), which also drops the location and camera details in phone photos. A picture costs Claude tokens by its area, so a smaller one is a cheaper request |
| PDF | Shown to Claude whole, pages and figures included. Type pages under it (`1-3, 7`) to send only those, or tick **text only** to send its text: cheaper, and readable by any model, but figures and handwriting are lost |
| Word, RTF, OpenDocument (`.docx`, `.doc`, `.rtf`, `.odt`) | Turned into text and added to the typed notes |

A lesson takes up to 12 attached files and 20 MB in total, and 60,000 characters of text. Converting images and documents uses `sips` and `textutil`, which ship with macOS; elsewhere PNG, JPEG, WebP and GIF images are accepted as they are, and other images and all documents are refused. Choosing PDF pages and taking a PDF's text use PDFKit on macOS and poppler (`pdfinfo`, `pdftotext`, `pdfseparate`, `pdfunite`) elsewhere.

| Stage on the card | What is happening |
| --- | --- |
| Reading the notes with Claude Code | Only when another writer reads your notes than writes the lesson: the reader writes out the pictures and PDFs as text first |
| Writing the lesson (or Reading the notes and writing the lesson) | The writer writes the narration and the animation code |
| Checking the scenes | The narration is spoken and every scene is run once without drawing it, leaving the storyboard |
| Waiting for another lesson to finish its check | Two lessons can be written at once, but checks take turns |
| Checking the automatic fixes | A common mistake (a name from Manim Community, a mistyped mark) was fixed without asking Claude, and the scenes are checked again |
| Fixing the scenes (1 of 3) | A scene still failed, so the writer is shown the error and rewrites. With another fixer than the writer, the stage names it |
| Handing the fixes back to Claude Code | The cheaper fixer failed as many times as Settings allow, so the main writer takes over |
| Polishing timing and layout | It runs, but text overlaps or an animation ran past its word, so Claude gets one go at those |
| Looking over the frames | The same, with the storyboard's stills, when you asked Claude to look over its own frames |
| Storyboard ready: have a look | Waiting for you to approve it |
| Building 2/5 | Rendering each scene and joining them, as for any narrated video. A scene unchanged since an earlier build is reused |

A two-minute video takes roughly five to ten minutes from start to finish. Most of that is Claude writing.

**What it needs.** A writer: by default [Claude Code](https://claude.com/claude-code) installed and signed in (`claude` on your PATH); see **Who writes your lessons** below for the others. And the `video/` folder set up as its README describes (manim, ffmpeg, LaTeX). A lesson is one request to write, plus one for each fix and one for the polish. The form shows who will write it and about what it will cost, and the header shows what lessons cost this month.

**What it costs, and how it is kept down.** Most of a request's cost is what Claude writes, thinking included. So each step asks with its own effort: writing at high, fixes at low (a fix is mechanical), the polish at medium (`TTS_CLAUDE_EFFORT`, `TTS_CLAUDE_FIX_EFFORT`, `TTS_CLAUDE_POLISH_EFFORT`; `auto` leaves it to Claude Code). Common mistakes are fixed by `../video/autofix.py` before Claude is asked. Every request's token counts and cost are saved beside its prompt in `build/author/`.

**What you get on disk.** Every lesson is a normal project in `../video/projects/<topic>-<id>/`: `script.txt`, `scenes.py`, your `brief.json`, the attached files in `notes/`, under `build/author/` every prompt sent to Claude, every answer and what each cost, under `build/check/` the storyboard, and in `versions/001/` the files and storyboard as Claude first wrote them. Edit the script or the scenes and rebuild from the **Narrated video** panel under the lesson form, or with `python3 ../video/build.py <name>`.

**How it works.** The lesson writer is a second small Express server in `author/`. `npm start` runs it in the same process on port 8790; `npm run author` runs it alone. It gives Claude no tools, so Claude can only send text back, and that text is checked by `../video/check.py` before anything is built. The prompts are plain files you can edit without restarting:

| File | What it is |
| --- | --- |
| `author/prompts/guide.md` | The system prompt: how to plan a lesson, the script and scene formats, the ManimGL reference |
| `author/prompts/lesson.md` | The request, with `{{topic}}`, `{{goal}}`, `{{notes}}` and the length filled in |
| `author/prompts/repair.md` | The follow-up when the check finds problems |
| `author/prompts/example/` | The worked example shown to Claude. `npm test` checks it still passes |

**Good to know**

- The scenes are Python that Claude wrote and your machine runs. Two things confine them. The check refuses imports beyond manim, numpy, `math`, `random`, `itertools` and `functools`, and names such as `open`, `eval`, `os`, `sys` and `getattr`. And every scene runs inside the macOS sandbox: no network, no Apple Events, no writing outside its project's `build/` folder and a cache kept for scenes, no reading `~/.ssh`, keychains and the like, and only a short list of environment variables, so no API keys or tokens. It can still read most other files, so it is confinement and not isolation; see `../video/README.md`.
- Lessons need an English voice, because animations follow individual words and only the English voices report word timings.
- If Claude cannot get the scenes to run in three fixes, the card fails with the last error. **Retry** carries on from the files already written.
- Cancel works at every stage, and stops Claude, the check or the build.
- Pictures and PDFs go to the writer with the first request only. A fix is about code that failed, so it is sent the script and scenes alone.
- A fix from another provider that cannot even answer in the format asked for counts as a failed fix when there is a writer to hand back to; otherwise the lesson fails with the provider's message. A provider's rate limit is retried after the time it asks for; a daily limit fails with a message naming it.
- A lesson's first version is kept in `versions/001/` beside it, with the storyboard it was approved from. Later versions (edits and revisions) are on the way.

## Who writes your lessons: Settings

The gear in the header opens **Settings** (`#settings`). Its **Lesson writer** section chooses who writes lessons:

| Provider | Connects through | Structured answers | Pictures | PDFs | Cost shown |
| --- | --- | --- | --- | --- | --- |
| Claude Code (the default) | `claude -p` and your sign-in | Schema | Yes | Yes | Claude Code's own figure |
| Claude API | Your key, Anthropic's SDK | Schema | Yes | Yes | From token counts |
| OpenAI | Your key, OpenAI's SDK | Schema | Yes | Yes | From token counts, once you add a rate |
| Groq | Your key, its OpenAI-compatible API | Schema on some models, JSON mode on others | Some models | No: text is taken from PDFs | From token counts, once you add a rate |
| This Mac: Ollama | Ollama's own API | Schema | Vision models only | No | Free |
| This Mac: OpenAI-compatible (LM Studio, llama.cpp, MLX, vLLM) | Its address | Whatever the Test finds | Vision models only | No | Free |
| Other (OpenRouter, Together, your own server) | Its address and key | Whatever the Test finds | | | Your rates |

- **Test** checks a provider: the key, its models, and for the model you pick whether it gives structured answers (schema, JSON mode or neither), sees pictures, reads PDFs and takes an effort setting, how long its context is and how fast it writes. Each check is a tiny request.
- **One for all, or per step.** Reading your notes, writing the lesson, fixing and polishing, and outlines can each have their own provider, model and effort. Effort left at **Default** follows `TTS_CLAUDE_*_EFFORT`.
- **Hand-back.** With another fixer than the writer, say a model on this Mac, a fix that fails a set number of times goes back to the main writer, which gets its own rounds.
- **Reading notes.** When the reader and the writer differ, the reader writes out the attached pictures and PDFs as text first (kept as `notes/transcribed.md`), so a writer that cannot see still gets everything in them. PDFs go to a model that cannot read them as their text; a scanned PDF, or a picture for a model that cannot see, is refused with what to change. The form says so before you start.
- **Per lesson.** The form's **Written by** list can pick any set-up provider for one lesson.
- **On record.** Each version notes the provider and model of every request, its tokens and its cost, in `build/author/` and on the lesson.
- **Where your notes go** is stated under the steps: the company each step sends your topic, notes and files to. With every step on this Mac, nothing leaves it. Scenes always run only on this Mac.

**Keys** go in once and never come back to the page, which shows only how a key ends. On macOS they are kept in the Keychain under "Narrated Proofs" (through the built-in `security` command, with the key on its standard input, never on a command line); elsewhere, or with `TTS_KEYCHAIN=0`, in `data/secrets.json`, readable only by you. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GROQ_API_KEY` in the environment or `.env` win over a key saved here. Keys are never logged, never written into projects or the prompt logs, and never reach scenes. A key saved here is never given to `claude -p` either, so Claude Code keeps using your plan; an `ANTHROPIC_API_KEY` in the environment is seen by Claude Code, as before.

**The other sections:** **Lesson defaults** (length, quality, voice, review, frames review: what the form starts with), **Claude (MCP)** (see below), **Costs** (this month's total, a cap per lesson, default $15, and a monthly cap; rates), **Connect Claude** and **Storage**.

**Caps and rates.** A lesson that reaches its cap stops and keeps what it wrote; raise the cap and press **Retry** and it continues, counting what it already spent. Anthropic's rates ship with the app, dated; add others in **Costs** as dollars per million tokens. Without a rate, a provider's cost shows as unknown and the caps cannot count it. Claude Code reports what the API would charge; on a Pro or Max plan the caps still count that figure.

**Which value wins:** the environment, then `.env`, then Settings, then the built-in default. A value fixed by the environment shows **Set in .env** and cannot be changed in the page. Settings live in the `settings` table of `data/studio.db`; every change is kept with when and who made it (you, or Claude through MCP), and **Undo** puts it back.

**A writer bake-off.** `npm run bakeoff` makes the same short lessons with each set-up provider (or `--writers claude-code,ollama:qwen3-coder:30b`, `--topics topics.json`), stopping at the storyboard so nothing is rendered. It asks before spending on paid providers (`--yes` skips the question), then reports how often each writer's lessons passed the check, the fix rounds, time and cost, and writes `data/bakeoff/<time>.html` with the storyboards side by side. ManimGL is a niche library and most models learned the other Manim, so expect other writers to fail the check more often; measure before switching.

## Make lessons from Claude: the MCP connector

Claude Code and the Claude desktop app can make lessons from a conversation: "make a 3-minute lesson on what we just derived, using my notation from notes/softmax.jpg". **Settings → Connect Claude** shows these with your real paths:

```bash
# Claude Code, while the dashboard runs
claude mcp add --transport http narrated-proofs http://localhost:8787/mcp
# or started by Claude Code itself
claude mcp add narrated-proofs -- node /path/to/tts-studio/mcp/stdio.js
```

For the desktop app, add the entry Settings shows to `~/Library/Application Support/Claude/claude_desktop_config.json`, or run `npm run mcp:pack` and open `dist/narrated-proofs.mcpb`. The connector talks to the running dashboard (`NARRATED_PROOFS_URL`, default `http://127.0.0.1:8787`); with `TTS_MCP_AUTOSTART=1` the stdio connector starts the dashboard when it is not running. claude.ai in a browser is not supported: it would need this Mac reachable from the internet.

| Tool | Does |
| --- | --- |
| `make_lesson` | Start a lesson: topic, goal, notes, file paths (with PDF pages or text only), length, quality, voice, title, tags, review, and optionally a set-up writer. Returns at once with its id, link and estimated cost |
| `wait_for_lesson` | Waits up to 50 seconds and returns as soon as the lesson's stage changes, with progress notifications while it waits. Claude calls it again until the lesson is done |
| `lesson_status`, `search_lessons`, `get_lesson` | Where a lesson is; the library's search; its brief, script and scenes, and up to 12 storyboard stills as images |
| `get_video` | The MP4's path, its captions and poster, its length and link, with the poster as an image |
| `cancel_lesson`, `retry_lesson`, `list_voices` | As the buttons do; the English voices |
| `get_settings`, `update_settings`, `test_writer` | Settings as Claude may see and change them (never keys); a provider's Test |

It also offers each lesson's script, scenes and captions as resources (`lesson://<id>/script`), and a prompt, `/mcp__narrated-proofs__explain`, that turns the conversation into a lesson.

Files are read by path: images, PDFs, Word, RTF and text files only, within the page's limits, and never from the folders where keys and logins are kept (`~/.ssh`, `~/.aws`, `~/.config`, keychains and the rest of the list in `../video/sandbox.py`, links followed). Lessons Claude starts use **Settings → Claude (MCP)**: the page's writer, or one of their own, and their own defaults. What Claude may change from a conversation is set there too. By default it may choose among providers you have already set up for its own lessons, change effort and its defaults, and lower a spending cap. It can never add a provider, change an address, see or set a key, raise a cap, or change what it is allowed: a conversation that read a hostile web page could otherwise be talked into sending your notes somewhere new. Every change Claude makes shows in Settings with an **Undo**. The HTTP connector is behind the same Host and Origin checks as the rest of the dashboard.

## Where things are stored

Everything lives in `data/` inside the project (override with `TTS_DATA_DIR`):

```
data/
  studio.db        SQLite database: scripts, status, the full-text index, Settings and their history
  secrets.json     provider keys, off macOS or with TTS_KEYCHAIN=0 (readable only by you)
  bakeoff/         reports from npm run bakeoff
  audio/<id>.mp3   one MP3 per finished generation
  video/<id>.*     each finished video: .mp4, captions as .srt and .vtt, and a .jpg still for its card
  video/<id>/v<n>.*  a lesson's earlier versions, the last three renders kept (TTS_KEEP_RENDERS)
  previews/        cached voice samples
```

Back it up by copying that folder. Deleting an item in the UI removes its database row, its search entry and its MP3 or video files.

A lesson also has a project folder in `../video/projects/`, holding the script, the scenes, your notes and any photos or PDFs you attached. Deleting a lesson asks a second question: whether to delete that folder too. Say no and it stays, so you can rebuild from it. Projects you wrote by hand, such as `demo`, are never deleted from the dashboard. From the command line it is `DELETE /api/generations/:id?project=1`.

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
| `TTS_CLAUDE_MODEL` | Claude Code's default | Model Claude Code writes lessons with, such as `opus` or `sonnet`. Fixes the model chosen in Settings |
| `TTS_CLAUDE_EFFORT` | `high` | Effort for writing a lesson: `low`, `medium`, `high`, `xhigh`, `max`, or `auto` for Claude Code's default |
| `TTS_CLAUDE_FIX_EFFORT` | `low` | Effort for fixing failing scenes |
| `TTS_CLAUDE_POLISH_EFFORT` | `medium` | Effort for the round on timing and layout |
| `TTS_CLAUDE_READ_EFFORT` | `medium` | Effort for writing out attached notes, when another writer reads them |
| `TTS_CLAUDE_OUTLINE_EFFORT` | `medium` | Effort for outlines of long lessons |
| `TTS_AUTHOR_MAX_COST_USD` | Settings ($15) | What one lesson may cost before it stops |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY` | none | Provider keys; they win over keys saved in Settings |
| `TTS_KEYCHAIN` | `1` | `0` keeps keys in `data/secrets.json` instead of the macOS Keychain |
| `NARRATED_PROOFS_URL` | `http://127.0.0.1:8787` | Where the stdio MCP connector and the bake-off find the dashboard |
| `TTS_MCP_AUTOSTART` | `0` | `1` lets the stdio connector start the dashboard when it is not running |
| `TTS_CLAUDE_TIMEOUT_MIN` | `20` | Minutes one request to Claude may take |
| `TTS_AUTHOR_FIXES` | `3` | How many times Claude may be asked to fix failing scenes |
| `TTS_AUTHOR_POLISH` | `1` | `0` skips the extra round for timing and layout warnings |
| `TTS_AUTHOR_VISUAL_REVIEW` | `0` | `1` shows Claude the storyboard's stills in that round for every lesson; the lesson form can ask for it per lesson |
| `TTS_AUTHOR_PARALLEL` | `2` | Lessons the writer works on at once. Their checks still take turns |
| `TTS_LESSON_REVIEW` | `render` | `storyboard` makes new lessons sent without a choice (from `curl`, say) wait at their storyboard |
| `TTS_NOTES_IMAGE_EDGE` | `1400` | Pixels on the long side of an attached photo |
| `TTS_KEEP_RENDERS` | `3` | Videos kept per lesson, the current one included |
| `AUTHOR_PORT` | `8790` | Port for the lesson writer |
| `TTS_AUTHOR_URL` | none | Use a lesson writer running elsewhere and do not start one |
| `TTS_VIDEO_DIR` | `../video` | The folder holding `build.py`, `check.py` and `projects/` |
| `TTS_VIDEO_BUILD` | `python3 ../video/build.py` | Another executable to build a video with |
| `TTS_AUTHOR_CHECK` | `python3 ../video/check.py` | Another executable to check a lesson with |
| `TTS_AUTHOR_AUTOFIX` | `python3 ../video/autofix.py` | Another executable to fix common mistakes with |

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

They show up in the library like anything dropped in the UI. To attach files, add `attachments: [{ name, data, pages, asText }]` with each file's bytes in base64. `writer: { provider, model }` picks a set-up provider for that lesson.

Other useful routes:

| Route | What it gives |
| --- | --- |
| `GET /api/generations?q=search+terms&kind=video` | The library. `kind` is `audio` or `video`; `status`, `voiceId`, `tag`, `favorite`, `sort`, `limit` and `offset` also filter |
| `GET /api/generations/:id/audio` | The MP3 |
| `GET /api/generations/:id/video`, `/poster`, `/captions.srt`, `/captions.vtt` | A video, its still and its captions |
| `GET /api/generations/:id/notes/:file` | An image or PDF attached to a lesson |
| `POST /api/videos` | Build a project in `../video/projects/`: `{ project, quality }` |
| `POST /api/generations/:id/retry`, `/cancel` | Retry a failed or cancelled item, or stop a running one. Cancelling a lesson that waits at its storyboard means "don't render" |
| `POST /api/generations/:id/approve` | Render a lesson waiting at its storyboard: `{ quality }` is optional |
| `GET /api/generations/:id/storyboard` | The storyboard: per scene and block, the narration, marks, stills and problems. `?version=n` for an earlier version's |
| `GET /api/generations/:id/storyboard/:file`, `/narration/:block` | A still the storyboard lists, and a block's narration as a WAV |
| `GET /api/generations/:id/versions` | A lesson's versions: what made each, what it cost, whether it was built |
| `GET /api/events` | Every change to the library as it happens, as Server-Sent Events |
| `GET /api/generations/:id/source`, `/files` | A lesson's brief, script and scenes; where its video, captions, poster and project are on disk |
| `GET /api/settings`, `PATCH /api/settings`, `POST /api/settings/undo` | Settings (never keys), a change as `{ "lesson.defaults": { "quality": "medium" } }`, and Undo |
| `PUT /api/providers/:id`, `PUT /api/providers/:id/key`, `POST /api/providers/:id/test` | A provider's address (`new` adds one), its key (write-only), and its Test |
| `POST /api/estimate` | About what a lesson will cost: `{ minutes, notesChars, images, pdfPages, writer }` |
| `POST /mcp` | The MCP connector over Streamable HTTP |
| `GET /api/video/projects`, `/api/voices`, `/api/stats`, `/api/health` | Projects, voices, counts, and the engine's state |

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
  lessons.js      follows a lesson through the lesson writer, then queues its build or waits at its storyboard
  versions.js     a lesson's versions: snapshots of its files and storyboard, and its kept renders
  notes.js        saves the images, PDFs and documents attached to a lesson
  video.js        runs video/build.py, and makes a poster for a video that has none
  local.js        refuses requests that do not come from this machine's own pages
  settings.js     Settings: values, history and Undo, providers, what Claude may change, each step's writer
  settings-routes.js  the Settings page's routes
  secrets.js      provider keys in the Keychain or a private file
  estimate.js     about what a lesson will cost before it is written
  pdf.js          PDF page counts, text and page selection
shared/
  limits.js       what a lesson may be given; imported by the server and the page
  providers.js    the kinds of provider, what each can do until tested, the default writer plan
  rates.js        what API providers charge, dated, and the cost of a request
author/
  index.js        the lesson writer on its own (npm run author)
  app.js          its HTTP API: POST /lessons, GET /lessons/:id, POST /lessons/:id/cancel
  pipeline.js     write, check, fix, polish
  claude.js       runs `claude -p` and reads its answer
  writers/        one interface over every provider: anthropic.js, openai.js (any OpenAI-compatible
                  address), ollama.js, the plan each job carries (plan.js), and the Test (probe.js)
  prompts.js      fills the templates in prompts/
  prompts/        the prompt templates and the worked example
  test/           tests with a fake claude, a fake check and fake providers
mcp/
  server.js       the MCP tools, resources and prompt, over the dashboard's API
  stdio.js        the connector for the desktop app and Claude Code (npm run mcp)
  http.js         the connector at /mcp, inside the dashboard
  files.js        which files a lesson may be given by path
  test/           an MCP client against the dashboard with the fake writer
client/
  src/App.jsx     state, polling, drag and drop, the Lessons and Audio tabs
  src/components/ Header, LessonPanel, Composer, VideoPanel, Library, Drawer, Toasts,
                  Workspace (a lesson, full width), Storyboard and Settings
  src/**/*.test.* vitest tests
scripts/
  setup.sh        creates .venv and downloads the model
  bakeoff.js      the writer bake-off (npm run bakeoff)
  mcp-pack.js     the desktop extension (npm run mcp:pack)
```

## Troubleshooting

- **"Voice engine offline" in the header.** The red banner says why. Usually `npm run setup` hasn't been run, or was interrupted; run it again. The page reconnects by itself.
- **"Loading voice model…" for a long time.** The first start after a reboot takes 5 to 10 seconds. Longer than a minute means the worker is stuck; restart the server and look at its terminal output.
- **A Japanese voice is greyed out.** Run `npm run setup:japanese`.
- **A word is mispronounced (English voices only).** Write it as a link whose target is its phonemes between slashes, for example `[Kokoro](/kˈOkəɹO/)`. These hints are kept even when markdown is stripped.
- **`npm install` fails on `better-sqlite3`.** It normally installs a prebuilt binary. If your Node version has none, install Xcode command line tools (`xcode-select --install`) so it can compile, or switch to an LTS Node.
- **Port already in use.** Set `PORT=8788` in your `.env`.
- **"This server only answers on localhost."** Open the dashboard as `http://localhost:8787` or `http://127.0.0.1:8787`, not through another hostname or a tunnel.
- **"… has no key" or "has not passed its Test" when making a lesson.** The writer chosen for that step is not set up. Add its key or run its Test in Settings → Lesson writer, or choose another writer.
- **A provider's Test fails with "Could not reach".** For a model on this Mac, start Ollama or the server first and check the address in Settings.
- **Claude says the dashboard is not running.** The MCP connector needs `npm start` (or `npm run app`) running, or `TTS_MCP_AUTOSTART=1`.
- **A lesson's scene fails with "Operation not permitted" or a network error.** The scene tried to reach outside its sandbox. Lessons should never need to.
