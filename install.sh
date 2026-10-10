#!/bin/sh
# Installs or updates everything Narrated Proofs needs on a Mac. Safe to re-run: a step
# that is already done is skipped, so this is also what you run after `git pull`.
#   ./install.sh              everything except the Japanese voices
#   ./install.sh --japanese   also Japanese (a further 1 GB dictionary download)
set -e
cd "$(dirname "$0")"
REPO=$(pwd)

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "Narrated Proofs runs on macOS only (see README, Future improvements)."
xcode-select -p >/dev/null 2>&1 || die "Apple's command line tools are missing. Run: xcode-select --install, then run this again."
command -v brew >/dev/null 2>&1 || die "Homebrew is missing. Install it from https://brew.sh, open a new Terminal, then run this again."

say "Tools: node, uv, ffmpeg"
for tool in node uv ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || brew install "$tool"
done
node -e 'process.exit(parseInt(process.versions.node, 10) < 20 ? 1 : 0)' || die "Node 20 or newer is needed: brew upgrade node"

say "LaTeX, for equations"
PATH="/Library/TeX/texbin:$PATH"
if ! command -v tlmgr >/dev/null 2>&1; then
  brew install --cask basictex  # asks for your password
fi
# Only the packages that are missing, so a re-run does not ask for the password again.
# MacTeX already has all of them.
TEX_PACKAGES="dvisvgm standalone preview babel-english doublestroke setspace tipa relsize rsfs calligra fundus-calligra wasysym wasy ragged2e physics xcolor microtype cm-super"
INSTALLED=$(tlmgr info --only-installed --data name 2>/dev/null || true)
MISSING=""
for p in $TEX_PACKAGES; do
  printf '%s\n' "$INSTALLED" | grep -qx "$p" || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  echo "Installing$MISSING (asks for your password)"
  sudo tlmgr update --self
  # shellcheck disable=SC2086
  sudo tlmgr install $MISSING
fi

say "Python environment: manimgl and Kokoro, in .venv"
# Keep the Japanese voices once they are installed: `uv sync` removes what it was not asked for.
EXTRA=""
if [ "$1" = --japanese ] || { [ -x .venv/bin/python ] && .venv/bin/python -c 'import pyopenjtalk' 2>/dev/null; }; then
  EXTRA="--group japanese"
fi
# shellcheck disable=SC2086
uv sync $EXTRA
[ -z "$EXTRA" ] || .venv/bin/python -m unidic download

say "Dashboard: npm packages and the page"
(cd tts-studio && npm install --no-audit --no-fund && npm run build)

say "Voice: downloading the model (about 350 MB, once) and speaking a test sentence"
.venv/bin/python tts-studio/engine/kokoro_engine.py warmup

say "Rendering a test equation"
OUT=$(mktemp -d)
.venv/bin/manimgl video/smoke/smoke_scene.py SmokeTex -w -l --video_dir "$OUT" >"$OUT/log" 2>&1 \
  || { tail -20 "$OUT/log" >&2; die "The test render failed. If it names a missing .sty file, run: sudo tlmgr install <name>, then run this again."; }
rm -rf "$OUT"

for old in tts-studio/.venv video/.venv; do
  if [ -d "$old" ]; then printf '\nThe old environment %s is no longer used; delete it with: rm -rf %s\n' "$old" "$REPO/$old"; fi
done
command -v claude >/dev/null 2>&1 || printf '\nClaude Code is not installed. Install it (npm install -g @anthropic-ai/claude-code, then run claude once to sign in), or choose another writer in Settings.\n'

printf '\nDone. Start it with:\n    cd %s/tts-studio && npm start\nthen open http://localhost:8787\n' "$REPO"
