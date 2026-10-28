#!/usr/bin/env bash
#
# install-lean-toolchain.sh — CI only: install elan from a pinned release, then the Lean toolchain
# verification/lean/lean-toolchain names. Lean Verify runs on a GitHub-hosted runner that has no
# Lean; the first hosted run failed on a single TLS error fetching the toolchain (2026-10-28), so
# every download is retried (4 attempts, growing delay) before the job is allowed to fail.
#
# lean-verify.sh already looks in ~/.elan/bin, so nothing else needs to change.
# LEAN_INSTALL_RETRY_DELAY (seconds, default 10) scales the delay; tests set it to 0.

set -euo pipefail

ELAN_VERSION=v4.2.4
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELAY="${LEAN_INSTALL_RETRY_DELAY:-10}"

retry() {
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge 4 ]; then
      echo "install-lean-toolchain: giving up after $attempt attempts: $*" >&2
      return 1
    fi
    echo "install-lean-toolchain: attempt $attempt failed, retrying: $*" >&2
    sleep $((attempt * DELAY))
    attempt=$((attempt + 1))
  done
}

if [ ! -x "$HOME/.elan/bin/elan" ]; then
  init="$(mktemp)"
  trap 'rm -f "$init"' EXIT
  retry curl -sSfL -o "$init" "https://raw.githubusercontent.com/leanprover/elan/$ELAN_VERSION/elan-init.sh"
  retry sh "$init" -y --default-toolchain none
fi

toolchain="$(tr -d '[:space:]' <"$REPO_ROOT/verification/lean/lean-toolchain")"
retry "$HOME/.elan/bin/elan" toolchain install "$toolchain"
echo "install-lean-toolchain: elan $ELAN_VERSION, toolchain $toolchain"
