#!/usr/bin/env bash
#
# stage-bundle.sh — build the immutable somawork runtime bundle.
#
# The staged tree is ONE layout with two consumers:
#
#   1. the legacy fleet deploy (`sync-bundle.sh` + `install-target.sh`), which
#      rsyncs it to a node and runs `npm ci --omit=dev` there;
#   2. `somawork setup`, which reads the canonical setup assets out of an
#      installed runtime root.
#
# Because of (2) the bundle is not just "the files the daemon needs to run" any
# more. It must also carry, at fixed paths relative to the runtime root:
#
#   dist/cli/index.js                    executable controller entry
#   dist/run-with-rotating-logs.js       immutable service supervisor
#   dist/index.js                        daemon entry
#   config.default.json                  canonical materializer input
#   .system.prompt.example               canonical default prompt input
#   infra/slack/slack-app-manifest.json  canonical Slack manifest
#   services/a2t/worker.py               a2t worker (upstream runtime payload)
#   services/a2t/requirements.txt         the interpreter the worker is installed from
#
# and it must carry nothing mutable, secret, or source. `scripts/smoke/setup-package.js`
# is the executable statement of both halves of that contract; this script is
# only the copy list. Anything added here that the smoke does not know about is
# untested payload.
#
# Deliberately NOT staged: `node_modules` (installed on the target), `.env` /
# `secrets.env` / `config.json` / profile state (per-instance — and the setup
# design keeps profile state outside the immutable runtime root entirely),
# `scripts/setup/*.sh` (the deprecated manual credential collector: unreachable
# since the wizard entry points became `somawork setup` shims, and pending
# deletion on the clean-machine receipt), tests, source maps, TypeScript source.
set -euo pipefail

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

  # Pruning `__tests__` alone left the tests' *inputs* behind: compiled fixtures
  # and mock factories that nothing outside a test imports (verified — the only
  # importers of `src/cct-store/__fixtures__` and `src/test-utils` are
  # `__tests__` files), one of which carries a credential-shaped literal.
  find "$STAGE_DIR" -type d \( -name __fixtures__ -o -name __mocks__ \) -prune -exec rm -rf {} +
  # The app's own compiled test helpers. `packages/test-utils` stays: the target
  # runs `npm ci --workspaces`, which needs every workspace manifest present.
  rm -rf "$STAGE_DIR/dist/test-utils"

  # Source maps and TypeScript sources are build inputs and debug aids; node
  # reads neither at runtime. `somalib` is compiled in place, so its `.ts` sit
  # next to the emitted `.js` and would otherwise put repository source inside
  # an immutable install tree. `.d.ts` go with them: they are TypeScript, and
  # nothing in a running instance resolves a type declaration.
  find "$STAGE_DIR" -type f \( -name '*.map' -o -name '*.ts' -o -name '*.tsx' \) -exec rm -f {} +

  # Old local builds may have left package compiler output under the root app dist.
  # The deploy bundle uses workspace package dist directories instead.
  rm -rf "$STAGE_DIR/dist/packages" "$STAGE_DIR/dist/src"

  # `copy_dir services` stages the working tree verbatim, so whatever running
  # the a2t worker locally left behind is staged with it — and both shapes it
  # leaves are staging failures, not cosmetic ones:
  #
  #   `__pycache__/*.pyc` carry NUL bytes, so the staged-artifact scan at the
  #   bottom of this script reports them as unscannable and exits non-zero;
  #   a local `.venv` / `venv` is a tree of symlinks to an interpreter outside
  #   the runtime root, which the same scan refuses outright.
  #
  # Neither is runtime payload — the target provisions its own interpreter from
  # `services/a2t/requirements.txt` — so prune them here rather than let a dirty
  # checkout decide whether a bundle can be staged at all. Scoped to the staged
  # `services/` tree and matched by cache/venv shape only, so `.py` source is
  # never touched.
  if [[ -d "$STAGE_DIR/services" ]]; then
    find "$STAGE_DIR/services" -type d -name __pycache__ -prune -exec rm -rf {} +
    find "$STAGE_DIR/services" \( -type d -o -type l \) \( -name .venv -o -name venv \) -prune -exec rm -rf {} +
    find "$STAGE_DIR/services" -type f \( -name '*.pyc' -o -name '*.pyo' \) -exec rm -f {} +
  fi
}

require_staged_file() {
  if [[ ! -f "$STAGE_DIR/$1" ]]; then
    echo "Missing $1 in staged deploy bundle" >&2
    exit 1
  fi
}

# Everything above is definitions; everything below is the staging run, which
# starts by deleting `$STAGE_DIR`. `STAGE_BUNDLE_LIB=1 . stage-bundle.sh` stops
# here with the helpers defined and nothing removed, so the contract test can
# exercise `prune_non_runtime_artifacts` against a fixture tree instead of
# against a 26 MB stage. Executing (rather than sourcing) with the flag set is a
# no-op exit rather than a partial stage.
if [[ "${STAGE_BUNDLE_LIB:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

STAGE_DIR="${1:-.deploy-bundle}"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

copy_file package.json
copy_file package-lock.json
copy_file scripts/service.sh
copy_file scripts/smoke/mcp-bins.js
copy_file scripts/smoke/resvg-native.js
copy_file scripts/deploy/sync-bundle.sh
copy_file scripts/deploy/install-target.sh
copy_file deploy/protected-paths.txt

# Canonical setup assets. `somawork setup` reads these three out of the runtime
# root on every run (`src/cli/production-seams.ts` names them as constants), so
# a bundle without them installs a runtime that cannot onboard a profile.
copy_file config.default.json
copy_file .system.prompt.example
copy_file infra/slack/slack-app-manifest.json

copy_dir dist
copy_dir somalib
copy_dir services

while IFS= read -r package_json; do
  package_dir="$(dirname "$package_json")"
  mkdir -p "$STAGE_DIR/$package_dir"
  cp "$package_json" "$STAGE_DIR/$package_json"
  copy_dir "$package_dir/dist"
  copy_dir "$package_dir/assets"
done < <(find packages -mindepth 2 -maxdepth 3 -name package.json -type f -not -path '*/node_modules/*' | sort)

prune_non_runtime_artifacts

require_staged_file dist/deploy/main-env-bootstrap.js
require_staged_file packages/mcp-servers/permission/dist/permission-mcp-server.js

# The stable runtime layout, listed explicitly rather than globbed so a rename
# surfaces here as a failing stage instead of as a bundle that quietly ships one
# file fewer.
require_staged_file dist/cli/index.js
require_staged_file dist/run-with-rotating-logs.js
require_staged_file dist/index.js
require_staged_file config.default.json
require_staged_file .system.prompt.example
require_staged_file infra/slack/slack-app-manifest.json

# The formula links this as `somawork`. `npm run build` sets the bit and `cp`
# preserves it, but an install that lost it fails at exec time with a message
# naming neither this bundle nor this line.
if [[ ! -x "$STAGE_DIR/dist/cli/index.js" ]]; then
  echo "Staged dist/cli/index.js is not executable" >&2
  exit 1
fi

# Upstream's a2t worker is part of the same immutable runtime tree. Keep its
# explicit assertion beside the other layout pins so a future copy-list change
# cannot silently drop it while setup/package checks remain green.
require_staged_file services/a2t/worker.py

# The worker is not installable without it: the target builds the a2t
# environment from this file, so a bundle carrying the worker alone is a runtime
# whose python side cannot be provisioned. Same pin, same reason.
require_staged_file services/a2t/requirements.txt

# The staged-artifact security gate, in the staging script rather than in a
# separate npm script (I-4).
#
# `require_staged_file` above uses `[[ -f ]]`, which FOLLOWS symlinks, and this
# script contains no credential pattern at all — so before this line, staging
# could exit 0 on a tree carrying a planted symlink or a token-shaped constant,
# and the release path (which tarballs this output) never ran the one check that
# would have caught it. `--inventory-only` is the same `inventoryProblems` the
# full smoke runs, without the hermetic harness, so there is no recursion.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node "$REPO_ROOT/scripts/smoke/setup-package.js" --inventory-only "$STAGE_DIR"
