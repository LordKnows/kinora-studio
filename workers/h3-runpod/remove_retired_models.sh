#!/usr/bin/env bash
# Delete the weights of models the Studio no longer runs from a ComfyUI models
# directory (the network volume, or the container disk in local-disk mode).
#
# The list (ComfyUI subdir<TAB>file name) is retired-models.txt. Run at every
# boot before the download chain: a file that is there is removed, with what a
# cut-off download left beside it (.part, .part.aria2); a file that is not
# there costs nothing. A file one of the download lists (models*.txt) still
# names is kept whatever the retired list says, and so is a name that is not a
# plain file name. Prints one line per file removed and the room freed.
set -uo pipefail
MODELS_DIR="${1:-/workspace/runpod-slim/ComfyUI/models}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="${2:-$HERE/retired-models.txt}"
[ -f "$LIST" ] || { echo "no retired list at $LIST"; exit 0; }

# the names the pod still downloads: never removed
wanted="$(cat "$HERE"/models*.txt 2>/dev/null | grep -v '^#' | cut -f2 | sed 's#.*/##' | tr -d '\r ')"
size_of() { stat -c %s "$1" 2>/dev/null || echo 0; }
freed=0
removed=0

while IFS=$'\t' read -r subdir name || [ -n "${subdir:-}" ]; do
  [[ -z "${subdir:-}" || "$subdir" == \#* ]] && continue
  subdir="$(echo "$subdir" | tr -d '\r ')"
  name="$(echo "${name:-}" | tr -d '\r ')"
  if ! [[ "$subdir" =~ ^[A-Za-z0-9_]+$ && "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "skipping $subdir/$name: not a models subdir and a plain file name"
    continue
  fi
  if grep -qxF "$name" <<< "$wanted"; then
    echo "keeping $subdir/$name: a download list still names it"
    continue
  fi
  # unet and diffusion_models are the same folder type to ComfyUI (one is often a link to the other)
  dirs=("$subdir")
  [ "$subdir" = "diffusion_models" ] && dirs+=("unet")
  for d in "${dirs[@]}"; do
    for file in "$MODELS_DIR/$d/$name" "$MODELS_DIR/$d/$name.part" "$MODELS_DIR/$d/$name.part.aria2"; do
      [ -f "$file" ] || continue
      size="$(size_of "$file")"
      if rm -f "$file"; then
        freed=$((freed + size)); removed=$((removed + 1))
        echo "removed $file ($((size / 1048576)) MB)"
      else
        echo "could not remove $file"
      fi
    done
  done
done < "$LIST"
echo "retired models: $removed files removed, $((freed / 1048576)) MB freed"
