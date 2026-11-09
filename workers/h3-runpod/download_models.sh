#!/usr/bin/env bash
# Fetch the models of one list (subdir<TAB>URL<TAB>bytes) into a ComfyUI models directory.
#
# Run at every boot, so it must be cheap when everything is there and must
# finish what an earlier boot left: a file whose size is the list's is kept;
# a wrong size is fetched again (a shorter file is resumed); a missing one is
# fetched (aria2, 16 connections, a .part file renamed when complete). One
# file that fails does not stop the others: each is retried, then logged as
# failed and the list goes on. The exit status says whether all are there.
#
# What it is doing goes to $DOWNLOAD_STATE_DIR (default /app/downloads) so the
# job server's /health can say it: "current" (the file being fetched) and
# "failed" (one line per file that did not come down).
set -uo pipefail
MODELS_DIR="${1:-/workspace/runpod-slim/ComfyUI/models}"
HERE="$(cd "$(dirname "$0")" && pwd)"
LIST="${2:-$HERE/models.txt}"
STATE="${DOWNLOAD_STATE_DIR:-/app/downloads}"
TRIES="${DOWNLOAD_TRIES:-3}"
mkdir -p "$STATE" 2>/dev/null || STATE="$(mktemp -d)"
AUTH=()
[ -n "${HF_TOKEN:-}" ] && AUTH=(--header "Authorization: Bearer ${HF_TOKEN}")
name_of_list="$(basename "$LIST")"
failures=0

size_of() { stat -c %s "$1" 2>/dev/null || echo 0; }

fetch_once() { # url dir name
  if command -v aria2c >/dev/null 2>&1; then
    # 16 connections per file: HuggingFace serves large files far faster this way; bounded waits so a stalled
    # connection fails and is retried instead of hanging the list
    aria2c -q -c -x16 -s16 -k1M --file-allocation=none --timeout=60 --connect-timeout=30 --max-tries=5 --retry-wait=5 \
      --user-agent="Mozilla/5.0" "${AUTH[@]}" -d "$2" -o "$3.part" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -c --timeout=60 --tries=5 --user-agent="Mozilla/5.0" "${AUTH[@]}" -O "$2/$3.part" "$1"
  else
    curl -sfL -C - --connect-timeout 30 --retry 5 -A "Mozilla/5.0" "${AUTH[@]/#--header/-H}" -o "$2/$3.part" "$1"
  fi
}

while IFS=$'\t' read -r subdir url want || [ -n "${subdir:-}" ]; do
  [[ -z "${subdir:-}" || "$subdir" == \#* ]] && continue
  url="$(echo "$url" | tr -d '\r ')"
  want="$(echo "${want:-}" | tr -dc '0-9')"
  dir="$MODELS_DIR/$subdir"; mkdir -p "$dir"
  name="$(basename "$url")"
  file="$dir/$name"
  have="$(size_of "$file")"
  if [ -f "$file" ] && { [ -n "$want" ] && [ "$have" = "$want" ] || { [ -z "$want" ] && [ "$have" -gt 0 ]; }; }; then
    echo "have $file"
    continue
  fi
  if [ -f "$file" ]; then
    # a wrong size: resume a shorter file, start again from a longer one
    if [ -n "$want" ] && [ "$have" -lt "$want" ]; then mv -f "$file" "$file.part"; else rm -f "$file"; fi
    echo "size $have, want ${want:-?}: fetching $name again"
  fi
  echo "fetching $url"
  echo "$name_of_list $name ${want:-0}" > "$STATE/current"
  start=$(date +%s)
  ok=0
  for attempt in $(seq 1 "$TRIES"); do
    if fetch_once "$url" "$dir" "$name"; then
      got="$(size_of "$file.part")"
      if [ -z "$want" ] || [ "$got" = "$want" ]; then ok=1; break; fi
      echo "attempt $attempt: $name came down at $got bytes, want $want"
      [ "$got" -gt "$want" ] && rm -f "$file.part" "$file.part.aria2"
    else
      echo "attempt $attempt: fetching $name failed"
    fi
    sleep $((attempt * 10))
  done
  if [ "$ok" = 1 ] && mv -f "$file.part" "$file"; then
    secs=$(( $(date +%s) - start )); size="$(size_of "$file")"
    echo "got $name ($((size / 1048576)) MB in ${secs}s, $((size / 1048576 / (secs > 0 ? secs : 1))) MB/s)"
  else
    failures=$((failures + 1))
    echo "FAILED $name after $TRIES attempts; the next boot resumes it"
    echo "$name_of_list $name" >> "$STATE/failed"
  fi
done < "$LIST"
rm -f "$STATE/current"
# the runpod/comfyui image reads diffusion models from models/unet
if [ -d "$MODELS_DIR/diffusion_models" ] && [ ! -e "$MODELS_DIR/unet" ]; then ln -s "$MODELS_DIR/diffusion_models" "$MODELS_DIR/unet"; fi
if [ "$failures" -gt 0 ]; then echo "done with $failures failed"; exit 1; fi
echo done
