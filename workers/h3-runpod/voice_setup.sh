#!/usr/bin/env bash
# The voice worker's virtualenv (voice_worker.py): qwen-tts pins its own transformers and accelerate,
# which must not reach ComfyUI, so they live here. Run in the background at boot (start.sh); the
# container disk is fresh at each boot, so it is built each time (a few hundred MB of wheels, about a
# minute). The state goes to $VOICE_STATE_DIR/setup: installing, ready or failed (the job server's
# /health reports it and the Studio waits for ready).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="${VOICE_VENV:-/app/voice-venv}"
STATE_DIR="${VOICE_STATE_DIR:-/app/voice}"
mkdir -p "$STATE_DIR"
say() { echo "$1" > "$STATE_DIR/setup"; echo "[voice-setup] $1"; }
fail() { say "failed: $1"; exit 1; }
say installing
py="$(command -v python3)"
"$py" -c "import torch, torchaudio" 2>/dev/null || fail "the image's Python has no torch/torchaudio"
[ -x "$VENV/bin/python" ] || "$py" -m venv --system-site-packages "$VENV" || fail "venv creation"
"$VENV/bin/python" -m pip install -q --disable-pip-version-check -r "$HERE/requirements-voice.txt" || fail "pip install of requirements-voice.txt"
"$VENV/bin/python" -m pip install -q --disable-pip-version-check --no-deps qwen-tts==0.1.1 || fail "pip install of qwen-tts"
"$VENV/bin/python" -c "import qwen_tts, onnxruntime, soundfile, torchaudio" 2>"$STATE_DIR/import.log" || fail "import check (see $STATE_DIR/import.log)"
say ready
