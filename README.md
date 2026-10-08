# Narrated Proofs

Type a topic, drop in your notes, and get a narrated maths explainer in the style of [3Blue1Brown](https://www.3blue1brown.com/): equations that build up line by line, shapes that move, and a voice that explains each step as it appears on screen.

Claude writes the lesson, or another model you choose, on this Mac or through an API. It is rendered with [ManimGL](https://github.com/3b1b/manim), the animation library Grant Sanderson wrote for the 3Blue1Brown videos. The voice is [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), an open model that runs on your Mac. This project is not affiliated with 3Blue1Brown.

Built for and tested on macOS with Apple Silicon.

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

## Setup

1. **Dashboard and voice.** Node 20 or newer, and Python 3.10 to 3.12 or [uv](https://docs.astral.sh/uv/).

   ```bash
   cd tts-studio
   npm install
   npm run setup      # once: installs Kokoro into .venv and downloads about 350 MB of model files
   ```

2. **Video toolchain.** ffmpeg, BasicTeX for the equations, and ManimGL in `video/.venv`. The commands are in [video/README.md](video/README.md#setup-macos).

3. **Claude Code.** [Install it](https://claude.com/claude-code), sign in, and have `claude` on your PATH. Each lesson uses your Claude plan or credits: one request to write it, plus one for each fix. To use another writer, set it up in the dashboard's Settings (the gear in the header) instead.

4. **Optional: Claude as a way in.** Settings → Connect Claude gives the one command for Claude Code (`claude mcp add --transport http narrated-proofs http://localhost:8787/mcp`) and the entry for the desktop app.

## Run

```bash
cd tts-studio
npm run app        # builds the UI and serves it on http://localhost:8787
```

Open the page, fill in **Explain it to me** on the Lessons tab, and press **Make the video**. The card in the library shows each stage, and the finished video plays there with captions.

Every lesson can be edited in its **Edit** tab and rendered as a new version, and **History** compares and restores versions. Each lesson is also a normal project folder in `video/projects/`, so you can edit `script.txt` or `scenes.py` in your own editor and rebuild:

```bash
python3 video/check.py <project>     # check it without rendering
python3 video/build.py <project>     # render it again
python3 video/build.py demo          # the hand-written demo project
```

The dashboard's **Audio** tab does plain script-to-MP3 with the same voice, with no Claude and no network. `python3 tts.py script.md` does the same from the terminal.

## What leaves your machine

What a lesson sends, by writer. Settings → Lesson writer says the same for the writers you have chosen, step by step.

| Writer | Your topic, notes and files go to |
| --- | --- |
| Claude Code (the default), Claude API | Anthropic |
| OpenAI | OpenAI |
| Groq | Groq |
| This Mac: Ollama, LM Studio, llama.cpp, MLX, vLLM | Nobody: they stay on this Mac |
| Other | The service at the address you gave |

- **Stays local:** speech, rendering and the library. The server listens on `127.0.0.1` only and refuses requests from pages on other sites; the MCP connector's `/mcp` address is behind the same checks.
- **Keys** are kept in the macOS Keychain, are never shown again in the page, and never reach the scenes or `claude -p`.
- **The code the writer produces runs in a sandbox:** no network; no writing outside the lesson's `build/` folder and a cache kept for scenes; reading only the lesson and what rendering needs; starting no program but Python, ffmpeg and TeX; no Apple Events, Launch Services or clipboard; and none of the environment's API keys or tokens. Details are in [video/README.md](video/README.md#the-sandbox).
- **Claude in a conversation** can start lessons and change the settings you allow, but never add a provider, change an address, touch a key or raise a spending cap.

## Tests

```bash
cd tts-studio
npm test           # server, lesson writer, page, engine and video tests
npm run lint
```

None of the tests call Claude or any other model: fake OpenAI-, Ollama- and Anthropic-style servers stand in for the providers. The ones that load the real voice model are skipped until `npm run setup` has run. GitHub Actions runs lint, the tests and a build on every push to `master` and every pull request ([ci.yml](.github/workflows/ci.yml)).

## Where your files go

| Path | Contents | In git |
| --- | --- | --- |
| `tts-studio/data/` | The library: SQLite database, MP3s, finished videos | no |
| `video/projects/<name>/` | One folder per video: script, scenes, `project.json`, and `build/` (renders, the scene cache, the storyboard) | everything except `build/` and `versions/` |
| `video/projects/<name>/versions/` | Each version of a lesson: its script, scenes and storyboard as they were | no |
| `video/projects/<name>/notes/`, `brief.json` | Your notes and attached files for a lesson | no, for new lessons; the example lesson's `brief.json` is tracked |
| `.env` | Optional settings; see [tts-studio/.env.example](tts-studio/.env.example). Values set here win over the Settings page | no |

## Future improvements

None of these exist yet.

- **Claude in a browser.** The MCP connector works with Claude Code and the desktop app. claude.ai connects from Anthropic's servers, so it would need this Mac reachable over HTTPS with a login in front: a tunnel, OAuth, and expiring links for videos.
- **Write it in the conversation.** Tools that hand Claude Code the lesson guide and let it submit a script and scenes itself, so the conversation's own Claude writes the lesson with everything it already knows.
- **The sandbox's rules, from more Macs.** Scenes now read only what rendering needs and start only Python, ffmpeg and TeX, with the paths found on each Mac. The rules were written from how ManimGL, TeX and ffmpeg are installed and started, not yet from a run on a Mac; `python3 video/sandbox_probe.py` renders under them and lists anything a Mac's setup needs beyond them, which is what would widen them.
- **Other platforms.** Attached photos and documents, and the sandbox, rely on tools that ship with macOS. Linux needs replacements for `sips`, `textutil` and `sandbox-exec` (bubblewrap, say); there scenes run with the short environment and the limits, but unconfined.
- **Word-level sync in other languages.** Only the English voices report word timings, so lessons are English only.
- **More of the page under test.** The lesson form, the workspace and its Outline, Edit and History tabs, the storyboard, Settings, the library's cards, the API wrapper and the helpers are tested; the audio details panel and drag and drop are not.
