# syntax=docker/dockerfile:1.7
# /* AR: Narrated Proofs in one Linux image, so Windows (and any Docker host) needs no setup:
#    `docker compose up` and open http://localhost:8787. Three stages:
#      web      builds the page and installs the server's packages
#      python   the two Python environments (Kokoro on the CPU, ManimGL) and the voice model
#      runtime  what runs: Node, both environments, TeX, ffmpeg, and Mesa's CPU Vulkan driver
#    ManimGL draws through wgpu. With no GPU in the container wgpu finds lavapipe, Mesa's
#    Vulkan on the CPU, so scenes render headless and no display or GPU passthrough is needed. */

ARG PYTHON_IMAGE=python:3.12-slim-trixie
ARG NODE_IMAGE=node:22-trixie-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.18

FROM ${UV_IMAGE} AS uv

# ---------- the page and the server's packages ----------
FROM ${NODE_IMAGE} AS web
# AR: better-sqlite3 compiles itself when no prebuilt binary matches this Node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/tts-studio
COPY tts-studio/package.json tts-studio/package-lock.json ./
RUN npm ci
COPY tts-studio/ ./
RUN npm run build && npm prune --omit=dev

# ---------- the two Python environments ----------
FROM ${PYTHON_IMAGE} AS python
# AR: manimpango has no Linux wheel, so it is compiled here; only its result reaches the runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config libpango1.0-dev git \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PYTHON_PREFERENCE=only-system \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    HF_HOME=/opt/huggingface

# /* AR: The voice. PyTorch for the CPU goes in first, so kokoro does not pull the 2 GB CUDA build.
#    --seed gives the venv pip, which misaki uses to fetch its English model during the warmup. */
COPY tts-studio/engine/requirements.txt /tmp/engine-requirements.txt
RUN uv venv --seed /opt/kokoro \
    && uv pip install --python /opt/kokoro/bin/python --index-url https://download.pytorch.org/whl/cpu torch \
    && uv pip install --python /opt/kokoro/bin/python -r /tmp/engine-requirements.txt

# AR: The renderer, kept apart from the voice's so PyTorch never loads while rendering (as on macOS).
COPY video/requirements.txt /tmp/video-requirements.txt
RUN uv venv /opt/manim \
    && uv pip install --python /opt/manim/bin/python -r /tmp/video-requirements.txt

# AR: The model and voices (about 350 MB) are baked in, so the first run is offline and instant.
COPY tts-studio/engine/ /tmp/engine/
RUN /opt/kokoro/bin/python /tmp/engine/kokoro_engine.py warmup

# ---------- what runs ----------
FROM ${PYTHON_IMAGE} AS runtime

# /* AR: What rendering and notes need from the system:
#      ffmpeg                         joins scenes, captions, posters
#      libvulkan1 mesa-vulkan-drivers lavapipe, the CPU Vulkan wgpu draws with
#      libgl1 libegl1                 the window libraries glfw loads when manim imports it
#      pango, cairo, fonts            Text() in scenes
#      poppler-utils                  PDF pages and text in notes (pdf.js)
#      libvips-tools pandoc catdoc    photos and documents in notes, in place of macOS's sips and textutil
#      perl wget xz-utils             the TeX Live installer below
#      tini                           PID 1, so stopping the container stops builds cleanly */
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg libvulkan1 mesa-vulkan-drivers libgl1 libegl1 \
        libpango-1.0-0 libpangocairo-1.0-0 libcairo2 fontconfig fonts-dejavu-core \
        poppler-utils libvips-tools pandoc catdoc \
        perl wget xz-utils ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# AR: TeX Live, as small as the macOS install (see the script for what and why).
ARG TEXLIVE_REPO=https://mirror.ctan.org/systems/texlive/tlnet
COPY docker/install-texlive.sh /tmp/install-texlive.sh
RUN sh /tmp/install-texlive.sh "${TEXLIVE_REPO}" && rm /tmp/install-texlive.sh

# AR: Node from the web stage, and Claude Code, the default lesson writer (sign in once: see README).
ARG CLAUDE_CODE_VERSION=latest
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

RUN useradd --create-home --uid 1000 app
COPY --from=python /opt/kokoro /opt/kokoro
COPY --from=python /opt/manim /opt/manim
COPY --from=python --chown=app:app /opt/huggingface /opt/huggingface
COPY --from=web --chown=app:app /app/tts-studio /app/tts-studio
COPY --chown=app:app video/ /app/video/
COPY --chown=app:app tts.py /app/tts.py
COPY docker/entrypoint.sh /usr/local/bin/narrated-proofs
RUN chmod 755 /usr/local/bin/narrated-proofs \
    && mkdir -p /app/tts-studio/data /cache /home/app/.claude \
    && chown app:app /app/tts-studio/data /cache /home/app/.claude

# /* AR: Every path the server and build.py would look for under tts-studio/.venv and video/.venv
#    on macOS, pointed at the environments above. TTS_HOST is 0.0.0.0 because the container's
#    loopback is its own; docker-compose.yml publishes the port on the host's 127.0.0.1 only. */
ENV TTS_HOST=0.0.0.0 \
    PORT=8787 \
    TTS_PYTHON=/opt/kokoro/bin/python \
    KOKORO_PYTHON=/opt/kokoro/bin/python \
    MANIMGL=/opt/manim/bin/manimgl \
    HF_HOME=/opt/huggingface \
    TTS_DATA_DIR=/app/tts-studio/data \
    VIDEO_SCENE_CACHE=/cache/scenes \
    CLAUDE_CONFIG_DIR=/home/app/.claude \
    XDG_RUNTIME_DIR=/tmp/runtime-app \
    PYTHONUNBUFFERED=1

USER app
WORKDIR /app/tts-studio
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["tini", "--", "narrated-proofs"]
