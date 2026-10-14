# Narrated Proofs: the dashboard

A local dashboard with two tabs. **Lessons** turns a topic and your notes into a narrated, animated explainer video. **Audio** turns a `.txt` or `.md` script into an MP3. Everything you make goes into a searchable library. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), which runs on your machine: no API key, no quota, works offline. It has 54 voices in American and British English, Spanish, French, Hindi, Italian, Brazilian Portuguese and Mandarin, plus Japanese as an extra.

## Run it

`../install.sh` installs everything (see the [main README](../README.md#install-macos)). Then:

```bash
npm start          # http://localhost:8787
```

The dashboard runs while its terminal is open; Ctrl-C stops it. A job running at that moment is marked "Interrupted by a server restart"; press **Retry** on its card and it carries on from the files already written. For hot reload, run `npm run dev` and open <http://localhost:5173>.

| Command | What it does |
| --- | --- |
| `npm start` | Start the server using the last build |
| `npm run app` | Build the page, then start |
| `npm run dev` | Server with auto-restart, plus Vite on port 5173 |
| `npm run setup` / `setup:japanese` | Run `../install.sh` (optionally with Japanese voices) |
| `npm run mcp`, `mcp:pack` | The MCP connector over stdio; a desktop extension, `extension/narrated-proofs.mcpb` |
| `npm run bakeoff` | Compare lesson writers on the same lessons |
| `npm test`, `npm run lint` | Server, writer, MCP, page, engine and `../video` tests; ESLint |

## Audio

Switch to **Audio** in the header.

1. Drop files anywhere on the page, or click the drop zone. They are generated one at a time. Turn off **Generate immediately on drop** to review a batch first.
2. Pick a **voice** and speed. **Preview** plays a sample.
3. Click a card to see the player and script. Search matches word prefixes and stems (`simmering` finds `simmer`). Add tags and favorites to filter.

Good to know:

- **Duplicates are caught.** Same text, voice and settings is not generated twice; you can open the old one or generate again.
- **Long scripts** are split at paragraph, line and sentence boundaries, with a pause between sentences, and encoded once (24 kHz mono MP3). Expect 10 to 25 times faster than real time on Apple Silicon.
- **One voice, one language.** Match the voice to the script. To fix a mispronounced English word, write it as `[Kokoro](/kˈOkəɹO/)`.
- **Markdown is stripped** before speaking (you can turn that off).
- **Cancel works mid-job** and restarts the voice engine. If the engine crashes mid-job, the job is retried once.

## Lessons: a video from a topic

Built for mathematics: derivations, proofs, the maths behind machine learning.

1. Type a **topic** and what you want to understand.
2. Add **notes**: type or paste, drop files anywhere, or paste a screenshot. With them, the video uses your notation and examples.
3. Pick a length (1 to 30 minutes), a quality and an English voice. Under **Before it renders**, choose **Render right away**, **Show me the storyboard**, or **Show me the narration first**. Press **Make the video**.

The card shows each stage. Click it for the lesson's workspace, which has these tabs (each with its own address, such as `#lesson/<id>/watch`):

- **Watch:** the video with captions and a transcript that highlights each word (click one to jump). Below it is what writing took: who wrote each step, the cost, the tokens and the fixes made.
- **Storyboard:** every block, scene by scene, with a still at each marked word and at the end, the narration, any problems, and a button to hear it. **Play as animatic** plays the narration and changes the picture on the marked words. Stills come from the check, which skips animations, so they show where things end up.
- **Edit:** `script.txt` and `scenes.py` in a code editor. **⌘S** saves and runs a quick check; **Check** runs the full one; **Render v2** checks, then builds the next version while the old video keeps playing. **Discard** goes back to the current version. Saves from stale files are refused with a choice of theirs or yours. Hand-written projects are read-only.
- **History:** every version, what made it, its cost and whether it built. Compare any two (narration by block, scenes as a diff) and **Restore** one.
- **Notes:** what you asked for, your files and the narration.
- **Outline:** for lessons in chapters.

**Ask for a change** sits under every tab: "slow down the second scene". Narrow it to a scene, a block, or the paused moment, attach notes, and tick **Show me the storyboard first** if you want. The writer answers with only what changes, which `../video/splice.py` applies, so unchanged narration is reused and unchanged scenes aren't re-rendered. A failed or cancelled revision leaves the lesson as it was. Each request carries the last three, so "undo that" makes sense.

**Narration first.** Stops after the narration is written. Read or edit it, then **Approve the narration** and the scenes follow, so you pay for animation code only once the direction is right.

**Long lessons, in chapters.** From 10 minutes, the writer first makes an **outline**: the thread of the lesson, the notation every chapter shares (each symbol with a meaning and one colour), and 1 to 8 minutes per chapter (up to `TTS_MAX_CHAPTERS`, 8). By default it waits at the **Outline** tab: rename, resize, reorder, add or remove chapters, then **Write the N chapters**, or ask for it again. Each chapter is a full project in `chapters/<id>/`, written to pick up where the last one stopped, while the next is already being written. The build joins them with chapter markers, captions, a transcript and optional title cards. A long lesson costs more per minute, since every chapter reads the guide again; the form shows the estimate.

**Looking over frames.** **Let the writer look over its own frames** sends the storyboard's stills in one more request, to catch what the checks can't measure, such as a shape over a label. Its changes are kept only if they break nothing.

A lesson waiting for you says **Storyboard ready** on its card, and the header counts them. **Approve and render** builds it at the quality you choose; **Don't render** cancels it.

### Notes

| File | What happens |
| --- | --- |
| `.txt`, `.md` | Added to the notes box |
| Images (PNG, JPEG, WebP, GIF, HEIC, TIFF, BMP) | Shown to the writer, re-encoded as JPEG of at most 1400 px (`TTS_NOTES_IMAGE_EDGE`), which also drops location and camera data |
| PDF | Shown whole. Type pages (`1-3, 7`) to send only those, or tick **text only**: cheaper and readable by any model, but figures and handwriting are lost |
| `.docx`, `.doc`, `.rtf`, `.odt` | Turned into text |

Limits: 12 files, 20 MB, 60,000 characters of text. On macOS, conversion uses `sips`, `textutil` and PDFKit; elsewhere libvips, pandoc, catdoc and poppler.

### Stages on a card

| Stage | What is happening |
| --- | --- |
| Reading the notes | Another model than the writer reads pictures and PDFs and writes them out as text |
| Writing the lesson | The writer writes the narration and animation code |
| Checking the scenes | The narration is spoken and each scene runs once without drawing |
| Waiting for another lesson | Two lessons can be written at once, but checks take turns |
| Checking the automatic fixes | A common mistake was fixed without the writer; checking again |
| Fixing the scenes (1 of 3) | A scene failed; the writer sees the error and rewrites |
| Handing the fixes back | A cheaper fixer failed as often as Settings allow, so the main writer takes over |
| Polishing timing and layout / Looking over the frames | One go at overlaps and late animations, with or without stills |
| Storyboard / Narration / Outline ready | Waiting for you |
| Writing chapter 2 of 4 | Each chapter is written, checked, fixed and polished |
| Revising | The writer is making a change you asked for |
| Building 2/5 | Rendering and joining; unchanged scenes are reused |

### Cost and what's on disk

A lesson needs a writer (by default [Claude Code](https://claude.com/claude-code), installed and signed in) and `../video` set up. The form shows who writes it and about what it costs, and the header shows this month's total. Cost is kept down by asking each step with its own effort (writing `high`, fixes `low`, polish `medium`; see [Configuration](#configuration)), fixing common mistakes with `../video/autofix.py` first, having fixes and revisions answer with only what changes, showing the polish only the scenes it needs, and a small tested kit of layouts for scenes (`../video/runtime/kit.py`).

Every lesson is a normal project in `../video/projects/<topic>-<id>/`: `script.txt`, `scenes.py`, `brief.json`, your files in `notes/`, every prompt, answer and cost in `build/author/`, the storyboard and report in `build/check/`, and each version in `versions/NNN/`. Edit it here, or in your own editor and render from the Edit tab, or run `python3 ../video/build.py <name>`.

### How the writer works

The lesson writer in `author/` runs inside the dashboard's process as a job queue. It gives the model no tools, so it can only send text back, and `../video/check.py` checks that text before anything is built. The prompts are plain files you can edit without restarting:

| File | What it is |
| --- | --- |
| `author/prompts/guide.md` | System prompt: how to plan a lesson, the formats, the ManimGL reference |
| `lesson.md`, `repair.md`, `revise.md` | The request; the follow-up on check problems; a requested change |
| `edit-format.md` | How fixes, polish and revisions answer: only what changes |
| `read.md`, `scenes.md` | Writing out notes for another writer; scenes for an approved narration |
| `outline.md`, `chapter.md` | A long lesson's outline and chapters |
| `example/` | The worked example shown to the model; `npm test` checks it still passes |

### Good to know

- **Scenes are confined.** The check refuses imports beyond manim, numpy and a few standard modules, and names such as `open`, `eval`, `os` and `sys`. On macOS every scene also runs in a sandbox with no network and no access to your keys. See [`../video/README.md`](../video/README.md#the-sandbox).
- Lessons need an English voice, since only English voices report word timings.
- If the scenes won't run after three fixes, the card fails with the last error. **Retry** carries on from the files already written.
- Cancel works at every stage.
- Pictures and PDFs go with the first request only; fixes see just the script and scenes.
- A provider's rate limit is retried after the time it asks for; a daily limit fails with a message naming it.
- Each version is kept with its storyboard, and the renders of the last three are kept in `data/video/<id>/`.

## Profiles: sharing one install

The avatar in the header opens **Switch profile**, **Manage profile** and **Sign out**. With more than one profile, or a PIN, the page opens on **Who's watching?** (`#who`); with one profile and no PIN there is no gate. The user-facing description, and what a PIN is and is not, is in the [main README](../README.md#sharing-with-housemates). For developers:

- **Sessions.** Choosing a profile (and its PIN) sets an opaque 256-bit cookie, `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS. Only its hash is stored (`sessions`). One active profile per browser; devices are independent. A locked profile's session ends after 7 days unused, on switching, and whenever its PIN is changed (other sessions only).
- **PINs.** Exactly 4 digits, kept as `scrypt(HMAC(pepper, pin), salt)`; the pepper is `data/pin-pepper`, mode 0600. Compared in constant time. Five wrong tries lock the profile for 30 s, doubling to 15 min, and a locked profile refuses even the right PIN; a device is also limited across profiles. A wrong PIN says nothing else.
- **Ownership.** Every lesson has a `profile_id`. Every list, search, tag, stat and event is scoped to the signed-in profile; any `:id` route for someone else's lesson answers 404, the same as a missing one. `server/test/profiles.test.js` walks every route in the router against another profile's lesson id and fails on any route that is not classified, so a new route cannot skip the check. Spending is counted per profile, and a deleted lesson's cost stays in a ledger. Each request is marked as paid by the host when it used Claude Code or an environment key (`usage.hostFunded`); a version keeps that share as `host_usd`, and the Owner's per-profile monthly limit (`hostCapUsd`) is checked when a lesson starts and held inside the running job (`job.hostCapUsd`), so it cannot run past it. A lesson's cap and the monthly cap are reserved while it runs, so lessons started together share what is left; spend no version holds yet (a waiting outline or narration, a failed, cancelled or interrupted attempt, a deleted lesson) is kept on the lesson or in the ledger and counted once. Provider requests go through `author/writers/net.js`: addresses that lead to link-local or cloud-metadata addresses are refused, whatever the name, and redirects are not followed.
- **Settings and keys** are per profile (`settings.for(profileId)`); undo only touches your own history. A key is kept as `p-<profile>-<provider>`; the profile's own key comes first, then the host's environment key only if the Owner allowed it. The Claude Code sign-in is refused for every step unless allowed: at the start check, in the provider Test and again inside the writer, which fails closed.
- **Migration** runs on start and is safe to repeat: rows without an owner, old settings and history, and old keys (kept under the provider's name) go to the Owner.
- **The host command**: `npm run profiles -- list` and `npm run profiles -- reset-pin <name>`.

## Settings: who writes your lessons

The gear in the header opens **Settings** (`#settings`), which are yours: each profile has its own writer, defaults, caps, providers and keys. The Owner also sees **House**: how many profiles there are against the limit, and whether the dashboard is on the network.

| Provider | Connects through | Pictures | PDFs | Cost shown |
| --- | --- | --- | --- | --- |
| Claude Code (default) | `claude -p` and your sign-in | Yes | Yes | Claude Code's figure |
| Claude API | Your key | Yes | Yes | From token counts |
| OpenAI | Your key | Yes | Yes | From token counts, once you add a rate |
| Groq | Your key | Some models | No (text only) | From token counts, once you add a rate |
| This Mac: Ollama | Ollama's API | Vision models | No | Free |
| This Mac: OpenAI-compatible (LM Studio, llama.cpp, MLX, vLLM) | Its address | Vision models | No | Free |
| Other (OpenRouter, Together, your own server) | Its address and key | | | Your rates |

- **Test** checks a provider with a tiny request: the key, its models, and for your chosen model whether it gives structured answers, sees pictures, reads PDFs, takes an effort setting, its context length and its speed.
- **One for all, or per step.** Reading notes, writing, fixing and polishing, and outlines can each have their own provider, model and effort. A lesson's **Written by** list can pick another for one lesson.
- **Hand-back.** If a cheaper fixer fails a set number of times, the main writer takes over.
- **Reading notes.** When the reader and writer differ, the reader writes out pictures and PDFs as text first (`notes/transcribed.md`). A scanned PDF, or a picture for a model that can't see, is refused with what to change.
- **Where your notes go** is listed under each step. With every step on this Mac, nothing leaves it.

**Keys** are entered once and never shown again. On macOS they are in the Keychain under "Narrated Proofs"; elsewhere, or with `TTS_KEYCHAIN=0`, in `data/secrets.json`, readable only by you. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GROQ_API_KEY` in the environment or `.env` win. Keys never reach logs, projects, prompts, scenes, or `claude -p`.

**Other sections:** Lesson defaults, Claude (MCP), Costs, Connect Claude, Storage.

**Caps and rates.** A lesson at its cap ($15 by default; there is a monthly cap too) stops and keeps what it wrote; raise the cap and **Retry**. Anthropic's rates ship with the app; add others in **Costs** as dollars per million tokens, or their cost is unknown and caps can't count it.

**Which value wins:** the environment, then `.env`, then Settings, then the default. A value set by the environment shows **Set in .env**. Every Settings change is kept with when and who made it (you, or Claude through MCP), and **Undo** reverts it.

**A writer bake-off.** `npm run bakeoff` makes the same short lessons with each writer (`--writers claude-code,ollama:qwen3-coder:30b`, `--topics topics.json`), stops at the storyboard so nothing renders, asks before spending (`--yes` skips), and writes `data/bakeoff/<time>.html` comparing pass rates, fix rounds, time and cost.

## Make lessons from Claude: the MCP connector

Claude Code and the desktop app can make lessons from a conversation: "make a 3-minute lesson on what we just derived, using my notation from notes/softmax.jpg". **Settings → Connect Claude** shows these with your real paths:

```bash
claude mcp add --transport http narrated-proofs http://localhost:8787/mcp   # while the dashboard runs
claude mcp add narrated-proofs -- node /path/to/tts-studio/mcp/stdio.js    # started by Claude Code
```

**With more than one profile**, Claude must be connected to one of them with a token: **Settings → Connect Claude → Make a token**, shown once, stored hashed, up to 10 per profile, revocable. It goes in an `Authorization: Bearer <token>` header (HTTP) or `NARRATED_PROOFS_TOKEN` (stdio, or `"env"` in the desktop entry below). Anything that arrives with a token acts as that profile and as Claude, with Claude's limits. It is held to an explicit list of routes, the ones the tools above use (`connectorAllows` in `server/profile-routes.js`; a test fails if the list changes without it being updated): it cannot delete a lesson, edit its files, build, change a key or provider, open the event stream, or manage profiles or tokens. A wrong, blank or revoked token is refused with a single profile too. Tokens are revoked when someone else resets the profile's PIN, when its first PIN is set, and when it is deleted, and one unused for 90 days stops working. `npm run mcp:pack` writes a 0.3 manifest whose `user_config` asks for the token on install and passes it as `NARRATED_PROOFS_TOKEN`.

For the desktop app, add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (use the full path of `node` and of your clone), then restart it. Or run `npm run mcp:pack` and open `extension/narrated-proofs.mcpb`.

```json
{
  "mcpServers": {
    "narrated-proofs": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/tts-dir/tts-studio/mcp/stdio.js"],
      "env": { "TTS_MCP_AUTOSTART": "1" }
    }
  }
}
```

The connector talks to the running dashboard (`NARRATED_PROOFS_URL`); with `TTS_MCP_AUTOSTART=1` it starts it if needed. Check with `claude mcp list`. claude.ai in a browser isn't supported.

| Tool | Does |
| --- | --- |
| `make_lesson` | Start a lesson (topic, goal, notes, files, length, quality, voice, review, outline options, writer). Returns at once with an id, link and estimated cost |
| `revise_lesson`, `redo_outline` | Ask for a change, narrowed to a scene, block, time or chapter; have an outline rewritten |
| `approve_lesson` | Continue a lesson waiting on its storyboard, narration or outline |
| `wait_for_lesson` | Waits up to 50 seconds for a stage change; Claude calls it until done |
| `lesson_status`, `search_lessons`, `get_lesson`, `get_video` | Progress, search, the brief, script, scenes and stills, and the finished MP4's path, captions and poster |
| `cancel_lesson`, `retry_lesson`, `list_voices` | As the buttons do |
| `get_settings`, `update_settings`, `test_writer` | Settings as Claude may see and change them (never keys); a provider's Test |

It also offers each lesson's script, scenes and captions as resources (`lesson://<id>/script`) and a prompt, `/mcp__narrated-proofs__explain`.

Files are read by path: images, PDFs, Word, RTF and text only, within the page's limits, and never from `~/.ssh`, `~/.aws`, `~/.config`, keychains or the rest of the list in `../video/sandbox.py`. Lessons Claude starts use **Settings → Claude (MCP)**. By default Claude may choose among providers you set up, change effort and its defaults, and lower a spending cap. It can never add a provider, change an address, see or set a key, raise a cap, or change what it may do, so a conversation that read a hostile web page can't send your notes somewhere new. Every change shows in Settings with **Undo**. The HTTP connector has the same Host and Origin checks as the rest of the dashboard.

## Where things are stored

In `data/` (override with `TTS_DATA_DIR`); back it up by copying the folder:

```
data/
  studio.db        scripts, status, search index, profiles, Settings and their history
  pin-pepper       the secret PINs are hashed with (keep it private; mode 0600)
  secrets.json     provider keys per profile, off macOS or with TTS_KEYCHAIN=0
  audio/<id>.mp3
  video/<id>.*     the .mp4, .srt, .vtt and a .jpg still; earlier renders in video/<id>/v<n>.*
  previews/        cached voice samples
  bakeoff/         bake-off reports
```

Deleting an item removes its row, search entry and files. Deleting a lesson also asks whether to delete its project folder in `../video/projects/`; say no to keep it and rebuild later. Hand-written projects such as `demo` are never deleted from the dashboard.

## Configuration

All optional. Put them in `.env` here or one folder up, or in the environment. Copy [.env.example](.env.example) for the full list with comments.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Port for `npm start` |
| `TTS_LAN` | `0` | `1` serves the dashboard on your network too (phone, other computer), at the address printed on start. Profiles keep housemates' libraries apart, but a LAN is plain HTTP and a PIN is not strong security, so use a network you trust |
| `TTS_MAX_PROFILES` | `5` | People who can share this install, each with their own library, settings and keys (1 to 20) |
| `TTS_HOST` | `127.0.0.1` | Address to listen on. Docker sets `0.0.0.0` and publishes the port on `127.0.0.1` only |
| `TTS_DATA_DIR` | `./data` | Library location |
| `TTS_VOICE` | `af_heart` | Voice preselected on first run |
| `TTS_DEVICE` | `auto` | `auto` uses the Apple GPU if there is one; `cpu` if you hear glitches |
| `TTS_PYTHON` | `../.venv/bin/python` | A Python with `kokoro` |
| `TTS_CLAUDE_BIN` | `claude` | The Claude Code command |
| `TTS_CLAUDE_MODEL` | Claude Code's default | Such as `opus` or `sonnet` |
| `TTS_CLAUDE_EFFORT` | `high` | Writing a lesson: `low`, `medium`, `high`, `xhigh`, `max` or `auto` |
| `TTS_CLAUDE_FIX_EFFORT` | `low` | Fixing failing scenes |
| `TTS_CLAUDE_POLISH_EFFORT` | `medium` | The timing and layout round |
| `TTS_CLAUDE_READ_EFFORT`, `_OUTLINE_EFFORT` | `medium` | Reading notes; outlines |
| `TTS_CLAUDE_TIMEOUT_MIN` | `20` | Minutes one request may take |
| `TTS_AUTHOR_MAX_COST_USD` | Settings ($15) | Cost at which a lesson stops |
| `TTS_AUTHOR_FIXES` | `3` | Fix rounds |
| `TTS_AUTHOR_POLISH` | `1` | `0` skips the polish round |
| `TTS_AUTHOR_VISUAL_REVIEW` | `0` | `1` shows stills in the polish round for every lesson |
| `TTS_AUTHOR_PARALLEL` | `2` | Lessons written at once; checks take turns |
| `TTS_MAX_CHAPTERS` | `8` | Most chapters (up to 12) |
| `TTS_LESSON_REVIEW` | `render` | `storyboard` makes lessons sent without a choice wait at it |
| `TTS_NOTES_IMAGE_EDGE` | `1400` | Long side of an attached photo, in pixels |
| `TTS_KEEP_RENDERS` | `3` | Videos kept per lesson |
| `TTS_KEYCHAIN` | `1` | `0` keeps keys in `data/secrets.json` |
| `NARRATED_PROOFS_URL` | `http://127.0.0.1:8787` | Where the stdio connector and bake-off find the dashboard |
| `TTS_MCP_AUTOSTART` | `0` | `1` lets the stdio connector start the dashboard |
| `TTS_VIDEO_DIR`, `TTS_VIDEO_BUILD`, `TTS_AUTHOR_CHECK`, `TTS_AUTHOR_AUTOFIX` | `../video` and its scripts | Use other folders or executables |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY` | none | Provider keys; win over saved keys |

## From the terminal

```bash
python3 ../tts.py script.md                                  # writes script.mp3
python3 ../tts.py script.md -o out.wav --voice bm_george --speed 1.1
python3 ../tts.py script.md -o out.wav --timings out.json    # plus word times (English)
python3 ../tts.py --list-voices
```

The dashboard has a JSON API, so you can push scripts and lessons from the command line. With more than one profile, add `-H "Authorization: Bearer <connector token>"`: the request then acts as that profile, with Claude's limits.

For example:

```bash
curl -s localhost:8787/api/generations -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile t script.txt '{title:"My script", text:$t, voiceId:"af_heart"}')"

curl -s localhost:8787/api/lessons -H 'Content-Type: application/json' \
  -d "$(jq -n --rawfile n notes.md '{topic:"Gradient of logistic regression", notes:$n, minutes:2, quality:"low"}')"
```

For attachments add `attachments: [{ name, data, pages, asText }]` with base64 data; `writer: { provider, model }` picks a provider for one lesson.

| Route | What it gives |
| --- | --- |
| `GET /api/generations?q=…&kind=video` | The library; also `status`, `voiceId`, `tag`, `favorite`, `sort`, `limit`, `offset` |
| `GET /api/generations/:id/audio`, `/video`, `/poster`, `/captions.srt`, `/captions.vtt` | Files |
| `POST /api/videos` | Build a project: `{ project, quality }` |
| `POST /api/generations/:id/retry`, `/cancel` | Retry or stop. Cancelling a lesson at its storyboard means "don't render" |
| `POST /api/generations/:id/approve` | `{ action: "render", quality }`, `{ action: "scenes" }` or `{ action: "chapters", outline }` |
| `GET`/`PUT /api/generations/:id/outline`, `POST …/outline/redo` | A long lesson's outline |
| `POST /api/generations/:id/revise` | `{ request, scope, attachments, review, chapter }`; `scope` is `{ kind: "lesson" }`, `{ kind: "scene", name }`, `{ kind: "block", id }` or `{ kind: "time", at }` |
| `GET /api/generations/:id/storyboard`, `/versions`, `/files` | Storyboard (`?version=n`, `?chapter=<id>`), versions, file locations |
| `GET`/`PUT /api/generations/:id/source` | The working copy and its hash; save `{ base, script, scenes, voice, speed }` with a quick check (409 if stale or busy). Also takes `?chapter=<id>` |
| `POST /api/generations/:id/check`, `/build`, `/discard`, `/restore` | Full check; check and render the next version; back to current; restore `{ version }` |
| `GET /api/events` | Every library change, as Server-Sent Events |
| `GET`/`PATCH /api/settings`, `POST /api/settings/undo` | Settings (never keys) |
| `PUT /api/providers/:id`, `…/key`, `POST …/test` | A provider's address, key (write-only) and Test |
| `POST /api/estimate` | About what a lesson will cost |
| `POST /mcp` | The MCP connector |
| `GET /api/video/projects`, `/api/voices`, `/api/stats`, `/api/health` | Projects, voices, counts, engine state |

## Project layout

```
engine/    the Kokoro engine: command line tool and the worker the server runs
server/    REST API, SQLite and search, job queue, notes, settings and keys, video builds, edits
shared/    limits, provider kinds and rates, used by the server and the page
author/    the lesson writer: jobs, pipeline, claude.js, writers/ (one per provider), prompts/
mcp/       the connector: tools, stdio and HTTP transports, which files it may read
client/    the page (React, Vite, CodeMirror), with vitest tests beside the code
scripts/   bakeoff.js and mcp-pack.js
```

## Troubleshooting

- **"Voice engine offline".** The banner says why. Usually `../install.sh` wasn't run or was interrupted; run it again. The page reconnects by itself.
- **"Loading voice model…" for over a minute.** Restart the server and read its terminal output.
- **A Japanese voice is greyed out.** Run `../install.sh --japanese`.
- **`npm install` fails on `better-sqlite3`.** Run `xcode-select --install`, or use an LTS Node.
- **Port in use.** Set `PORT=8788` in `.env`.
- **"This server only answers on localhost."** Open it as `http://localhost:8787` or `http://127.0.0.1:8787`, not through another hostname or a tunnel.
- **"… has no key" or "has not passed its Test".** The writer for that step isn't set up. Add its key or run its Test in Settings, or choose another.
- **A provider's Test says "Could not reach".** Start Ollama or the local server and check its address.
- **Claude says the dashboard isn't running.** Run `npm start`, or set `TTS_MCP_AUTOSTART=1`.
- **A lesson fails at "Writing the lesson".** Run `claude -p "hi"` in the terminal you start the dashboard from. If `claude` isn't found, set `TTS_CLAUDE_BIN` to the path `which claude` prints; if it asks you to sign in, do. After a usage limit, **Retry** once it resets.
- **A lesson fails after its fixes.** The scenes didn't run in three rounds. **Retry** gives fresh rounds, or fix the error in the **Edit** tab.
- **A lesson stopped at its cap.** Raise it in **Settings → Costs** and **Retry**.
- **"Operation not permitted", or "the sandbox may have stopped it".** Either the scene tried something scenes can't do, which **Ask for a change** or Edit fixes, or rendering needs a rule the sandbox lacks. Start with `VIDEO_SANDBOX=report npm start` and **Retry**; if that works, run `python3 ../video/sandbox_probe.py` and see [the video README](../video/README.md#when-a-project-fails-only-inside-the-sandbox).
- **"No manimgl at …" or "No Kokoro Python at …".** Run `../install.sh` again.
- **Started from a login item, it can't find `claude`, LaTeX or ffmpeg.** Such programs get a short PATH. The build adds the usual TeX and Homebrew folders; set `TTS_CLAUDE_BIN` for Claude Code.
- **Rendering is slow.** The first render fills the scene cache, and 4K takes far longer than 1080p. Use **480p, quickest** while you try things.
