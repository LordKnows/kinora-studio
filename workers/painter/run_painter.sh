#!/usr/bin/env bash
# Start a painter on a plain Linux box (a RunPod CPU pod, a VPS, a spare
# computer): installs what is missing, then runs painter.py in the foreground.
#
#   STUDIO_URL=https://studio.example.com PAINTER_TOKEN=... bash run_painter.sh
#
# The Codex login and the painter id live in PAINTER_STATE_DIR (default
# /workspace/painter when /workspace exists — a RunPod volume survives a
# restart — else ~/.cinema-painter). Log in once from the Machine page.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${STUDIO_URL:?set STUDIO_URL (https://your-studio)}"
: "${PAINTER_TOKEN:?set PAINTER_TOKEN (the Worker secret)}"
if [ -z "${PAINTER_STATE_DIR:-}" ]; then
  if [ -d /workspace ] && [ -w /workspace ]; then PAINTER_STATE_DIR=/workspace/painter; else PAINTER_STATE_DIR="$HOME/.cinema-painter"; fi
fi
export PAINTER_STATE_DIR
mkdir -p "$PAINTER_STATE_DIR"

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg curl ca-certificates >/dev/null
  else
    echo "[painter] install ffmpeg and curl first (frame extraction needs ffmpeg)" >&2
  fi
fi
python3 -c "import PIL, requests" 2>/dev/null || python3 -m pip install -q pillow requests 2>/dev/null || python3 -m pip install -q --break-system-packages pillow requests

if [ "${CODEX_INSTALL:-1}" = "1" ]; then
  bash "$HERE/install_codex.sh" "$PAINTER_STATE_DIR/codex/bin" || echo "[painter] Codex CLI install failed: only the API backend will work" >&2
  export CODEX_BIN="${CODEX_BIN:-$PAINTER_STATE_DIR/codex/bin/codex}"
fi
export CODEX_HOME_MASTER="${CODEX_HOME_MASTER:-$PAINTER_STATE_DIR/codex/home}"
mkdir -p "$CODEX_HOME_MASTER"
export PYTHONUNBUFFERED=1
exec python3 "$HERE/painter.py"
