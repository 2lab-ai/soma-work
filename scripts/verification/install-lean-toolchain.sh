#!/usr/bin/env bash
#
# install-lean-toolchain.sh — CI only: install elan from a pinned release, then the Lean toolchain
# verification/lean/lean-toolchain names. Lean Verify runs on a GitHub-hosted runner that has no
# Lean.
#
# Downloads are retried. The toolchain normally comes from elan's own server
# (releases.lean-lang.org), which refused TLS on 2 of the first 10 hosted runs (2026-10-28) — once
# for all four attempts in a row. So after two failed elan attempts the same release is taken from
# GitHub (github.com/leanprover/lean4/releases), on the runner's own network, and unpacked where
# elan looks for it (~/.elan/toolchains/<owner>--<repo>---<version>).
#
# lean-verify.sh already looks in ~/.elan/bin, so nothing else needs to change.
# LEAN_INSTALL_RETRY_DELAY (seconds, default 10) scales the delays; LEAN_INSTALL_PLATFORM overrides
# the detected release platform (linux, linux_aarch64, darwin, darwin_aarch64). Tests set both.

set -euo pipefail

ELAN_VERSION=v4.2.4
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DELAY="${LEAN_INSTALL_RETRY_DELAY:-10}"

# retry <attempts> <command...>
retry() {
  local max="$1" attempt=1
  shift
  until "$@"; do
    if [ "$attempt" -ge "$max" ]; then
      echo "install-lean-toolchain: giving up after $attempt attempts: $*" >&2
      return 1
    fi
    echo "install-lean-toolchain: attempt $attempt failed, retrying: $*" >&2
    sleep $((attempt * DELAY))
    attempt=$((attempt + 1))
  done
}

release_platform() {
  if [ -n "${LEAN_INSTALL_PLATFORM:-}" ]; then
    echo "$LEAN_INSTALL_PLATFORM"
    return
  fi
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo linux ;;
    Linux-aarch64 | Linux-arm64) echo linux_aarch64 ;;
    Darwin-arm64) echo darwin_aarch64 ;;
    Darwin-x86_64) echo darwin ;;
    *) echo "install-lean-toolchain: no Lean release for $(uname -s)-$(uname -m)" >&2; return 1 ;;
  esac
}

# Unpack the GitHub release of <owner/repo:version> into elan's toolchain directory.
install_from_github() {
  local toolchain="$1" owner_repo version platform dir archive
  owner_repo="${toolchain%%:*}"
  version="${toolchain#*:}"
  platform="$(release_platform)"
  dir="$HOME/.elan/toolchains/${owner_repo/\//--}---$version"
  archive="$(mktemp -d)/lean-${version#v}-$platform.tar.zst"
  retry 4 curl -sSfL -o "$archive" \
    "https://github.com/$owner_repo/releases/download/$version/lean-${version#v}-$platform.tar.zst"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xf "$archive" -C "$dir" --strip-components=1
  [ -x "$dir/bin/lean" ] || { echo "install-lean-toolchain: $dir/bin/lean missing after unpack" >&2; return 1; }
  echo "install-lean-toolchain: $toolchain unpacked from GitHub releases into $dir"
}

if [ ! -x "$HOME/.elan/bin/elan" ]; then
  init="$(mktemp)"
  trap 'rm -f "$init"' EXIT
  retry 4 curl -sSfL -o "$init" "https://raw.githubusercontent.com/leanprover/elan/$ELAN_VERSION/elan-init.sh"
  retry 4 sh "$init" -y --default-toolchain none
fi

toolchain="$(tr -d '[:space:]' <"$REPO_ROOT/verification/lean/lean-toolchain")"
if ! retry 2 "$HOME/.elan/bin/elan" toolchain install "$toolchain"; then
  echo "install-lean-toolchain: elan could not fetch $toolchain; falling back to GitHub releases" >&2
  install_from_github "$toolchain"
fi
echo "install-lean-toolchain: elan $ELAN_VERSION, toolchain $toolchain"
