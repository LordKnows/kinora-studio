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
# Optional image models for Canvas (Qwen-Image 2.1 Turbo, and the base for LoRAs) come after the
# video models, one list after the other (they share the text encoder and VAE), each only when the
# disk has room for it plus a margin: a full disk would break the video renders.
room_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'; }
qwen_downloads() {
  local dir="$1"
  if [ "${QWEN_IMAGE:-1}" = "1" ]; then
    if [ "$(room_gb "$dir")" -ge 30 ] 2>/dev/null || [ -s "$dir/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors" ]; then
      echo "[start] Qwen-Image 2.1 Turbo for Canvas (~17 GB); see /app/download_qwen_image.log"
      bash /app/h3-runpod/download_models.sh "$dir" /app/h3-runpod/models-qwen-image.txt > /app/download_qwen_image.log 2>&1
      echo "[start] qwen image download finished: $(tail -1 /app/download_qwen_image.log)"
    else
      echo "[start] skipping Qwen-Image 2.1 Turbo: $(room_gb "$dir") GB free under $dir, it needs ~17 GB + margin (raise RUNPOD_CONTAINER_DISK_GB or use a volume)"
    fi
  fi
  if [ "${QWEN_IMAGE_BASE:-1}" = "1" ]; then
    if [ "$(room_gb "$dir")" -ge 15 ] 2>/dev/null || [ -s "$dir/diffusion_models/qwen_image_2.1_int8_convrot.safetensors" ]; then
      echo "[start] Qwen-Image 2.1 base for LoRAs (+7.3 GB); see /app/download_qwen_image_base.log"
      bash /app/h3-runpod/download_models.sh "$dir" /app/h3-runpod/models-qwen-image-base.txt > /app/download_qwen_image_base.log 2>&1
      echo "[start] qwen image base download finished: $(tail -1 /app/download_qwen_image_base.log)"
    else
      echo "[start] skipping Qwen-Image 2.1 base: $(room_gb "$dir") GB free under $dir, it needs ~7.3 GB + margin"
    fi
  fi
  if [ "${QWEN_EDIT_2509:-1}" = "1" ]; then
    if [ "$(room_gb "$dir")" -ge 40 ] 2>/dev/null || [ -s "$dir/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors" ]; then
      echo "[start] Qwen-Image-Edit 2509 + Lightning for Canvas (~31 GB); see /app/download_qie2509.log"
      bash /app/h3-runpod/download_models.sh "$dir" /app/h3-runpod/models-qie2509.txt > /app/download_qie2509.log 2>&1
      echo "[start] qwen edit 2509 download finished: $(tail -1 /app/download_qie2509.log)"
    else
      echo "[start] skipping Qwen-Image-Edit 2509: $(room_gb "$dir") GB free under $dir, it needs ~31 GB + margin (raise RUNPOD_CONTAINER_DISK_GB or use a volume)"
    fi
  fi
}
# No volume mounted (local-disk mode): the models live on the container disk
# under the image's own models/ and are downloaded at every boot (aria2, 16
# connections). The job server reports models.ready=false until the set is
# complete, so the studio holds the pod in "starting" meanwhile.
if [ "$VOLUME_PATH" != "/workspace" ] && ! mountpoint -q "$VOLUME_PATH" 2>/dev/null && [ -z "$(ls -A "$VOLUME_PATH" 2>/dev/null)" ]; then
  echo "[start] no volume at $VOLUME_PATH: local-disk mode, models go to $SLIM_DIR/models"
  export MODELS_DIR="$SLIM_DIR/models"
  export LORA_DIR="${LORA_DIR:-$SLIM_DIR/models/loras}"
  mkdir -p "$MODELS_DIR"
  if [ "${AUTO_DOWNLOAD_MODELS:-1}" = "1" ]; then
    echo "[start] downloading the H3 models (~68 GB) in the background; see /app/download_models.log"
    (
      bash /app/h3-runpod/download_models.sh "$MODELS_DIR" > /app/download_models.log 2>&1
      echo "[start] model download finished: $(tail -1 /app/download_models.log)"
      if [ "${REGEN_2K:-1}" = "1" ]; then
        echo "[start] downloading Open-H3-Regenerate-2K (~21 GB); see /app/download_regen.log"
        bash /app/h3-runpod/download_models.sh "$MODELS_DIR" /app/h3-runpod/models-regen.txt > /app/download_regen.log 2>&1
        echo "[start] regen download finished: $(tail -1 /app/download_regen.log)"
      fi
      qwen_downloads "$MODELS_DIR"
    ) &
  fi
  DOWNLOAD_MODELS=0
  VOLUME_PATH=/workspace
fi
if [ "$VOLUME_PATH" != "/workspace" ] && [ -d "$VOLUME_PATH" ]; then
  # A models directory counts only if it holds weights: an earlier pod may
  # have left an empty ComfyUI tree on the volume.
  has_weights() { [ -n "$(find "$1" -maxdepth 2 -name '*.safetensors' -size +100M -print -quit 2>/dev/null)" ]; }
  MODELS_SRC=""
  for cand in "$VOLUME_PATH/runpod-slim/ComfyUI/models" "$VOLUME_PATH/ComfyUI/models" "$VOLUME_PATH/models"; do
    if [ -d "$cand" ] && has_weights "$cand"; then MODELS_SRC="$cand"; break; fi
  done
  if [ -z "$MODELS_SRC" ]; then
    # Anywhere else on the volume: a directory that has a unet/diffusion_models child with weights.
    for d in $(find "$VOLUME_PATH" -maxdepth 6 -type d \( -name unet -o -name diffusion_models \) 2>/dev/null); do
      if has_weights "$d"; then MODELS_SRC="$(dirname "$d")"; break; fi
    done
  fi
  if [ -z "$MODELS_SRC" ]; then
    echo "[start] no H3 weights found on the volume at $VOLUME_PATH; large files there:"
    find "$VOLUME_PATH" -type f -size +500M -printf '  %s\t%p\n' 2>/dev/null | head -20
    if [ "${AUTO_DOWNLOAD_MODELS:-1}" = "1" ]; then
      for cand in "$VOLUME_PATH/runpod-slim/ComfyUI/models" "$VOLUME_PATH/models"; do
        if [ -d "$cand" ]; then MODELS_SRC="$cand"; break; fi
      done
      MODELS_SRC="${MODELS_SRC:-$VOLUME_PATH/models}"
      mkdir -p "$MODELS_SRC"
      echo "[start] downloading the H3 models (~68 GB, once) into $MODELS_SRC in the background; the pod reports models.ready=false until they are all there"
      (bash /app/h3-runpod/download_models.sh "$MODELS_SRC" > /app/download_models.log 2>&1; echo "[start] model download finished: $(tail -1 /app/download_models.log)") &
      DOWNLOAD_MODELS=0
    fi
  fi
  if [ -n "$MODELS_SRC" ]; then
    echo "[start] models come from the volume: $MODELS_SRC"
    # Link per sub-folder, not the whole models/ directory: ComfyUI expects
    # its full set of standard sub-folders (vae_approx, checkpoints, …) and
    # the volume only carries the H3 ones. The image's own models/ keeps the
    # standard layout; each folder the volume has replaces the local one.
    # unet and diffusion_models are the same folder type to ComfyUI.
    link_models() {
      mkdir -p "$SLIM_DIR/models"
      for std in checkpoints clip clip_vision configs controlnet diffusers diffusion_models embeddings gligen hypernetworks loras photomaker style_models text_encoders unet upscale_models vae vae_approx audio_encoders model_patches; do
        [ -e "$SLIM_DIR/models/$std" ] || mkdir -p "$SLIM_DIR/models/$std"
      done
      for src in "$MODELS_SRC"/*/; do
        [ -d "$src" ] || continue
        sub="$(basename "$src")"
        dst="$SLIM_DIR/models/$sub"
        if [ -L "$dst" ] && [ "$(readlink "$dst")" = "${src%/}" ]; then continue; fi
        if [ -L "$dst" ]; then unlink "$dst"; elif [ -d "$dst" ]; then mv "$dst" "$dst.local.$(date +%s)"; fi
        ln -s "${src%/}" "$dst" && echo "[start] linked models/$sub -> ${src%/}"
      done
      if [ -d "$MODELS_SRC/diffusion_models" ] && [ ! -d "$MODELS_SRC/unet" ]; then
        dst="$SLIM_DIR/models/unet"
        if [ ! -L "$dst" ]; then [ -d "$dst" ] && mv "$dst" "$dst.local.$(date +%s)"; ln -s "$MODELS_SRC/diffusion_models" "$dst"; fi
      fi
    }
    link_models
    # Belt and braces: ComfyUI also learns the path from extra_model_paths.yaml.
    cat > "$SLIM_DIR/extra_model_paths.yaml" <<YAML
studio_volume:
  base_path: $MODELS_SRC
  diffusion_models: diffusion_models
  unet: unet
  text_encoders: text_encoders
  vae: vae
  loras: loras
YAML
    export MODELS_DIR="$MODELS_SRC"
    export LORA_DIR="${LORA_DIR:-$MODELS_SRC/loras}"
    if [ "${REGEN_2K:-1}" = "1" ] && [ ! -s "$MODELS_SRC/loras/open_h3_regenerate_2k_lora.safetensors" ]; then
      echo "[start] downloading Open-H3-Regenerate-2K (~21 GB) onto the volume in the background; see /app/download_regen.log"
      (bash /app/h3-runpod/download_models.sh "$MODELS_SRC" /app/h3-runpod/models-regen.txt > /app/download_regen.log 2>&1; echo "[start] regen download finished: $(tail -1 /app/download_regen.log)") &
    fi
    # Qwen-Image 2.1 Turbo and base, Qwen-Image-Edit 2509 (Canvas, drawn by the pod's painter through
    # ComfyUI): once, onto the volume, in the background (files already there are skipped). The painter
    # advertises a model only when every file is there. QWEN_IMAGE=0 / QWEN_IMAGE_BASE=0 / QWEN_EDIT_2509=0 skip them.
    if [ "${QWEN_IMAGE:-1}" = "1" ] || [ "${QWEN_IMAGE_BASE:-1}" = "1" ] || [ "${QWEN_EDIT_2509:-1}" = "1" ]; then
      (qwen_downloads "$MODELS_SRC") &
    fi
    # The image's installer may replace models/ while it copies ComfyUI in;
    # keep re-applying the links. ComfyUI re-reads a folder whose mtime
    # changed, so a late link is picked up without a restart.
    (
      while true; do
        link_models >/dev/null 2>&1 || true
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

# Open-H3-Regenerate-2K node packs (rdh9616's nodes + LBH-123-AI's latent
# upscaler). The container disk is fresh at every boot, so they are cloned
# each time (a few MB); the image's installer keeps custom_nodes/ untouched.
# Their Python deps go to the system site-packages, which the image's venv
# sees. REGEN_2K=0 skips all of it.
if [ "${REGEN_2K:-1}" = "1" ]; then
  NODES_DIR="$SLIM_DIR/custom_nodes"
  mkdir -p "$NODES_DIR"
  for repo in https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler; do
    name="$(basename "$repo")"
    if [ ! -d "$NODES_DIR/$name" ]; then
      echo "[start] installing node pack $name"
      git clone -q --depth 1 "$repo" "$NODES_DIR/$name" || echo "[start] clone of $name failed; Regenerate 2K will report not ready"
    fi
    if [ -f "$NODES_DIR/$name/requirements.txt" ]; then
      python3 -m pip install -q -r "$NODES_DIR/$name/requirements.txt" >/dev/null 2>&1 || echo "[start] pip install for $name failed"
    fi
  done
  export REGEN_NODE_DIR="$NODES_DIR/ComfyUI-Open-H3-Regenerate"
  # Our own helper nodes (ship with the job server).
  mkdir -p "$NODES_DIR/studio_nodes" && cp /app/h3-runpod/studio_nodes/__init__.py "$NODES_DIR/studio_nodes/__init__.py"
  export COMFY_OUTPUT_DIR="$SLIM_DIR/output"
fi

# Viggle Remake node pack (Apache-2.0, two small files from the model repo).
# ComfyUI loads custom nodes at startup only, so it goes in before ComfyUI
# starts; the models themselves are fetched on demand (POST /remake/install).
if [ "${REMAKE_NODES:-1}" = "1" ]; then
  RNODES="$SLIM_DIR/custom_nodes/ComfyUI-Viggle-Remake"
  mkdir -p "$RNODES"
  for f in __init__.py nodes.py; do
    curl -fsSL -A Mozilla/5.0 -o "$RNODES/$f.part" "https://huggingface.co/Viggle/Viggle-Remake/resolve/main/comfyui/ComfyUI-Viggle-Remake/$f" && mv "$RNODES/$f.part" "$RNODES/$f" || echo "[start] Remake node $f not fetched; Remake will report not ready"
  done
  export REMAKE_NODE_DIR="$RNODES"
fi

# The pod is also the fallback painter (painter.py, started by server.py):
# while it runs it claims the Studio's image jobs like any painter. Pictures
# are normally drawn on a painter elsewhere (workers/painter), before the pod
# is started; PAINTER_ON_POD=0 turns this off. paint.py needs Pillow.
python3 -c "import PIL" 2>/dev/null || python3 -m pip install -q pillow >/dev/null 2>&1 || echo "[start] pip install pillow failed; the pod cannot draw pictures"

# The Codex CLI draws with the user's ChatGPT plan (image_gen). The binaries
# and the login live on the network volume ($VOLUME_PATH, the same place the
# models come from), so the device-code login is done once and a refreshed
# token survives a new pod. Codex runs its tools through a separate helper,
# codex-code-mode-host, released as its own archive and looked up next to the
# codex binary: both are installed into one bin/. CODEX_INSTALL=0 skips.
if [ "${CODEX_INSTALL:-1}" = "1" ]; then
  CROOT="${CODEX_ROOT:-${VOLUME_PATH:-/workspace}/codex}"
  mkdir -p "$CROOT/bin" "$CROOT/home" 2>/dev/null || { CROOT="/root/codex"; mkdir -p "$CROOT/bin" "$CROOT/home"; }
  bash /app/h3-runpod/install_codex.sh "$CROOT/bin" > /app/codex_install.log 2>&1 || echo "[start] Codex CLI install failed; see /app/codex_install.log"
  export CODEX_BIN="$CROOT/bin/codex"
  export CODEX_HOME_MASTER="$CROOT/home"
  export PATH="$CROOT/bin:$PATH"
  echo "[start] Codex at $CROOT ($(tail -1 /app/codex_install.log 2>/dev/null))"
fi

echo "[start] ComfyUI: $COMFY_CMD"
bash -c "$COMFY_CMD" &
COMFY_PID=$!

cleanup() { kill "$COMFY_PID" 2>/dev/null || true; }
trap cleanup EXIT

cd "$(dirname "$0")"
exec python3 -u server.py
