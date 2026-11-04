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
SLIM_DIR="${COMFYUI_SLIM_DIR:-/workspace/runpod-slim/ComfyUI}"

# The stock runpod/comfyui image installs ComfyUI and its virtualenv under
# /workspace. A *global* network volume cannot hold that venv (it lacks the
# file permissions a venv needs), so the volume is mounted elsewhere
# (STUDIO_VOLUME_PATH, default /runpod-volume) and only lends its models:
# ComfyUI and the venv go on the container disk, and models/ is a symlink
# into the volume. The directory is created before the image's start.sh
# runs because its sync skips /models and /extra_model_paths.yaml.
VOLUME_PATH="${STUDIO_VOLUME_PATH:-/workspace}"
if [ "$VOLUME_PATH" != "/workspace" ] && [ -d "$VOLUME_PATH" ]; then
  MODELS_SRC=""
  for cand in "$VOLUME_PATH/runpod-slim/ComfyUI/models" "$VOLUME_PATH/ComfyUI/models" "$VOLUME_PATH/models"; do
    if [ -d "$cand" ]; then MODELS_SRC="$cand"; break; fi
  done
  if [ -z "$MODELS_SRC" ] && [ "${DOWNLOAD_MODELS:-0}" = "1" ]; then
    MODELS_SRC="$VOLUME_PATH/models"
    mkdir -p "$MODELS_SRC"
  fi
  if [ -n "$MODELS_SRC" ]; then
    echo "[start] models come from the volume: $MODELS_SRC"
    mkdir -p "$SLIM_DIR"
    if [ -L "$SLIM_DIR/models" ]; then rm -f "$SLIM_DIR/models"; elif [ -d "$SLIM_DIR/models" ]; then mv "$SLIM_DIR/models" "$SLIM_DIR/models.local.$(date +%s)"; fi
    ln -s "$MODELS_SRC" "$SLIM_DIR/models"
    # Belt and braces: ComfyUI also learns the path from extra_model_paths.yaml.
    cat > "$SLIM_DIR/extra_model_paths.yaml" <<YAML
studio_volume:
  base_path: $MODELS_SRC
  unet: unet
  diffusion_models: unet
  text_encoders: text_encoders
  vae: vae
  loras: loras
YAML
    export MODELS_DIR="$MODELS_SRC"
    export LORA_DIR="${LORA_DIR:-$MODELS_SRC/loras}"
    # The image's installer may replace the pre-made directory (and the
    # symlink in it) while it copies ComfyUI in. Keep re-pointing models/ at
    # the volume: ComfyUI re-reads a model folder whose mtime changed, so a
    # late link is picked up without a restart.
    (
      while true; do
        if [ -d "$SLIM_DIR" ] && [ ! -L "$SLIM_DIR/models" ]; then
          if [ -d "$SLIM_DIR/models" ]; then mv "$SLIM_DIR/models" "$SLIM_DIR/models.local.$(date +%s)"; fi
          ln -s "$MODELS_SRC" "$SLIM_DIR/models" && echo "[start] re-linked $SLIM_DIR/models -> $MODELS_SRC"
        fi
        sleep 10
      done
    ) &
  else
    echo "[start] the volume at $VOLUME_PATH has no models directory (looked for runpod-slim/ComfyUI/models, ComfyUI/models, models); set DOWNLOAD_MODELS=1 to fill it"
  fi
fi

# With the volume on /workspace (a regular network volume, the image's own
# layout) the install may carry a venv under another name, or none: the
# image's start.sh hardcodes .venv-cu128 and holds the pod when it is
# missing. Point it at a venv that does exist, or create one the way the
# image does (system site packages hold torch and ComfyUI's requirements).
if [ -d "$SLIM_DIR" ] && [ -f "$SLIM_DIR/main.py" ]; then
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
      "$py" -m venv --system-site-packages --without-pip "$SLIM_DIR/$VENV_NAME" || echo "[start] venv creation failed (a global volume cannot hold one: mount it away from /workspace); ComfyUI may not start"
    fi
  fi
  # Models live inside that install on this image.
  [ -z "${MODELS_DIR:-}" ] && [ -d "$SLIM_DIR/models" ] && export MODELS_DIR="$SLIM_DIR/models"
  [ -z "${LORA_DIR:-}" ] && [ -d "$SLIM_DIR/models/loras" ] && export LORA_DIR="$SLIM_DIR/models/loras"
fi
if [ "${DOWNLOAD_MODELS:-0}" = "1" ]; then bash /app/download_models.sh "${MODELS_DIR:-$SLIM_DIR/models}"; fi
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
