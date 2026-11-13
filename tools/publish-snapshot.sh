#!/bin/sh
# Export the tracked tree as a history-free snapshot into the public repo's working copy (DEV_NOTES §11.2).
# usage: tools/publish-snapshot.sh <public-worktree> [commit message]
# Commits there but does not push; pushing is a separate, deliberate step.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:?usage: publish-snapshot.sh <public-worktree> [commit message]}"
msg="${2:-snapshot}"
# extra patterns that must never be published, one per line; lives outside any repo
deny="${TM_SNAPSHOT_DENY:-$HOME/.config/tavern-mobile/snapshot-deny.txt}"

[ -d "$dest/.git" ] || { echo "not a git worktree: $dest" >&2; exit 1; }
[ -z "$(git -C "$root" status --porcelain)" ] || { echo "dev tree has uncommitted changes" >&2; exit 1; }
[ -s "$deny" ] || { echo "deny list missing: $deny" >&2; exit 1; }

find "$dest" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$root" archive HEAD | tar -x -C "$dest"

# internal work logs stay private; the public repo gets its own README
rm -f "$dest/HANDOFF.md" "$dest/DEV_NOTES.md" "$dest/PHASES.md"
# CI stays with the dev repo until a release workflow exists
rm -rf "$dest/.github"
mv "$dest/tools/public-readme.md" "$dest/README.md"

hits="$( { grep -rIil --exclude-dir=.git -f "$deny" "$dest" || true; grep -rIl --exclude-dir=.git -e "$HOME" "$dest" || true; } | sort -u)"
if [ -n "$hits" ]; then
  echo "refusing to commit, private strings found in:" >&2
  echo "$hits" >&2
  exit 1
fi

git -C "$dest" add -A
if git -C "$dest" diff --cached --quiet; then
  echo "nothing changed"
  exit 0
fi
git -C "$dest" -c user.name="coredump119" -c user.email="coredump119@users.noreply.github.com" commit -q -m "$msg"
git -C "$dest" log --oneline -1
