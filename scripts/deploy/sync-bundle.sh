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
#
# So instead of trusting `rsync --delete`, explicitly remove every non-protected
# top-level target entry, then copy the bundle in fresh. Enumerate with `find`
# (not a shell glob) so behavior does not depend on dotglob/nullglob/shell
# quirks across runner environments. Code dirs (packages/, dist/, somalib/,
# scripts/, node_modules, ...) are bundle- or install-provided, so wiping and
# recopying them is correct; protected runtime state is preserved.
echo "sync-bundle: cleaning target $TARGET (protected: $(tr '\n' ' ' < "$STRIPPED_PROTECTED"))"
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  base="$(basename "$entry")"
  if grep -qxF "$base" "$STRIPPED_PROTECTED"; then
    echo "sync-bundle: keep    $base"
    continue
  fi
  echo "sync-bundle: remove  $base"
  rm -rf "$entry"
done < <(find "$TARGET" -mindepth 1 -maxdepth 1)

rsync -a --exclude-from="$PROTECTED_FILE" "$SOURCE_DIR"/ "$TARGET"/
echo "sync-bundle: done; target packages: $(ls "$TARGET/packages" 2>/dev/null | tr '\n' ' ')"
