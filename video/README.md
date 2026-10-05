# video

Narrated manim videos, with audio from the Kokoro engine in `../tts-studio`.

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

## Check it works

```bash
.venv/bin/manimgl smoke/smoke_scene.py SmokeText -w --hd --video_dir smoke/out    # shapes and Text
.venv/bin/manimgl smoke/smoke_scene.py SmokeTex -w --hd --video_dir smoke/out     # needs LaTeX
echo "The derivative measures how fast a function changes." | python3 ../tts.py - -o smoke/out/line.wav
.venv/bin/manimgl smoke/smoke_scene.py SmokeAudio -w --hd --video_dir smoke/out   # needs line.wav
```

`-w` renders without opening a window. Leave it off to preview in a window, which is silent.
