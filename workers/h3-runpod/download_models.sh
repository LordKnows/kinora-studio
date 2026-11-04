#!/usr/bin/env bash
# Fetch the H3 models into a ComfyUI models directory (default /workspace/ComfyUI/models).
# Idempotent: skips files that already exist with the expected size header.
set -euo pipefail
MODELS_DIR="${1:-/workspace/runpod-slim/ComfyUI/models}"
HERE="$(cd "$(dirname "$0")" && pwd)"
AUTH=()
[ -n "${HF_TOKEN:-}" ] && AUTH=(--header "Authorization: Bearer ${HF_TOKEN}")
while IFS=$'\t' read -r subdir url; do
  [[ -z "$subdir" || "$subdir" == \#* ]] && continue
  dir="$MODELS_DIR/$subdir"; mkdir -p "$dir"
  file="$dir/$(basename "$url")"
  if [ -s "$file" ]; then echo "have $file"; continue; fi
  echo "fetching $url"
  if command -v wget >/dev/null 2>&1; then
    wget -c --user-agent="Mozilla/5.0" "${AUTH[@]}" -O "$file.part" "$url" && mv "$file.part" "$file"
  else
    curl -fL -C - -A "Mozilla/5.0" "${AUTH[@]/#--header/-H}" -o "$file.part" "$url" && mv "$file.part" "$file"
  fi
done < "$HERE/models.txt"
# the runpod/comfyui image reads diffusion models from models/unet
if [ -d "$MODELS_DIR/diffusion_models" ] && [ ! -e "$MODELS_DIR/unet" ]; then ln -s "$MODELS_DIR/diffusion_models" "$MODELS_DIR/unet"; fi
echo done
