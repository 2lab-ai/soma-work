#!/usr/bin/env bash
# build-gh-fallback.sh
#
# gh CLI을 golang.org/x/crypto/x509roots/fallback 임포트로 재빌드한다.
# macOS 샌드박스에서 Security.framework(trustd IPC)가 막혀
# OSStatus -26276으로 TLS 검증이 실패하는 문제를 우회한다.
#
# 결과물: ~/.local/bin/gh
# 사용법: GODEBUG=x509usefallbackroots=1 ~/.local/bin/gh ...
#         (또는 스크립트 끝 alias 안내 참조)

set -euo pipefail

INSTALL_DIR="${HOME}/.local/bin"
WORK_DIR="${TMPDIR:-/tmp}/gh-fallback-$(date +%s)-$$"
GH_REPO="https://github.com/cli/cli.git"

log()  { printf '\033[1;34m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ -d "$WORK_DIR" ]]; then
    log "cleaning workspace: $WORK_DIR"
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ---- pre-flight ----------------------------------------------------------
for cmd in go git; do
  command -v "$cmd" >/dev/null || die "$cmd not found in PATH"
done

log "go:  $(go version)"
log "git: $(git --version)"
log "workspace: $WORK_DIR"
log "install:   $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# ---- pick latest release tag --------------------------------------------
log "resolving latest gh release tag..."
LATEST_TAG=$(
  git ls-remote --tags --refs --sort=-v:refname "$GH_REPO" \
    | awk -F/ '{print $NF}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | head -1
)
[[ -n "$LATEST_TAG" ]] || die "failed to resolve latest tag"
log "latest tag: $LATEST_TAG"

# ---- clone --------------------------------------------------------------
log "cloning gh source..."
git clone --depth 1 --branch "$LATEST_TAG" "$GH_REPO" "$WORK_DIR"
cd "$WORK_DIR"

# ---- inject fallback roots import ---------------------------------------
log "injecting x509roots/fallback import into cmd/gh/ ..."
cat > cmd/gh/fallback_roots.go <<'PATCH'
package main

// Embedded Mozilla NSS CA bundle. Import triggers an init() that registers
// fallback roots; activated at runtime via GODEBUG=x509usefallbackroots=1.
// Workaround: macOS sandboxes that block com.apple.trustd Mach IPC cause
// SecTrustEvaluateWithError to fail with OSStatus -26276. With this import
// + GODEBUG, Go's pure-Go x509 verifier uses the embedded CA bundle and
// avoids Security.framework entirely.
import _ "golang.org/x/crypto/x509roots/fallback"
PATCH

# ---- update modules -----------------------------------------------------
log "go get x509roots/fallback..."
go get golang.org/x/crypto/x509roots/fallback@latest
go mod tidy

# ---- build --------------------------------------------------------------
VERSION_TAG="${LATEST_TAG}+fallback"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LDFLAGS="-X github.com/cli/cli/v2/internal/build.Version=${VERSION_TAG} -X github.com/cli/cli/v2/internal/build.Date=${BUILD_DATE}"

log "building gh -> $INSTALL_DIR/gh ..."
go build -trimpath -ldflags "$LDFLAGS" -o "$INSTALL_DIR/gh" ./cmd/gh

log "built: $(du -h "$INSTALL_DIR/gh" | awk '{print $1}')  $INSTALL_DIR/gh"

# ---- smoke test ---------------------------------------------------------
log "smoke: $INSTALL_DIR/gh --version"
"$INSTALL_DIR/gh" --version || warn "smoke test returned non-zero (may be harmless)"

log "smoke: GODEBUG=x509usefallbackroots=1 gh api user"
if GODEBUG=x509usefallbackroots=1 "$INSTALL_DIR/gh" api user -q '.login' 2>&1; then
  log "TLS verification succeeded with fallback roots. OK."
else
  warn "TLS still failing. If HTTPS_PROXY is MITM'ing, proxy CA must also be added to fallback bundle."
fi

# ---- post-install instructions -----------------------------------------
cat <<EOF

─────────────────────────────────────────────────────────────
Installed: $INSTALL_DIR/gh  ($VERSION_TAG)

Add to ~/.zshrc (or ~/.bashrc):

  # Prefer custom gh with Mozilla NSS fallback CA roots
  export PATH="\$HOME/.local/bin:\$PATH"
  alias gh='GODEBUG=x509usefallbackroots=1 \$HOME/.local/bin/gh'

Reload shell:
  source ~/.zshrc    # or: source ~/.bashrc

Verify:
  which gh           # should be an alias to \$HOME/.local/bin/gh
  gh auth status
  gh api user -q .login

Rollback:
  unalias gh
  rm $INSTALL_DIR/gh
─────────────────────────────────────────────────────────────
EOF
