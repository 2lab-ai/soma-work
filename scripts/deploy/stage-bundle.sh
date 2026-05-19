#!/usr/bin/env bash
set -euo pipefail

STAGE_DIR="${1:-.deploy-bundle}"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

copy_file() {
  local src="$1"
  local dst="$STAGE_DIR/$1"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
}

copy_dir() {
  local src="$1"
  local dst="$STAGE_DIR/$1"
  if [[ -d "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    cp -R "$src" "$dst"
  fi
}

prune_non_runtime_artifacts() {
  find "$STAGE_DIR" -type d -name node_modules -prune -exec rm -rf {} +
  find "$STAGE_DIR" -type d -name __tests__ -prune -exec rm -rf {} +
  find "$STAGE_DIR" -type f \( -name '*.test.js' -o -name '*.test.ts' -o -name '*.test.cjs' -o -name '*.test.mjs' \) -exec rm -f {} +

  # Old local builds may have left package compiler output under the root app dist.
  # The deploy bundle uses workspace package dist directories instead.
  rm -rf "$STAGE_DIR/dist/packages" "$STAGE_DIR/dist/src"
}

copy_file package.json
copy_file package-lock.json
copy_file scripts/service.sh
copy_file scripts/smoke/mcp-bins.js
copy_file scripts/smoke/resvg-native.js
copy_file scripts/deploy/sync-bundle.sh
copy_file scripts/deploy/install-target.sh
copy_file deploy/protected-paths.txt

copy_dir dist
copy_dir somalib

while IFS= read -r package_json; do
  package_dir="$(dirname "$package_json")"
  mkdir -p "$STAGE_DIR/$package_dir"
  cp "$package_json" "$STAGE_DIR/$package_json"
  copy_dir "$package_dir/dist"
  copy_dir "$package_dir/assets"
done < <(find packages -mindepth 2 -maxdepth 3 -name package.json -type f -not -path '*/node_modules/*' | sort)

prune_non_runtime_artifacts

if [[ ! -f "$STAGE_DIR/dist/deploy/main-env-bootstrap.js" ]]; then
  echo "Missing dist/deploy/main-env-bootstrap.js in staged deploy bundle" >&2
  exit 1
fi

if [[ ! -f "$STAGE_DIR/packages/mcp-servers/permission/dist/permission-mcp-server.js" ]]; then
  echo "Missing packaged MCP server dist output in staged deploy bundle" >&2
  exit 1
fi
