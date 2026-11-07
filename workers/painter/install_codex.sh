#!/usr/bin/env bash
# Install the Codex CLI and the helpers it spawns into one directory:
#   codex                 the CLI (codex-<arch>-unknown-linux-musl, x86_64 or aarch64)
#   codex-code-mode-host  runs Codex's tool calls in "code mode"; a separate
#                         release archive, looked up next to the codex binary
# Idempotent: present files are kept unless CODEX_UPDATE=1.
set -euo pipefail
BIN="${1:?usage: install_codex.sh <bin dir>}"
BASE="${CODEX_RELEASE_BASE:-https://github.com/openai/codex/releases/latest/download}"
case "$(uname -m)" in
  aarch64|arm64) DEFAULT_TARGET="aarch64-unknown-linux-musl" ;;
  *) DEFAULT_TARGET="x86_64-unknown-linux-musl" ;;
esac
TARGET="${CODEX_TARGET:-$DEFAULT_TARGET}"
mkdir -p "$BIN"
fetch() {  # <asset base name> <installed name>
  local asset="$1" name="$2" tmp
  if [ -x "$BIN/$name" ] && [ "${CODEX_UPDATE:-0}" != "1" ]; then echo "have $name"; return 0; fi
  tmp="$(mktemp -d)"
  curl -fsSL -A Mozilla/5.0 -o "$tmp/a.tgz" "$BASE/$asset-$TARGET.tar.gz"
  tar xzf "$tmp/a.tgz" -C "$tmp"
  local file
  file="$(find "$tmp" -type f -name "$asset*" ! -name '*.tgz' | head -1)"
  [ -n "$file" ] || { echo "no $asset binary in the archive"; rm -rf "$tmp"; return 1; }
  install -m 0755 "$file" "$BIN/$name.new"
  mv "$BIN/$name.new" "$BIN/$name"
  rm -rf "$tmp"
  echo "installed $name"
}
fetch codex codex
fetch codex-code-mode-host codex-code-mode-host
echo "ready $("$BIN/codex" --version 2>/dev/null || echo codex)"
