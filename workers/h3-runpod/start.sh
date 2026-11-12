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
# Every boot runs one download chain, one list after the other (two lists at
# once would halve both and starve a render reading the same disk): the H3
# video models, then MiniMax-H3-Image for Canvas and the director, then
# Open-H3-Regenerate-2K. download_models.sh keeps files whose size is the
# list's, resumes or refetches the rest and goes on past a failure, so a
# chain cut short (a stop, a timeout) is finished by the next boot. The
# optional lists start only when the disk has room for them plus a margin
# (a full disk would break the renders) or when they are partly there. While
# the chain runs, /app/downloads/chain.pid says so: the job server's /health
# reports it and the Studio holds pod work until it is done. Before the
# chain, the weights of models the Studio no longer runs are deleted from the
# models directory — the network volume — so their room goes to the lists
# (retired-models.txt, remove_retired_models.sh).
room_gb() { df -BG --output=avail "$1" 2>/dev/null | tail -1 | tr -dc '0-9'; }
export DOWNLOAD_STATE_DIR="${DOWNLOAD_STATE_DIR:-/app/downloads}"
fetch_list() { # dir list log label room_gb_needed first_file
  local dir="$1" list="$2" log="$3" label="$4" need="$5" first="$6"
  if [ "$need" -gt 0 ] && ! [ "$(room_gb "$dir")" -ge "$need" ] 2>/dev/null && [ ! -e "$dir/$first" ]; then
    echo "[start] skipping $label: $(room_gb "$dir") GB free under $dir, it needs about $need GB (raise RUNPOD_CONTAINER_DISK_GB or use a bigger volume)"
    echo "skipped $list" >> "$DOWNLOAD_STATE_DIR/skipped"
    return
  fi
  echo "[start] $label: fetching what is missing; see $log"
  # a list with a failed file still lets the chain go on (start.sh runs under set -e)
  bash /app/h3-runpod/download_models.sh "$dir" "/app/h3-runpod/$list" > "$log" 2>&1 || true
  echo "[start] $label: $(tail -1 "$log")"
}
fetch_models() {
  local dir="$1"
  mkdir -p "$DOWNLOAD_STATE_DIR" "$dir"
  rm -f "$DOWNLOAD_STATE_DIR/failed" "$DOWNLOAD_STATE_DIR/skipped" "$DOWNLOAD_STATE_DIR/current"
  echo "$BASHPID" > "$DOWNLOAD_STATE_DIR/chain.pid"
  bash /app/h3-runpod/remove_retired_models.sh "$dir" > /app/retired_models.log 2>&1 || true
  echo "[start] $(tail -1 /app/retired_models.log) (see /app/retired_models.log)"
  [ "${AUTO_DOWNLOAD_MODELS:-1}" = "1" ] && fetch_list "$dir" models.txt /app/download_models.log "H3 models (~68 GB)" 0 ""
  [ "${H3_IMAGE:-1}" = "1" ] && fetch_list "$dir" models-h3-image.txt /app/download_h3_image.log "MiniMax-H3-Image (+22 GB: the text encoder is the video set's)" 30 diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors
  [ "${REGEN_2K:-1}" = "1" ] && fetch_list "$dir" models-regen.txt /app/download_regen.log "Open-H3-Regenerate-2K (~21 GB)" 30 loras/open_h3_regenerate_2k_lora.safetensors
  rm -f "$DOWNLOAD_STATE_DIR/chain.pid" "$DOWNLOAD_STATE_DIR/current"
  echo "[start] model downloads finished$( [ -s "$DOWNLOAD_STATE_DIR/failed" ] && echo "; failed: $(tr '\n' ' ' < "$DOWNLOAD_STATE_DIR/failed")")"
  return 0
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
  echo "[start] downloading the models in the background (the container disk is empty at every boot)"
  (fetch_models "$MODELS_DIR") &
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
      echo "[start] the models go onto the volume at $MODELS_SRC (once; the chain below fetches them)"
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
    # Every model list, onto the volume, in the background: at every boot, so whatever an earlier boot
    # left unfinished (a stop, a timeout, a wrong size) is finished; complete files are only checked.
    # H3_IMAGE=0 / REGEN_2K=0 skip a list.
    (fetch_models "$MODELS_SRC") &
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

# The ComfyUI release the pod runs. runpod/comfyui bakes one under
# /opt/comfyui-baked (v0.35.0 in the newest image) and its own start.sh copies
# it into the workspace, upgrading a workspace whose bundle manifest differs;
# MiniMax-H3-Image's nodes need v0.45.0. The release named here replaces
# the baked core before that happens (custom nodes, models and user data are
# not touched) and the manifest says so; the image's start.sh then installs
# the exact packages that release pins (frontend, comfy-kitchen…) with torch
# held where the image has it. COMFYUI_VERSION=image runs the image's own.
: "${COMFYUI_VERSION:=v0.45.0}"
[ "$COMFYUI_VERSION" = "image" ] && COMFYUI_VERSION=""
BAKED_COMFYUI="/opt/comfyui-baked"
if [ -n "$COMFYUI_VERSION" ] && [ -f "$BAKED_COMFYUI/.runpod-bundle-version" ] \
   && ! grep -qx "COMFYUI_VERSION=$COMFYUI_VERSION" "$BAKED_COMFYUI/.runpod-bundle-version"; then
  baked_from="$(sed -n 's/^COMFYUI_VERSION=//p' "$BAKED_COMFYUI/.runpod-bundle-version")"
  src="$(mktemp -d)/ComfyUI"
  # ComfyUI's core only: the image's custom nodes, models and user data stay (rsync drops files the
  # release no longer has; without rsync a tar copy lays the release over the old core)
  copy_core() {
    if command -v rsync >/dev/null 2>&1; then
      rsync -a --delete --exclude=/.git --exclude=/custom_nodes --exclude=/models --exclude=/user \
        --exclude=/input --exclude=/output --exclude=/.runpod-bundle-version "$1/" "$2/"
    else
      (cd "$1" && tar cf - --exclude=./.git --exclude=./custom_nodes --exclude=./models --exclude=./user \
        --exclude=./input --exclude=./output .) | (cd "$2" && tar xf -)
    fi
  }
  # every step sits in the condition: under set -e a failure must not stop the boot, only skip the swap
  if git clone -q --depth 1 --branch "$COMFYUI_VERSION" https://github.com/comfyanonymous/ComfyUI "$src" 2>/app/comfyui_version.log \
     && [ -f "$src/main.py" ] && copy_core "$src" "$BAKED_COMFYUI" 2>>/app/comfyui_version.log \
     && sed -i "s/^COMFYUI_VERSION=.*/COMFYUI_VERSION=$COMFYUI_VERSION/" "$BAKED_COMFYUI/.runpod-bundle-version"; then
    echo "[start] ComfyUI $COMFYUI_VERSION in place of the image's ${baked_from:-?}"
  else
    echo "[start] could not put ComfyUI $COMFYUI_VERSION in place (/app/comfyui_version.log); running the image's ${baked_from:-?} — MiniMax-H3-Image will report missing nodes"
  fi
  rm -rf "$(dirname "$src")"
elif [ -n "$COMFYUI_VERSION" ] && [ ! -d "$BAKED_COMFYUI" ]; then
  echo "[start] this image has no $BAKED_COMFYUI: COMFYUI_VERSION=$COMFYUI_VERSION is not applied (use a runpod/comfyui image)"
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

# Titles and burned subtitles are mostly Chinese; without a CJK font the
# assembler draws boxes (and says so in the export's warnings). Fetched in the
# background so the pod is not kept waiting. FONTS_INSTALL=0 skips.
if [ "${FONTS_INSTALL:-1}" != "0" ] && ! fc-list 2>/dev/null | grep -qiE "cjk|wqy"; then
  (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends fonts-noto-cjk fontconfig) > /app/fonts_install.log 2>&1 \
    || echo "[start] CJK font install failed; Chinese titles and burned subtitles may show as boxes (see /app/fonts_install.log)" &
fi

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
