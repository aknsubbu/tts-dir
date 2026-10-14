# Narrated Proofs

Type a topic, add your notes, and get a narrated maths explainer in the style of [3Blue1Brown](https://www.3blue1brown.com/): equations that build line by line, shapes that move, and a voice that explains each step as it appears.

Claude writes the lesson (or another model you choose). [ManimGL](https://github.com/3b1b/manim) renders it, and [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open voice model, speaks it on your own machine. Not affiliated with 3Blue1Brown.

Built for macOS on Apple Silicon. On Windows or Linux, [use Docker](#docker).

## How it works

1. **You give it a topic**, and optionally notes: text, photos, screenshots, PDFs or Word files.
2. **A model writes the lesson**: a narration script and the ManimGL scenes for it. Claude Code is the default. Settings can switch any step to the Claude API, OpenAI, Groq, or a local model (Ollama, LM Studio, llama.cpp, MLX).
3. **Every scene is checked** without drawing it. Common mistakes are fixed automatically; anything else goes back to the writer.
4. **You review it first**, if you want: a storyboard with a still for every marked word, or just the narration.
5. **Kokoro speaks it**, and each animation is timed to its word with a mark such as `<mark name="slope"/>`.
6. **You get an MP4** with captions and a transcript, kept in a searchable library. Ask for a change ("slow down the second scene") and only that part is rewritten.

Lessons of 10 to 30 minutes are written in chapters. A two-minute video takes about five to ten minutes. The dashboard also has an **Audio** tab that turns a `.txt` or `.md` into an MP3, with no model and no network. Claude Code and the Claude desktop app can start lessons too, through an [MCP connector](#connect-claude).

## What is here

| Path | What it is |
| --- | --- |
| [tts-studio/](tts-studio/README.md) | The dashboard (Node, React, SQLite), the lesson writer, the MCP connector and the voice engine |
| [video/](video/README.md) | The video toolchain (Python): narrate, check, render, join, caption. Works on its own |
| [install.sh](install.sh), [pyproject.toml](pyproject.toml) | The installer and the one Python environment it makes (ManimGL and Kokoro) |
| [Dockerfile](Dockerfile), [docker-compose.yml](docker-compose.yml) | The same thing as a Linux image |
| [tts.py](tts.py) | `python3 tts.py script.txt` writes `script.mp3` |

## Install (macOS)

You need an Apple Silicon Mac, administrator access (Homebrew and LaTeX ask for a password), about 3 GB of disk, and a connection for the first run. Setup takes 20 to 40 minutes, mostly downloads.

1. Install Apple's command line tools (`xcode-select --install`) and [Homebrew](https://brew.sh). Run the two commands Homebrew prints under **Next steps**, then open a new Terminal.
2. Run the installer. It is safe to run again if it stops partway:

   ```bash
   git clone https://github.com/aknsubbu/tts-dir.git
   cd tts-dir
   ./install.sh
   ```

   It installs Node, uv, ffmpeg and BasicTeX (an existing MacTeX is used as is), creates `.venv`, builds the dashboard, downloads the voice model (about 350 MB) and renders a test equation. Japanese voices need another 1 GB: `./install.sh --japanese`.
3. Install a lesson writer. For Claude Code: `npm install -g @anthropic-ai/claude-code`, then run `claude` once to sign in. Or pick another writer later in Settings.

Start it:

```bash
cd tts-studio
npm start          # http://localhost:8787, and Ctrl-C to stop
```

The header says **Kokoro ready** after a few seconds. To check rendering and the sandbox, run `python3 build.py demo --quality low` and `python3 sandbox_probe.py` in `video/`.

## Your first lesson

1. On **Lessons**, type a topic, such as "Why the derivative of x² is 2x".
2. Optionally drop in notes, a photo or a PDF.
3. Choose **About 1 minute**, **480p, quickest**, and **Show me the storyboard**.
4. Press **Make the video**. Writing takes a few minutes.
5. When the card says **Storyboard ready**, open it, play the animatic, and press **Approve and render**.

Then type into **Ask for a change** or edit the script and scenes in the **Edit** tab. Every tab is described in the [dashboard README](tts-studio/README.md#lessons-a-video-from-a-topic).

## Everyday use

- **Update:** `git pull && ./install.sh`. The library upgrades itself on start; copy `tts-studio/data/` first if you want a way back.
- **Lessons are folders** in `video/projects/<topic>-<id>/`. Edit `script.txt` or `scenes.py` and run `python3 video/check.py <project>` or `python3 video/build.py <project>`, or use the Edit tab.
- **Use it from another device:** `TTS_LAN=1 npm run app` also serves it on your network, at the address printed on start. Private addresses only. A home network speaks plain HTTP, so use one you trust, and read [Sharing with housemates](#sharing-with-housemates) first.
- **Settings** (the gear) choose the writer, defaults and spending caps. Optional environment settings go in `tts-studio/.env`; see [.env.example](tts-studio/.env.example).

## Sharing with housemates

Several people can share one install, each with their own library, settings, spending caps and API keys. Open the dashboard and press **Add profile**, or use the avatar in the header. With more than one profile, or a PIN, the dashboard opens on **Who's watching?**. With one profile and no PIN nothing changes: there is no gate.

- **Profiles.** A name, an avatar (a colour and an initial or emoji) and an optional 4-digit PIN. A padlock marks a locked profile. `TTS_MAX_PROFILES` (default 5) is the most there can be.
- **The Owner** is the first profile, and your existing library lands there. The Owner can ask for their PIN before anyone adds a profile, reset another profile's PIN (with their own PIN) and decide what each other profile may borrow from this computer.
- **Borrowing from the host.** The Claude Code sign-in and any API keys in `.env` belong to whoever runs the computer. A new profile may use neither until the Owner ticks **May use this Mac's Claude sign-in** and **May use the host's API keys**. Until then it chooses another writer in **Settings → Lesson writer**, such as a model on this Mac with [Ollama](https://ollama.com), which is free. A profile's own key always comes first.
- **Forgot a PIN?** The Owner can reset it. For the Owner's own, run `npm run profiles -- reset-pin <name>` in `tts-studio/` on the computer that hosts this. Whoever can run that can read the data folder anyway, which is why it needs no PIN.
- **Lockout.** Five wrong PINs lock that profile for 30 seconds, then for twice as long each time, up to 15 minutes. One device also has a limit across all profiles.
- **Claude.** A connector token (**Settings → Connect Claude**) makes Claude act as exactly one profile. See [Connect Claude](#connect-claude).
- **The render queue is shared.** One video renders at a time for everyone, so a card can say **Queued behind 2**.

**What a PIN is and is not.** It keeps housemates out of each other's lessons. It is not security against someone set on getting in:

- There is no HTTPS on a LAN. On a network you do not trust, anyone on it can read what you send, PIN included.
- Anyone who can use the computer that runs it, or read its `tts-studio/data/` folder, can read everything in it, whatever the PINs say.
- Four digits is 10,000 guesses. Lockout slows guessing; it does not make it hard.
- A connector token works whether or not the profile has a PIN, so keep tokens private. Setting a profile's first PIN revokes its tokens.
- **Deleting a profile** deletes its lessons, settings, keys and tokens, and asks for its PIN (or the Owner's) and its name.

**Back up** by copying `tts-studio/data/` (the database holds profiles and everyone's settings; `pin-pepper` and `secrets.json` are in there too, keep them private) and `video/projects/`. A Docker volume backup covers it. Projects stay in `video/projects/<topic>-<id>/`; who owns one is recorded in the database only.

## Other lesson writers

In **Settings → Lesson writer**:

- **An API key** (Claude, OpenAI, Groq): paste it, press **Save key**, **Test**, then choose it under **Who does each step**. For OpenAI and Groq, add their prices under **Costs → Rates**, or their cost counts as unknown.
- **A local model**: install [Ollama](https://ollama.com) and pull a model, or start LM Studio's server. Your notes then never leave your Mac.
- **A mix**: choose **Per step**, for example Claude for writing and a local model for fixes.

ManimGL is niche and most models learned the other Manim, so non-Claude writers fail the check more often. `npm run bakeoff` compares writers first. See [the dashboard README](tts-studio/README.md#settings-who-writes-your-lessons).

## Connect Claude

With the dashboard running (and, if one person uses it with no PIN, nothing more):

```bash
claude mcp add --transport http narrated-proofs http://localhost:8787/mcp
```

**Settings → Connect Claude** shows this with your port, plus the entry for the desktop app. The tools are listed in the [dashboard README](tts-studio/README.md#make-lessons-from-claude-the-mcp-connector).

**With more than one profile** Claude has to be connected to one of them. In **Settings → Connect Claude** press **Make a token**: it is shown once, and the page then shows the same commands with `--header "Authorization: Bearer <token>"` (or `NARRATED_PROOFS_TOKEN` for the stdio connector) filled in. Everything Claude does then belongs to that profile, under that profile's Claude settings, and **Revoke** stops it at once. A token cannot manage profiles or tokens. The packaged `.mcpb` bundle cannot carry a token, so add `NARRATED_PROOFS_TOKEN` to the desktop app's config entry instead.

## Docker

One image holds the dashboard, Kokoro, ManimGL, TeX, ffmpeg and Claude Code. You need Docker Desktop (on Windows, with WSL 2), git and about 8 GB of disk.

```bash
git clone https://github.com/aknsubbu/tts-dir.git
cd tts-dir
docker compose up --build
```

The first build takes 15 to 30 minutes. Open <http://localhost:8787> when the log says **Kokoro ready**. Sign Claude Code in once with `docker compose exec app claude`, or put `ANTHROPIC_API_KEY` in `tts-studio/.env`.

| | |
| --- | --- |
| Run in the background | `docker compose up -d`, then `docker compose logs -f` |
| Stop (lessons and library stay) | `docker compose down` |
| Update | `git pull`, then `docker compose up --build` |
| Check or render from a terminal | `docker compose exec app python3 ../video/check.py <project>` |
| Another port | `PORT=8788 docker compose up` |
| Remove everything | `docker compose down -v`, then `docker image rm narrated-proofs` |

Lessons are in `video/projects/` as on a Mac. The library, the render cache and Claude's sign-in are Docker volumes; back up the library with `docker compose cp app:/app/tts-studio/data ./data-backup`. That copy holds every profile, PIN hash and key. The compose file publishes the port on `127.0.0.1` only; to share with housemates, publish it on your network address instead and set `TTS_LAN=1` (see [Sharing with housemates](#sharing-with-housemates)).

Differences from a Mac:

- **CPU only.** Without a GPU, ManimGL draws through lavapipe. The 2-minute example takes about 4 minutes on a 16-thread PC; choose **480p** while you work. The voice also runs on the CPU, at about twice real time.
- **No sandbox.** Scenes run inside the container but not under `sandbox-exec`, so they could use the network and read Claude's sign-in and saved keys. Don't render a project you don't trust. See [the sandbox](video/README.md#the-sandbox).
- **Notes** are converted with libvips, pandoc and catdoc instead of `sips` and `textutil`.
- **Ollama or LM Studio** on your computer is at `http://host.docker.internal:11434` (or `:1234/v1`).

## Privacy

| Writer | Your topic, notes and files go to |
| --- | --- |
| Claude Code, Claude API | Anthropic |
| OpenAI, Groq | OpenAI, Groq |
| A local model | Nobody |
| Other | The address you gave |

Speech, rendering and the library stay on your machine. The server listens on `127.0.0.1` only and refuses requests from other sites. With `TTS_LAN=1` it also answers on private network addresses; profiles and PINs keep housemates apart but are not strong security (see [Sharing with housemates](#sharing-with-housemates)), so don't put it behind a tunnel or proxy or on a network you don't trust. Keys live in the macOS Keychain and never reach scenes or `claude -p`. On a Mac, generated scene code runs in a sandbox: no network, no writing outside the lesson's `build/` folder, no reading your keys or home folder, no programs except Python, ffmpeg and TeX. Claude, through the connector, can start lessons and change the settings you allow, but never add a provider, touch a key or raise a spending cap.

## Where your files go

| Path | Contents | In git |
| --- | --- | --- |
| `tts-studio/data/` | Library: database (lessons, profiles, settings), MP3s, videos, `pin-pepper`, `secrets.json` | no |
| `video/projects/<name>/` | One folder per lesson: script, scenes, `build/`, `versions/`, `notes/` | no, except `demo` |
| `.venv/` | The Python environment | no |
| `tts-studio/.env` | Optional settings; they win over the Settings page | no |
| `~/.cache/huggingface/` | Kokoro's model | outside the repo |
| `~/Library/Caches/narrated-proofs-scenes/` | Render caches | outside the repo |
| Keychain, "Narrated Proofs" | Saved provider keys, one set per profile | outside the repo |

To back up your work, copy `tts-studio/data/` and `video/projects/`.

## Uninstall

1. Remove saved keys in **Settings → Lesson writer**, and `claude mcp remove narrated-proofs` if you connected Claude.
2. Delete the `tts-dir` folder. This also deletes your library and lessons, so copy what you want first.
3. Delete `~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M` and `~/Library/Caches/narrated-proofs-scenes`.
4. Optionally `brew uninstall --cask basictex` and `brew uninstall node uv ffmpeg`.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `command not found: brew` | Run the commands Homebrew printed under **Next steps**, in a new Terminal |
| `npm install` fails on `better-sqlite3` | Run `xcode-select --install`, or use Node 22 (`brew install node@22`) |
| `./install.sh` stops partway | Usually a download. Run it again |
| `File 'something.sty' not found` | `sudo tlmgr install something`, then `./install.sh` |
| Render fails about an adapter, device or Metal | Render on the Mac itself, not in a virtual machine |
| `No manimgl at …` or `No Kokoro Python at …` | `./install.sh` did not finish. Run it again |
| "The sandbox may have stopped it" | See [video/README.md](video/README.md#when-a-project-fails-only-inside-the-sandbox). `VIDEO_SANDBOX=report npm start` logs what the rules stopped |
| Failure at "Writing the lesson" about `claude` | Claude Code isn't installed or signed in. Check `claude -p "hi"`, or set `TTS_CLAUDE_BIN` in `.env` |
| `Port 8787 is already in use` | Set `PORT=8788` in `tts-studio/.env` |

More in the [dashboard](tts-studio/README.md#troubleshooting) and [video](video/README.md#troubleshooting) READMEs.

## Tests

```bash
cd tts-studio
npm test
npm run lint
```

No test calls a model; fake providers stand in. Tests that load the real voice or render in the sandbox are skipped until `./install.sh` has run, and the sandbox tests run only on macOS. CI runs lint, tests and a build on every push and pull request ([ci.yml](.github/workflows/ci.yml)).

## Not built yet

- **Claude in a browser.** claude.ai connects from Anthropic's servers, so this Mac would need HTTPS and a login.
- **Write it in the conversation.** Let Claude Code submit a script and scenes itself.
- **A sandbox outside macOS** (bubblewrap, or a render container) for Docker.
- **GPU rendering in Docker** (Vulkan over Direct3D 12 on WSL 2, or an NVIDIA image).
- **HTTPS for a LAN.** Profiles and PINs run over plain HTTP, so they are privacy between housemates, not security.
- **An Owner-level cap on host-key spend.** A profile the Owner lets use the host's keys sets its own spending caps.
- **Fair scheduling between profiles.** One render runs at a time for everyone; a card shows **Queued behind N**.
- **Sharing a lesson between profiles**, and avatar pictures.
- **Word-level sync outside English.** Only English voices report word timings.
