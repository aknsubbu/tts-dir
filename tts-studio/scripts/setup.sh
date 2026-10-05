#!/bin/sh
# Installs the local Kokoro engine into tts-studio/.venv and downloads the model.
# Needs the internet once (about 350 MB of model files, plus PyTorch). Safe to re-run.
#   scripts/setup.sh              everything except Japanese
#   scripts/setup.sh --japanese   also Japanese (a further 1 GB dictionary download)
set -e
cd "$(dirname "$0")/.."

if command -v uv >/dev/null 2>&1; then
  [ -x .venv/bin/python ] || uv venv --seed --python 3.12 .venv
  install() { uv pip install --python .venv/bin/python "$@"; }
else
  PY=""
  for c in python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(not (3, 10) <= sys.version_info[:2] <= (3, 12))'; then
      PY="$c"
      break
    fi
  done
  if [ -z "$PY" ]; then
    echo "Kokoro needs Python 3.10, 3.11 or 3.12. Install one (or install uv) and run this again." >&2
    exit 1
  fi
  [ -x .venv/bin/python ] || "$PY" -m venv .venv
  install() { .venv/bin/python -m pip install "$@"; }
fi

install -r engine/requirements.txt
if [ "$1" = "--japanese" ]; then
  install -r engine/requirements.txt "misaki[ja]"
  .venv/bin/python -m unidic download
fi

.venv/bin/python engine/kokoro_engine.py warmup
echo "Done. Start the dashboard with: npm run app"
