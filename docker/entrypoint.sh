#!/bin/sh
# /* AR: What the container runs. With no arguments it starts the dashboard; with arguments it runs
#    them instead, so `docker compose run --rm app python3 /app/video/build.py demo` works too. */
set -eu

# AR: Mesa's Vulkan loader looks for this folder and complains on every scene when it is missing.
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

cat <<'BANNER'

      ∫ Narrated Proofs, in Docker
     ───────────────────────────────
      Open  http://localhost:8787
      The voice loads in a few seconds; the header says "Kokoro ready" when it can speak.
      Sign Claude Code in once:  docker compose exec app claude
      Stop with Ctrl-C, or `docker compose down`. Your lessons stay in video/projects.

BANNER

cd /app/tts-studio
exec node server/index.js
