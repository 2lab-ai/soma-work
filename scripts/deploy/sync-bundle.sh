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
rsync -a --delete --exclude-from="$PROTECTED_FILE" "$SOURCE_DIR"/ "$TARGET"/
