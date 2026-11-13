#!/bin/sh
# Release binaries must not carry this machine's home path (DEV_NOTES §11.1).
# Writes an untracked cargo config; joined with the per-platform flags Tauri sets, unlike RUSTFLAGS.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/.cargo"
cat > "$root/.cargo/config.toml" <<CONFIG
[target.'cfg(all())']
rustflags = ["--remap-path-prefix=$HOME=/build"]
CONFIG
echo "wrote .cargo/config.toml"
