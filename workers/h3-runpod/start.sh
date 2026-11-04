#!/usr/bin/env bash
# Pod entrypoint: bring up ComfyUI, then the studio job server.
# COMFY_CMD is how ComfyUI starts in your image; the default assumes the
# usual /workspace/ComfyUI checkout. Models are read from the network volume.
set -euo pipefail

: "${COMFY_PORT:=8188}"
: "${COMFY_CMD:=python3 /workspace/ComfyUI/main.py --listen 127.0.0.1 --port ${COMFY_PORT}}"
: "${STUDIO_PORT:=8000}"

if [ -n "${MODELS_LINK_FROM:-}" ] && [ -n "${MODELS_LINK_TO:-}" ]; then
  # e.g. MODELS_LINK_FROM=/runpod-volume/models MODELS_LINK_TO=/workspace/ComfyUI/models
  mkdir -p "$(dirname "$MODELS_LINK_TO")"
  rm -rf "$MODELS_LINK_TO" && ln -s "$MODELS_LINK_FROM" "$MODELS_LINK_TO"
fi

echo "[start] ComfyUI: $COMFY_CMD"
bash -c "$COMFY_CMD" &
COMFY_PID=$!

cleanup() { kill "$COMFY_PID" 2>/dev/null || true; }
trap cleanup EXIT

cd /app
exec python3 -u server.py
