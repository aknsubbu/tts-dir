# Narrated Proofs

Type a topic, drop in your notes, and get a narrated maths explainer in the style of [3Blue1Brown](https://www.3blue1brown.com/): equations that build up line by line, shapes that move, and a voice that explains each step as it appears on screen.

Claude writes the lesson, or another model you choose, on this Mac or through an API. It is rendered with [ManimGL](https://github.com/3b1b/manim), the animation library Grant Sanderson wrote for the 3Blue1Brown videos. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open model that runs on your Mac. This project is not affiliated with 3Blue1Brown.

Built for and tested on macOS with Apple Silicon. To install it, start at [Before you start](#before-you-start).

## What it does

1. **You give it a topic**, what you want to understand, and optionally your notes: typed text, photos of handwritten pages, screenshots, PDFs or Word files.
2. **Claude writes the lesson** through [Claude Code](https://claude.com/claude-code): a narration script and the ManimGL scenes that go with it, using your notation and your examples. Settings can hand any step to another writer instead: the Claude API, OpenAI, Groq, a model on this Mac (Ollama, LM Studio, llama.cpp, MLX), or any OpenAI-compatible service, with your own keys.
3. **The scenes are checked.** Every scene is run once without drawing it. Common mistakes are fixed on the spot without asking Claude; if a scene still fails, or text overlaps, or an animation runs past its word, Claude is shown the problem and rewrites.
4. **You can look before it renders.** The check leaves a storyboard: a still of the screen at every marked word and at the end of every block, with its narration. Play it as an animatic, then approve it, or let lessons render straight away. Or approve the narration before any animation is written.
5. **Long lessons come in chapters.** From 10 minutes up to 30, the writer outlines the chapters and the notation they share first; you can change the outline before each chapter is written and checked on its own, and the video is joined with chapter markers and title cards.
6. **The narration is spoken locally** by Kokoro, which also reports when each word starts.
7. **The animations are timed to the words.** A mark in the script, such as `<mark name="slope"/>`, makes an animation land on the exact frame that word is spoken.
8. **You get an MP4** with captions and a clickable transcript, in a searchable library. Each lesson shows who wrote it and what it cost. Ask for a change ("slow down the second scene") and only that is rewritten; or edit the script and scenes in the page. Each change is a new version you can compare and restore, and a rebuild renders only the scenes that changed.
9. **Or ask Claude for one.** An MCP connector lets Claude Code and the Claude desktop app start a lesson from a conversation, follow its stages and hand you the video.

A two-minute video takes roughly five to ten minutes, most of it Claude writing; a long one, about that per chapter plus the render. The one example in this repo, on the gradient of logistic regression, cost about $0.70 of Claude usage.

The dashboard also has an **Audio** tab: drop a `.txt` or `.md` script and get an MP3 in the same voice, with no Claude and no network.

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
| [tts-studio/](tts-studio/) | The dashboard you use (Node, React, SQLite), the lesson writer, the MCP connector, and the Kokoro voice engine. [README](tts-studio/README.md) |
| [video/](video/) | The video toolchain (Python): speak a script, check and render ManimGL scenes, join them, write captions. Usable on its own for videos you write by hand. [README](video/README.md) |
| [tts.py](tts.py) | Optional command-line launcher for the voice engine: `python3 tts.py script.txt` writes `script.mp3` |

```
topic + notes ──> tts-studio/author ──> claude -p, or the    writes script.txt and scenes.py
  (page or MCP)                          writer in Settings
                        │
                        └──> video/check.py                  runs every scene once; errors go back to Claude
                                  │
tts-studio/server ──> video/build.py ──> video/narrate.py    Kokoro speaks, with word timings
                                    ├──> manimgl             renders each scene, in a sandbox
                                    └──> ffmpeg              joins scenes, adds captions and a poster
```

## Before you start

| You need | Why |
| --- | --- |
| A Mac with Apple Silicon (M1 or later) | Kokoro speaks on its GPU, and ManimGL draws through Metal. Intel Macs with Metal may work but are untested. A virtual machine without GPU access cannot render. Other systems are not supported: see [Future improvements](#future-improvements) |
| Administrator access | Homebrew and BasicTeX ask for your password |
| About 3 GB of free disk space | PyTorch, the voice model (about 350 MB), ManimGL and its packages, LaTeX, and the dashboard's packages. Videos and lessons need more as you make them |
| An internet connection, during setup | Everything is downloaded once. Afterwards speech and rendering work offline; writing a lesson needs the writer you choose |
| A lesson writer | By default Claude Code, signed in with a Claude Pro or Max plan or an Anthropic API account. Or a key for the Claude API, OpenAI or Groq, or a model running on this Mac with Ollama or LM Studio. The Audio tab needs none |

Setting everything up takes roughly 20 to 40 minutes, most of it downloads.

## Install

Run these in Terminal. Each step ends with a check; if a check fails, see [Troubleshooting the setup](#troubleshooting-the-setup).

### 1. Apple's command line tools and Homebrew

```bash
xcode-select --install     # git and compilers; skip if it says they are already installed
```

Install [Homebrew](https://brew.sh) if you do not have it:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

At the end, the installer prints two commands under **Next steps** that put `brew` on your PATH. Run them, then open a new Terminal window.

Check: `brew --version` prints a version.

### 2. The tools

```bash
brew install node uv ffmpeg
brew install --cask basictex        # LaTeX, for equations; asks for your password
eval "$(/usr/libexec/path_helper)"  # or open a new terminal, to pick up /Library/TeX/texbin
sudo tlmgr update --self
sudo tlmgr install dvisvgm standalone preview babel-english doublestroke setspace tipa relsize rsfs calligra fundus-calligra wasysym wasy ragged2e physics xcolor microtype cm-super
```

- **Node** (20 or newer) runs the dashboard. **uv** installs the right Python versions by itself, so you do not need to install Python. **ffmpeg** joins and encodes the videos.
- **BasicTeX** is a small LaTeX (about 100 MB, plus the packages above). If you already have [MacTeX](https://www.tug.org/mactex/), skip the BasicTeX line; it has every package already.

Check: `node --version` prints v20 or later, and `which latex dvisvgm ffmpeg uv` prints four paths.

### 3. Get the code

```bash
git clone https://github.com/aknsubbu/tts-dir.git
cd tts-dir
```

Every command below starts from this `tts-dir` folder.

### 4. The dashboard and the voice

```bash
cd tts-studio
npm install
npm run setup      # once: installs Kokoro into tts-studio/.venv and downloads about 350 MB of model files
cd ..
```

`npm run setup` takes a few minutes. It ends by speaking a test sentence in every language and printing `Done. Start the dashboard with: npm run app`. It is safe to run again if it was interrupted. Japanese voices need a further 1 GB: `npm run setup:japanese`.

### 5. The video toolchain

```bash
cd video
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt   # ManimGL at the pinned commit, from GitHub
cd ..
```

This is a second Python environment, kept apart from the voice's so PyTorch never loads while rendering.

### 6. Check that videos render

```bash
cd video
.venv/bin/manimgl smoke/smoke_scene.py SmokeText -w -l --video_dir smoke/out   # shapes and text
.venv/bin/manimgl smoke/smoke_scene.py SmokeTex -w -l --video_dir smoke/out    # an equation, through LaTeX
python3 build.py demo --quality low      # the demo, narrated and rendered the way lessons are
open projects/demo/build/demo.mp4
python3 sandbox_probe.py                 # renders the smoke scenes and the example lesson inside the sandbox
cd ..
```

- The two smoke scenes write MP4s under `smoke/out/` in a few seconds each. If `SmokeTex` fails on a missing `.sty` file, install the package it names with `sudo tlmgr install <name>` and run it again.
- `build.py demo` speaks the demo's script with Kokoro, renders its scenes and joins them, with captions. The video should play with the voice in step with the pictures.
- `sandbox_probe.py` takes a few minutes. Scenes, which a model writes, run inside the macOS sandbox, which lets them read only what rendering needs. The probe renders under those rules, reports each render as ok, and should say **The strict rules stopped nothing these renders needed**. If it lists rules instead, rendering on this Mac needs something they do not allow; see [When a project fails only inside the sandbox](video/README.md#when-a-project-fails-only-inside-the-sandbox).

### 7. A lesson writer

**Claude Code** (the default). Install it as described at [claude.com/claude-code](https://claude.com/claude-code); with Node installed, `npm install -g @anthropic-ai/claude-code` is one way. Then run `claude` once in Terminal and sign in when it asks. Lessons use your Claude plan's limits, or your API credits if you signed in with an Anthropic Console account.

Check: `claude -p "Reply with the word ready"` prints `ready`.

**Or another writer.** Skip Claude Code and set one up in the dashboard once it is running (step 8): see [Writing lessons without Claude Code](#writing-lessons-without-claude-code).

### 8. Start it

```bash
cd tts-studio
npm run app        # builds the page, then serves it on http://localhost:8787
```

Open <http://localhost:8787>. Within a few seconds the header says **Kokoro ready**. Leave the Terminal window open while you use the dashboard; **Ctrl-C** stops it. From then on, `npm start` starts it without building the page again (use `npm run app` after updating).

## Make your first lesson

1. On the **Lessons** tab, under **Explain it to me**, type a topic, such as "Why the derivative of x² is 2x", and what you want to understand.
2. Optionally add notes: type them, drop a photo or PDF anywhere on the page, or paste a screenshot.
3. Choose **About 1 minute**, quality **480p, quickest**, and under **Before it renders** choose **Show me the storyboard**. The line above the button says who will write it and about what it will cost.
4. Press **Make the video**. The card in the library shows each stage: writing, checking, perhaps fixing. Writing usually takes a few minutes.
5. When the card says **Storyboard ready**, open it. The **Storyboard** tab shows a still of every step with its narration; **Play as animatic** plays the narration with them. Press **Approve and render**.
6. The video plays on the **Watch** tab, with captions and a transcript beside it. Below it is what writing it took: who wrote it, the cost and the fixes.

From there, type into **Ask for a change** at the bottom ("slow down the second scene"), or edit the script and scenes in the **Edit** tab. Every lesson tab is described in [tts-studio/README.md](tts-studio/README.md#explain-it-to-me-a-video-from-a-topic).

## Everyday use

```bash
cd tts-dir/tts-studio
npm start          # or npm run app after updating
```

- **The dashboard runs while its Terminal window is open.** A lesson or build that is running when it stops is marked failed; press **Retry** on its card and it carries on from the files already written.
- **Lessons are folders.** Each one is a normal project in `video/projects/<topic>-<id>/`. Edit `script.txt` or `scenes.py` in your own editor if you like, then check and render it from the dashboard's Edit tab, or from Terminal:

  ```bash
  python3 video/check.py <project>     # check it without rendering
  python3 video/build.py <project>     # render it again
  ```

- **Plain text to speech.** The **Audio** tab turns scripts into MP3s; `python3 tts.py script.md` does the same from Terminal.
- **Settings**, the gear in the header, chooses the writer, the defaults for new lessons, spending caps, and what Claude may change through the connector.
- **Optional settings** go in `tts-studio/.env`; copy [tts-studio/.env.example](tts-studio/.env.example), which lists them all. A value there wins over the Settings page.

## Writing lessons without Claude Code

Open **Settings → Lesson writer** in the dashboard.

- **An API key** (Claude API, OpenAI or Groq): open the provider, paste the key, press **Save key**, then **Test** with the model you want. Under **Who does each step**, choose that provider and model. Keys are kept in the macOS Keychain. For OpenAI and Groq, add their prices under **Costs → Rates**, or their costs show as unknown and the spending caps cannot count them.
- **A model on this Mac, for free**: install [Ollama](https://ollama.com) (`brew install ollama`, then `ollama serve` in its own Terminal window, or open the Ollama app) and pull a coding model with `ollama pull <model>`. Or start [LM Studio](https://lmstudio.ai)'s server. In Settings, **Test** **This Mac: Ollama** (or **This Mac: OpenAI-compatible** for LM Studio, llama.cpp, MLX or vLLM), and choose it under **Who does each step**. Your notes then never leave this Mac.
- **A mix**: choose **Per step** to have, say, Claude write the lesson and a local model fix the scenes, handing back to Claude when a fix keeps failing.

ManimGL is a niche library and most models learned the other Manim, so other writers fail the check more often than Claude. `npm run bakeoff` compares writers on the same lessons before you switch. The details are in [tts-studio/README.md](tts-studio/README.md#who-writes-your-lessons-settings).

## Connect Claude (optional)

With the dashboard running, Claude Code can make lessons from a conversation ("make a 3-minute lesson on what we just derived"):

```bash
claude mcp add --transport http narrated-proofs http://localhost:8787/mcp
```

**Settings → Connect Claude** shows this command with your port, a version that starts the connector itself, and the entry for the Claude desktop app's `claude_desktop_config.json`. `npm run mcp:pack` in `tts-studio` makes a desktop extension, `tts-studio/extension/narrated-proofs.mcpb`, to open instead. The tools are listed in [tts-studio/README.md](tts-studio/README.md#make-lessons-from-claude-the-mcp-connector).

## Updating

```bash
cd tts-dir
git pull
cd tts-studio
npm install
npm run setup                                                     # safe to re-run; quick when nothing changed
cd ../video
uv pip install --python .venv/bin/python -r requirements.txt      # when requirements.txt changed
cd ../tts-studio
npm run app                                                       # rebuilds the page
```

The library's database upgrades itself when the dashboard starts. Copy `tts-studio/data/` first if you want a way back. Your lessons in `video/projects/` show up as untracked files in `git status`; they are yours, and `git pull` leaves them alone.

## Uninstalling

1. In **Settings → Lesson writer**, remove any keys you saved. They are in the Keychain under **Narrated Proofs**, so Keychain Access also finds them.
2. If you connected Claude Code: `claude mcp remove narrated-proofs`. For the desktop app, remove the `narrated-proofs` entry from its config or the extension from its settings.
3. Delete the `tts-dir` folder. That removes the library (`tts-studio/data/`), your lessons (`video/projects/`) and both Python environments, so copy anything you want to keep first.
4. Delete the caches outside it: the voice model in `~/.cache/huggingface/hub/models--hexgrad--Kokoro-82M` (other programs may share `~/.cache/huggingface`, so delete only that folder) and the scene cache in `~/Library/Caches/narrated-proofs-scenes`.
5. Optionally, `brew uninstall --cask basictex` and `brew uninstall node uv ffmpeg`, if nothing else of yours uses them.

## What leaves your machine

What a lesson sends, by writer. Settings → Lesson writer says the same for the writers you have chosen, step by step.

| Writer | Your topic, notes and files go to |
| --- | --- |
| Claude Code (the default), Claude API | Anthropic |
| OpenAI | OpenAI |
| Groq | Groq |
| This Mac: Ollama, LM Studio, llama.cpp, MLX, vLLM | Nobody: they stay on this Mac |
| Other | The service at the address you gave |

- **Stays local:** speech, rendering and the library. The server listens on `127.0.0.1` only and refuses requests from pages on other sites; the MCP connector's `/mcp` address is behind the same checks. Do not put it behind a tunnel or a proxy: it has no login.
- **Keys** are kept in the macOS Keychain, are never shown again in the page, and never reach the scenes or `claude -p`.
- **The code the writer produces runs in a sandbox:** no network; no writing outside the lesson's `build/` folder and a cache kept for scenes; reading only the lesson and what rendering needs; starting no program but Python, ffmpeg and TeX; no Apple Events, Launch Services or clipboard; and none of the environment's API keys or tokens. Details are in [video/README.md](video/README.md#the-sandbox).
- **Claude in a conversation** can start lessons and change the settings you allow, but never add a provider, change an address, touch a key or raise a spending cap.

## Where your files go

| Path | Contents | In git |
| --- | --- | --- |
| `tts-studio/data/` | The library: SQLite database (with Settings), MP3s, finished videos | no |
| `video/projects/<name>/` | One folder per video: script, scenes, `project.json`, and `build/` (renders, the scene cache, the storyboard) | everything except `build/` and `versions/` |
| `video/projects/<name>/versions/` | Each version of a lesson: its script, scenes and storyboard as they were | no |
| `video/projects/<name>/notes/`, `brief.json` | Your notes and attached files for a lesson | no, for new lessons; the example lesson's `brief.json` is tracked |
| `tts-studio/.venv/`, `video/.venv/` | The two Python environments | no |
| `tts-studio/.env` | Optional settings; see [tts-studio/.env.example](tts-studio/.env.example). Values set here win over the Settings page | no |
| `~/.cache/huggingface/` | Kokoro's model and voices, downloaded by `npm run setup` | outside the repo |
| `~/Library/Caches/narrated-proofs-scenes/` | What manim, TeX and matplotlib cache while rendering | outside the repo |
| Keychain, "Narrated Proofs" | Provider keys saved in Settings | outside the repo |

To back up your work, copy `tts-studio/data/` and `video/projects/`.

## Troubleshooting the setup

| What you see | What to do |
| --- | --- |
| `command not found: brew` | Run the two commands the Homebrew installer printed under **Next steps**, then open a new Terminal window |
| `npm install` fails building `better-sqlite3` | Your Node version has no prebuilt binary yet. Run `xcode-select --install` so it can compile, or install the current LTS Node (`brew install node@22`, then follow the PATH note it prints) |
| `npm run setup` says it needs Python 3.10 to 3.12 | Install uv (`brew install uv`) and run it again; uv fetches a suitable Python |
| `npm run setup` stops partway | It was most likely the download. Run it again; it carries on |
| `tlmgr: command not found` | Run `eval "$(/usr/libexec/path_helper)"` or open a new Terminal window, so `/Library/TeX/texbin` is on your PATH |
| `SmokeTex` fails on `File 'something.sty' not found` | `sudo tlmgr install something`, then run it again |
| A smoke scene fails before drawing anything, about an adapter, a device or Metal | ManimGL draws through Metal. Render on the Mac itself rather than in a virtual machine |
| `No manimgl at …/video/.venv/bin/manimgl` | Step 5 did not finish. Run its two `uv` commands again from `video/` |
| `No Kokoro Python at …` | Step 4 did not finish. Run `npm run setup` in `tts-studio` |
| `sandbox_probe.py` lists rules, or a lesson fails with "The sandbox may have stopped it" | See [When a project fails only inside the sandbox](video/README.md#when-a-project-fails-only-inside-the-sandbox). Meanwhile `VIDEO_SANDBOX=report npm start` lets scenes do what the rules stopped and logs it |
| A lesson fails at "Writing the lesson" with a message about `claude` | Claude Code is not installed, not on the dashboard's PATH, or not signed in. Check `claude -p "hi"` in the same Terminal, or set `TTS_CLAUDE_BIN` in `.env` to its full path (`which claude`) |
| `Port 8787 is already in use` | Another copy is running, or another program uses the port. Set `PORT=8788` in `tts-studio/.env` |

Problems with the dashboard itself are covered in [tts-studio/README.md](tts-studio/README.md#troubleshooting), and with rendering in [video/README.md](video/README.md#troubleshooting).

## Tests

```bash
cd tts-studio
npm test           # server, lesson writer, MCP connector, page, engine and video tests
npm run lint
```

None of the tests call Claude or any other model: fake OpenAI-, Ollama- and Anthropic-style servers stand in for the providers. The ones that load the real voice model are skipped until `npm run setup` has run, the sandbox tests run only on macOS, and the real render inside the sandbox only once `video/.venv` exists. GitHub Actions runs lint, the tests and a build on every push to `master` and every pull request, and renders the Text smoke scene inside the sandbox on macOS ([ci.yml](.github/workflows/ci.yml)).

## Future improvements

None of these exist yet.

- **Claude in a browser.** The MCP connector works with Claude Code and the desktop app. claude.ai connects from Anthropic's servers, so it would need this Mac reachable over HTTPS with a login in front: a tunnel, OAuth, and expiring links for videos.
- **Write it in the conversation.** Tools that hand Claude Code the lesson guide and let it submit a script and scenes itself, so the conversation's own Claude writes the lesson with everything it already knows.
- **The sandbox's rules, from more Macs.** Scenes now read only what rendering needs and start only Python, ffmpeg and TeX, with the paths found on each Mac. The rules were written from how ManimGL, TeX and ffmpeg are installed and started, not yet from a run on a Mac; `python3 video/sandbox_probe.py` renders under them and lists anything a Mac's setup needs beyond them, which is what would widen them.
- **Other platforms.** Attached photos and documents, and the sandbox, rely on tools that ship with macOS. Linux needs replacements for `sips`, `textutil` and `sandbox-exec` (bubblewrap, say); there scenes run with the short environment and the limits, but unconfined.
- **Word-level sync in other languages.** Only the English voices report word timings, so lessons are English only.
- **More of the page under test.** The lesson form, the workspace and its Outline, Edit and History tabs, the storyboard, Settings, the library's cards, the API wrapper and the helpers are tested; the audio details panel and drag and drop are not.
