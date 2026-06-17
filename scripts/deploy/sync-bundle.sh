#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: sync-bundle.sh TARGET [SOURCE_DIR]}"
SOURCE_DIR="${2:-.}"
PROTECTED_FILE="$SOURCE_DIR/deploy/protected-paths.txt"

if [[ ! -f "$PROTECTED_FILE" ]]; then
  echo "Missing protected paths file: $PROTECTED_FILE" >&2
  exit 1
fi

mkdir -p "$TARGET"

# Protected top-level names with trailing slashes stripped and blank lines
# dropped. These are runtime state that must survive a deploy (.env,
# config.json, data/, logs/, plugins/, the bootstrap marker, ...). Kept in a
# temp file so we stay compatible with the macOS system bash 3.2 (no
# associative arrays / `declare -A`).
STRIPPED_PROTECTED="$(mktemp)"
trap 'rm -f "$STRIPPED_PROTECTED"' EXIT
sed 's:/*$::' "$PROTECTED_FILE" | grep -v '^[[:space:]]*$' > "$STRIPPED_PROTECTED"

# Reliable clean-then-copy. macOS ships openrsync, whose `--delete` is
# unreliable at removing non-empty extraneous directories (it warns
# "not empty, cannot delete" and leaves them). That left a removed workspace
# (packages/extensions) at the target, and the root `workspaces: [packages/*]`
# glob then made `npm ci` fail with "Missing: @soma/extensions from lock file".
# So we explicitly remove every non-protected top-level target entry, then copy
# the bundle in fresh. Code dirs (packages/, dist/, somalib/, scripts/,
# node_modules, ...) are bundle- or install-provided, so wiping and recopying
# them is correct; protected runtime state is preserved.
shopt -s dotglob nullglob
for entry in "$TARGET"/*; do
  base="$(basename "$entry")"
  if grep -qxF "$base" "$STRIPPED_PROTECTED"; then
    continue
  fi
  rm -rf "$entry"
done
shopt -u dotglob nullglob

rsync -a --exclude-from="$PROTECTED_FILE" "$SOURCE_DIR"/ "$TARGET"/
