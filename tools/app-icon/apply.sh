#!/usr/bin/env bash
# Regenerates every platform's app icon from tools/app-icon/render.py.
# Usage: tools/app-icon/apply.sh   (run from the repository root)
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
tauri_dir="$root/apps/app/src-tauri"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

python3 "$root/tools/app-icon/render.py" "$work/src"
cd "$root/apps/app"
generate() {
  pnpm -s tauri icon "$1" -o "$2" >"$work/log" 2>&1 || {
    cat "$work/log"
    exit 1
  }
}
generate "$work/src/mobile.json" "$work/mobile"
generate "$work/src/icon-desktop.svg" "$work/desktop"

# desktop bundles: everything at the top level of the icons folder
find "$work/desktop" -maxdepth 1 -type f -exec cp {} "$tauri_dir/icons/" \;

# iOS: the reference copy and the Xcode asset catalog use the same file names
cp "$work/mobile/ios/"*.png "$tauri_dir/icons/ios/"
cp "$work/mobile/ios/"*.png "$tauri_dir/gen/apple/Assets.xcassets/AppIcon.appiconset/"

# Android: the reference copy and the Gradle project's resources
rm -rf "$tauri_dir/icons/android"
cp -R "$work/mobile/android" "$tauri_dir/icons/android"
cp -R "$work/mobile/android/." "$tauri_dir/gen/android/app/src/main/res/"
