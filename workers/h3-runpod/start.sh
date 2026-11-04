#!/usr/bin/env bash
# Pod entrypoint: bring up ComfyUI, then the studio job server.
# COMFY_CMD is how ComfyUI starts in your image; the default assumes the
# usual /workspace/ComfyUI checkout. Models are read from the network volume.
set -euo pipefail

: "${COMFY_PORT:=8188}"
: "${COMFY_CMD:=}"
if [ -z "$COMFY_CMD" ]; then
  # runpod/comfyui images bring their own entrypoint that starts ComfyUI (and Jupyter); use it when present.
  if [ -x /start.sh ]; then COMFY_CMD="/start.sh"; else COMFY_CMD="python3 /workspace/ComfyUI/main.py --listen 127.0.0.1 --port ${COMFY_PORT}"; fi
fi
# The stock runpod/comfyui image keeps its ComfyUI on the volume at
# /workspace/runpod-slim/ComfyUI with a virtualenv whose name is baked into
# the image (.venv-cu128 even on the CUDA 13.0 tag). A volume filled by
# another pod, or copied without dot-files, may carry the install but not
# that venv, and the image's start.sh then holds the pod. Point it at a venv
# that does exist, or create one the way the image does (system site
# packages hold torch and ComfyUI's requirements).
SLIM_DIR="${COMFYUI_SLIM_DIR:-/workspace/runpod-slim/ComfyUI}"
if [ -d "$SLIM_DIR" ]; then
  VENV_NAME="${COMFYUI_VENV_NAME:-.venv-cu128}"
  if [ ! -f "$SLIM_DIR/$VENV_NAME/bin/activate" ]; then
    found=""
    for v in "$SLIM_DIR"/.venv-cu* "$SLIM_DIR"/.venv; do
      if [ -f "$v/bin/activate" ]; then found="$v"; break; fi
    done
    if [ -n "$found" ]; then
      export COMFYUI_VENV_NAME="$(basename "$found")"
      echo "[start] image venv $VENV_NAME is missing; using $COMFYUI_VENV_NAME"
    else
      echo "[start] no venv under $SLIM_DIR; creating $VENV_NAME"
      py="$(command -v python3.12 || command -v python3)"
      [ -d "$SLIM_DIR/$VENV_NAME" ] && mv "$SLIM_DIR/$VENV_NAME" "$SLIM_DIR/$VENV_NAME.broken.$(date +%s)"
      "$py" -m venv --system-site-packages --without-pip "$SLIM_DIR/$VENV_NAME" || echo "[start] venv creation failed; ComfyUI may not start"
    fi
  fi
  # Models live inside that install on this image.
  [ -z "${MODELS_DIR:-}" ] && [ -d "$SLIM_DIR/models" ] && export MODELS_DIR="$SLIM_DIR/models"
  [ -z "${LORA_DIR:-}" ] && [ -d "$SLIM_DIR/models/loras" ] && export LORA_DIR="$SLIM_DIR/models/loras"
fi
if [ "${DOWNLOAD_MODELS:-0}" = "1" ]; then bash /app/download_models.sh "${MODELS_DIR:-/workspace/ComfyUI/models}"; fi
: "${STUDIO_PORT:=8000}"

# Models on a network volume: either symlink the ComfyUI models dir to the
# volume (default) or copy the files onto the pod's local disk first
# (MODELS_COPY=1) — worth it when the volume is remote (a global volume read
# across regions) and the base-model reloads between T2VA and R2VA are slow.
if [ -n "${MODELS_LINK_FROM:-}" ] && [ -n "${MODELS_LINK_TO:-}" ]; then
  if [ "${MODELS_COPY:-0}" = "1" ]; then
    echo "[start] copying models from $MODELS_LINK_FROM to $MODELS_LINK_TO"
    mkdir -p "$MODELS_LINK_TO"
    # rsync keeps a partial copy usable across restarts; falls back to cp.
    (command -v rsync >/dev/null && rsync -a --info=progress2 "$MODELS_LINK_FROM"/ "$MODELS_LINK_TO"/) || cp -an "$MODELS_LINK_FROM"/. "$MODELS_LINK_TO"/
  else
    mkdir -p "$(dirname "$MODELS_LINK_TO")"
    rm -rf "$MODELS_LINK_TO" && ln -s "$MODELS_LINK_FROM" "$MODELS_LINK_TO"
  fi
fi

echo "[start] ComfyUI: $COMFY_CMD"
bash -c "$COMFY_CMD" &
COMFY_PID=$!

cleanup() { kill "$COMFY_PID" 2>/dev/null || true; }
trap cleanup EXIT

cd "$(dirname "$0")"
exec python3 -u server.py
