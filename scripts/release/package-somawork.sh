#!/usr/bin/env bash
#
# package-somawork.sh — build the immutable public release assets.
#
# Produces, into --out-dir:
#
#   somawork-cli-<version>-darwin-arm64.tar.gz       the common controller
#   somawork-<version>-darwin-arm64.tar.gz           the production runtime
#   somawork-preview-<version>-darwin-arm64.tar.gz   the preview runtime
#   somawork-manifest.json                           what the tap renderer reads
#
# ## Two payloads, three archives
#
# The **controller** is a self-contained `esbuild` bundle of `src/cli/index.ts`.
# It is not a hand-picked subset of `dist/cli`: `doctor` reaches `src/config`,
# `src/config-loader` and the llmux client, which reach most of the runtime, so
# any copy list that looked complete would still `MODULE_NOT_FOUND` on the first
# nontrivial command. Layout:
#
#   package.json                 name/version/bin, read by `somawork --version`
#   libexec/bin/somawork         the bundle, executable, `#!/usr/bin/env node`
#   .somawork-package.json       which release this extraction came from
#
# The executable sits two directories below the archive root ON PURPOSE:
# `readControllerVersion` resolves `__dirname/../../package.json`, so a flat
# `bin/somawork` would resolve outside the install prefix and print `unknown`.
# A formula installing this with `prefix.install Dir["*"]` and symlinking
# `libexec/bin/somawork` into `bin` keeps that relationship intact.
#
# The **runtime** payload is exactly what `scripts/deploy/stage-bundle.sh`
# produces — one layout, shared with the fleet deploy — plus the production
# dependencies the deploy would install on the target. Both runtime archives are
# built from that single payload and differ only in `.somawork-package.json`;
# neither carries a linked `somawork`, because the two runtimes must coexist and
# only the controller owns that name.
#
# ## Determinism
#
# Two runs over identical inputs must produce identical SHA-256s, because the
# manifest publishes those SHAs and a formula pins them. So: `COPYFILE_DISABLE=1`
# and no AppleDouble/xattr/ACL entries, uid/gid/uname/gname normalized to
# `0/0/""/""`, every mtime forced to `SOURCE_DATE_EPOCH`, members emitted in
# `LC_ALL=C` lexical order rather than readdir order, and `gzip -n` so the
# compressed stream carries neither the original filename nor a timestamp.
#
# "Identical inputs" means the same staged tree and the same installed
# dependency tree. Re-resolving dependencies from the registry is a different
# input; pass --staged-runtime/--dependency-overlay to repackage the same one.
# The overlay is a directory whose contents are copied over the payload root, so
# it carries every `node_modules` an install produced, nested ones included.
#
# ## Not this script's job
#
# It creates no tag, uploads nothing, dispatches nothing, and needs no token.
# Publication lives in `.github/workflows/release-preview.yml`, behind an
# explicit dispatch. It also invents no license: the ISC grant is copied
# verbatim out of the repository's root LICENSE into both payload roots, and the
# identifier the controller manifest declares is read out of the root
# package.json. Both are repository facts this script transports; neither is a
# value it decides, and a payload missing either is refused rather than shipped.
#
# ## Usage
#
#   scripts/release/package-somawork.sh --out-dir dist-release \
#     --tag somawork-preview-v1.2.3-42 \
#     --release-base-url https://github.com/2lab-ai/soma-work/releases/download/somawork-preview-v1.2.3-42 \
#     [--version 1.2.3] [--channel preview|stable] \
#     [--source-sha SHA] [--source-date-epoch N] \
#     [--staged-runtime DIR] [--dependency-overlay DIR]
#
# `--tag` and `--release-base-url` are REQUIRED and are validated before the
# output directory is touched. The tag grammar is channel-specific:
# `somawork-preview-v<version>-<run id>` / `somawork-v<version>-<run id>`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OUT_DIR=""
VERSION=""
CHANNEL="preview"
TAG=""
SOURCE_SHA=""
SOURCE_DATE_EPOCH=""
RELEASE_BASE_URL=""
STAGED_RUNTIME=""
DEPENDENCY_OVERLAY=""

PLATFORM="darwin-arm64"
NODE_TARGET="node20"
MINIMUM_NODE="20.0.0"
LAYOUT_VERSION=1
METADATA_FILE=".somawork-package.json"

die() {
  echo "package-somawork: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="${2:?--out-dir requires a value}"; shift 2 ;;
    --version) VERSION="${2:?--version requires a value}"; shift 2 ;;
    --channel) CHANNEL="${2:?--channel requires a value}"; shift 2 ;;
    --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
    --source-sha) SOURCE_SHA="${2:?--source-sha requires a value}"; shift 2 ;;
    --source-date-epoch) SOURCE_DATE_EPOCH="${2:?--source-date-epoch requires a value}"; shift 2 ;;
    --release-base-url) RELEASE_BASE_URL="${2:?--release-base-url requires a value}"; shift 2 ;;
    --staged-runtime) STAGED_RUNTIME="${2:?--staged-runtime requires a value}"; shift 2 ;;
    --dependency-overlay) DEPENDENCY_OVERLAY="${2:?--dependency-overlay requires a value}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$OUT_DIR" ]] || die "--out-dir is required"
[[ "$CHANNEL" == "preview" || "$CHANNEL" == "stable" ]] || die "--channel must be preview or stable"

# The assets are darwin-arm64 and the archives are built with bsdtar's flag
# spelling. Rather than carry an untested GNU-tar branch, say so.
tar --version 2>/dev/null | grep -q bsdtar || die "packaging requires bsdtar (macOS); found: $(tar --version 2>&1 | head -1)"
[[ "$(uname -s)" == "Darwin" ]] || die "packaging produces $PLATFORM assets and must run on macOS"

ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"
TSX="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$ESBUILD" ]] || die "esbuild is not installed; run npm ci"
[[ -x "$TSX" ]] || die "tsx is not installed; run npm ci"

# The repository's own license, resolved before anything is built.
#
# Two facts, two sources, neither of them this script: the grant is whatever the
# root LICENSE says, and the SPDX identifier is whatever the root package.json
# declares. Writing "ISC" into a build script instead would let an archive claim
# a license the repository does not grant, which is exactly the guess this
# packaging path refused to make while no LICENSE existed. Both are fatal when
# missing: an unlicensed public archive is a worse outcome than a failed build.
#
# The identifier is type-checked in node, not in bash, because bash only ever
# sees the printed form. `node -p` renders a missing field as `undefined`, a
# `null` as `null`, an object as `[object Object]` and an array as its joined
# elements — four broken manifests that a `-n` string test accepts as
# identifiers, and the first two would have shipped a literal `"license":
# "undefined"`. Anything that is not a non-blank string exits non-zero here and
# prints nothing at all.
LICENSE_FILE="$REPO_ROOT/LICENSE"
[[ -f "$LICENSE_FILE" ]] || die "no LICENSE at the repository root; refusing to package an unlicensed archive"
LICENSE_ID_ERROR="package.json must declare a non-empty string license; refusing to package an archive that cannot name one"
LICENSE_ID="$(cd "$REPO_ROOT" && node -e '
const id = require("./package.json").license;
if (typeof id !== "string" || id.trim() === "") process.exit(1);
process.stdout.write(id);
' 2>/dev/null)" || die "$LICENSE_ID_ERROR"
# Belt: a node that somehow exited 0 with nothing to say must not become an
# empty `"license": ""` in a public manifest.
[[ -n "$LICENSE_ID" ]] || die "$LICENSE_ID_ERROR"

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p 'require("./package.json").version' 2>/dev/null || true)"
fi
[[ -n "$VERSION" ]] || die "could not resolve a version; pass --version"
# EXACTLY three numeric components. The tag grammar below is built out of this,
# and the tap renders `<version>.<run id>` for Homebrew — whose component-wise
# comparison is monotone within a fixed component count and NOT across a change
# of it (`1.0` + run 12345 → `1.0.12345`; a later `1.0.1` + run 12346 →
# `1.0.1.12346`, which sorts below it). A prerelease suffix is excluded for the
# same reason: it is not orderable in the middle of a tag.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "--version must be exactly three numeric components, x.y.z (got: $VERSION)"

if [[ -z "$SOURCE_SHA" ]]; then
  SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "--source-sha must be a 40-character commit sha"

if [[ -z "$SOURCE_DATE_EPOCH" ]]; then
  SOURCE_DATE_EPOCH="$(git -C "$REPO_ROOT" log -1 --format=%ct "$SOURCE_SHA" 2>/dev/null || true)"
fi
[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || die "--source-date-epoch must be an integer"

# --- the release identity is supplied, never invented here -------------------
#
# Both of these used to have defaults, and both defaults were wrong to have:
#
#   * `somawork-<channel>-v<version>` carries no run id, so two packaging runs of
#     the same version produced the SAME tag. A release tag that repeats is not
#     immutable and does not order — the publishing workflow's whole re-run story
#     depends on a strictly increasing suffix.
#   * defaulting the asset base meant this script and `render-manifest.ts` each
#     had their own idea of where a release lives, and only one of them was
#     authoritative.
#
# The caller (the workflow, or a human) states both. This script validates and
# refuses; it does not guess.
# Channel-specific, exact. Compared by prefix strip rather than by regex so the
# version's dots cannot act as wildcards.
case "$CHANNEL" in
  preview) TAG_PREFIX="somawork-preview-v${VERSION}-" ;;
  stable) TAG_PREFIX="somawork-v${VERSION}-" ;;
esac

[[ -n "$TAG" ]] || die "--tag is required (expected ${TAG_PREFIX}<run id>)"
[[ -n "$RELEASE_BASE_URL" ]] || die "--release-base-url is required"

TAG_SUFFIX="${TAG#"$TAG_PREFIX"}"
if [[ "$TAG_SUFFIX" == "$TAG" ]]; then
  die "--tag must start with ${TAG_PREFIX} for the ${CHANNEL} channel (got: $TAG)"
fi
[[ "$TAG_SUFFIX" =~ ^[1-9][0-9]*$ ]] || die "--tag must end in a positive run id with no leading zero (got: $TAG)"

# The canonical asset base. `scripts/release/render-manifest.ts` owns this form
# (`releaseBaseUrl`) and rejects any manifest whose base differs; checking it
# here too is what makes the refusal happen BEFORE anything is written.
EXPECTED_BASE_URL="https://github.com/2lab-ai/soma-work/releases/download/${TAG}"
[[ "$RELEASE_BASE_URL" == "$EXPECTED_BASE_URL" ]] ||
  die "--release-base-url must be ${EXPECTED_BASE_URL} (got: $RELEASE_BASE_URL)"

CONTROLLER_ASSET="somawork-cli-${VERSION}-${PLATFORM}.tar.gz"
PRODUCTION_ASSET="somawork-${VERSION}-${PLATFORM}.tar.gz"
PREVIEW_ASSET="somawork-preview-${VERSION}-${PLATFORM}.tar.gz"
MANIFEST_ASSET="somawork-manifest.json"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
rm -f "$OUT_DIR/$CONTROLLER_ASSET" "$OUT_DIR/$PRODUCTION_ASSET" "$OUT_DIR/$PREVIEW_ASSET" "$OUT_DIR/$MANIFEST_ASSET"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/somawork-package-XXXXXX")"
# `realpath` because /var is a symlink to /private/var on macOS and the archive
# gate refuses a payload path it cannot resolve to one canonical form.
WORK="$(cd "$WORK" && pwd -P)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Deterministic archive creation
# ---------------------------------------------------------------------------

# The two payload operations that are not shell: mtime normalization and the
# member list `tar --null -T` consumes. Both live in `scripts/release/payload-tools.js`
# so they are unit-testable; see that file for why neither can be a pipeline.
PAYLOAD_TOOLS="$REPO_ROOT/scripts/release/payload-tools.js"

normalize_mtimes() {
  node "$PAYLOAD_TOOLS" normalize-mtimes "$1" "$SOURCE_DATE_EPOCH"
}

# The grant, into a payload root. Copied rather than linked or re-generated: the
# archive must carry the same bytes the repository grants, a symlink would not
# survive extraction as a file, and a payload that assembled its own text could
# drift from the file the project is actually licensed under. Callers must run
# this BEFORE the payload's final `normalize_mtimes`, because `cp` stamps the
# copy and its parent directory with the current time and both are members.
copy_license() {
  cp "$LICENSE_FILE" "$1/LICENSE"
  chmod 644 "$1/LICENSE"
}

make_archive() {
  local payload="$1"
  local out="$2"
  local list="$WORK/filelist"
  local members

  # Refuses, before tar runs, any member name carrying a control character — the
  # check the previous `wc -l` guard could never make, because a newline in a
  # path incremented both sides of its comparison equally.
  members="$(node "$PAYLOAD_TOOLS" tar-list "$payload" "$list")" ||
    die "refusing to archive $payload"
  [[ "$members" -gt 0 ]] || die "payload has no members: $payload"

  ( cd "$payload" && COPYFILE_DISABLE=1 tar \
      --format=gnutar \
      --null \
      --uid 0 --gid 0 --uname '' --gname '' \
      --no-mac-metadata --no-xattrs --no-acls --no-fflags \
      -n -c -f - -T "$list" ) | gzip -n -9 > "$out"
}

write_metadata() {
  local payload="$1"
  local package_name="$2"
  local profile_json="$3"

  cat > "$payload/$METADATA_FILE" <<JSON
{
  "schemaVersion": 1,
  "package": "$package_name",
  "profile": $profile_json,
  "channel": "$CHANNEL",
  "version": "$VERSION",
  "sourceSha": "$SOURCE_SHA",
  "platform": "$PLATFORM",
  "layoutVersion": $LAYOUT_VERSION
}
JSON
  # Writing into the payload root moved two mtimes: the file's and the root
  # directory's. Both are archive members, so re-normalize the whole payload
  # rather than reasoning about which two entries moved.
  normalize_mtimes "$payload"
}

# ---------------------------------------------------------------------------
# 1. Controller
# ---------------------------------------------------------------------------

echo "==> controller bundle (esbuild, $NODE_TARGET)"
CONTROLLER="$WORK/controller"
mkdir -p "$CONTROLLER/libexec/bin"

"$ESBUILD" "$REPO_ROOT/src/cli/index.ts" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target="$NODE_TARGET" \
  --outfile="$CONTROLLER/libexec/bin/somawork" \
  --log-level=warning
chmod 755 "$CONTROLLER/libexec/bin/somawork"

# Generated by node, not by a heredoc.
#
# `$LICENSE_ID` is repository-supplied text landing inside a JSON string: a value
# carrying a quote or a backslash would close that string early and produce a
# manifest `readControllerVersion` cannot parse — the same class of bug as an
# unquoted shell interpolation, one layer up. `JSON.stringify` is the escaping
# authority, and the values reach node through the environment rather than argv
# so nothing re-parses them on the way in. Two-space indent and a trailing
# newline: byte-for-byte what the heredoc emitted, because two packaging runs of
# the same inputs must still produce the same archive.
SOMAWORK_PKG_VERSION="$VERSION" \
SOMAWORK_PKG_LICENSE="$LICENSE_ID" \
SOMAWORK_PKG_MIN_NODE="$MINIMUM_NODE" \
node -e '
const env = process.env;
const manifest = {
  name: "somawork-cli",
  version: env.SOMAWORK_PKG_VERSION,
  description: "somawork controller CLI",
  license: env.SOMAWORK_PKG_LICENSE,
  private: true,
  bin: { somawork: "libexec/bin/somawork" },
  engines: { node: ">=" + env.SOMAWORK_PKG_MIN_NODE },
};
process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
' > "$CONTROLLER/package.json"

copy_license "$CONTROLLER"
write_metadata "$CONTROLLER" "somawork-cli" "null"
chmod -R go-w "$CONTROLLER"
normalize_mtimes "$CONTROLLER"
make_archive "$CONTROLLER" "$OUT_DIR/$CONTROLLER_ASSET"
echo "    $CONTROLLER_ASSET"

# ---------------------------------------------------------------------------
# 2. Runtime payload (staged tree + production dependencies)
# ---------------------------------------------------------------------------

RUNTIME="$WORK/runtime"
if [[ -n "$STAGED_RUNTIME" ]]; then
  [[ -d "$STAGED_RUNTIME" ]] || die "--staged-runtime is not a directory: $STAGED_RUNTIME"
  echo "==> runtime payload (staged tree supplied)"
  mkdir -p "$RUNTIME"
  cp -R "$STAGED_RUNTIME/." "$RUNTIME/"
else
  echo "==> runtime payload (scripts/deploy/stage-bundle.sh)"
  # Runs the authoritative staged-artifact gate as its last step; nothing here
  # re-implements or weakens it.
  ( cd "$REPO_ROOT" && bash scripts/deploy/stage-bundle.sh "$RUNTIME" >/dev/null )
fi

[[ -d "$RUNTIME" ]] || die "runtime payload was not produced"
# Nested as well as root: `stage-bundle.sh` prunes every `node_modules`, and a
# staged tree that still had one would put unreviewed bytes in a public archive.
if [[ -n "$(find "$RUNTIME" -type d -name node_modules -print -quit)" ]]; then
  die "the staged runtime already carries node_modules; refusing to package it"
fi

if [[ -n "$DEPENDENCY_OVERLAY" ]]; then
  [[ -d "$DEPENDENCY_OVERLAY" ]] || die "--dependency-overlay is not a directory: $DEPENDENCY_OVERLAY"
  # Overlaid onto the payload ROOT, not into `node_modules`. `npm ci` does not
  # put every production dependency in one directory: a workspace with an
  # unhoistable dependency (here `somalib` -> the `soma-lib` tarball) gets its
  # own nested `somalib/node_modules`. A flag that only accepted the root tree
  # produced archives that were quietly missing it.
  echo "==> production dependencies (supplied overlay)"
  cp -R "$DEPENDENCY_OVERLAY/." "$RUNTIME/"
else
  echo "==> production dependencies (npm ci --omit=dev, clean cache)"
  # The same command `scripts/deploy/install-target.sh` runs on a fleet target,
  # against a cache this run owns so a warm developer cache cannot change what
  # lands in a public archive. Playwright's browser download is skipped: browsers
  # install into the user's cache directory, never into this tree, so fetching
  # ~400 MB here would change nothing about the archive.
  (
    cd "$RUNTIME" &&
      npm_config_cache="$WORK/npm-cache" \
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
      npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund >/dev/null
  )
fi

[[ -d "$RUNTIME/node_modules" ]] || die "production dependencies were not installed"

# `stage-bundle.sh` copies an allowlist of root files and LICENSE is not on it —
# the fleet deploy installs onto machines that already have the repository. A
# public archive has no such checkout behind it, so the grant is added here,
# where the public payload is assembled, rather than by widening the staging
# allowlist for an audience that does not need it.
copy_license "$RUNTIME"

chmod -R go-w "$RUNTIME"
normalize_mtimes "$RUNTIME"

echo "==> runtime archives"
write_metadata "$RUNTIME" "somawork" '"production"'
make_archive "$RUNTIME" "$OUT_DIR/$PRODUCTION_ASSET"
echo "    $PRODUCTION_ASSET"

write_metadata "$RUNTIME" "somawork-preview" '"preview"'
make_archive "$RUNTIME" "$OUT_DIR/$PREVIEW_ASSET"
echo "    $PREVIEW_ASSET"

# ---------------------------------------------------------------------------
# 3. Manifest + gate
# ---------------------------------------------------------------------------

echo "==> manifest"
"$TSX" "$REPO_ROOT/scripts/release/render-manifest.ts" \
  --version "$VERSION" \
  --channel "$CHANNEL" \
  --tag "$TAG" \
  --source-sha "$SOURCE_SHA" \
  --platform "$PLATFORM" \
  --minimum-node "$MINIMUM_NODE" \
  --layout-version "$LAYOUT_VERSION" \
  --base-url "$RELEASE_BASE_URL" \
  --asset "package=somawork-cli,profile=none,file=$OUT_DIR/$CONTROLLER_ASSET" \
  --asset "package=somawork,profile=production,file=$OUT_DIR/$PRODUCTION_ASSET" \
  --asset "package=somawork-preview,profile=preview,file=$OUT_DIR/$PREVIEW_ASSET" \
  --out "$OUT_DIR/$MANIFEST_ASSET"
echo "    $MANIFEST_ASSET"

echo "==> archive gate"
# Every archive is extracted and checked on its own — the staged-tree gate never
# saw the dependencies, and neither gate has ever seen a tar. A failure here
# leaves the assets on disk so they can be inspected, but the non-zero exit is
# what any publisher must key on.
node "$REPO_ROOT/scripts/smoke/package-archives.js" --manifest "$OUT_DIR/$MANIFEST_ASSET"

echo
echo "OK release assets in $OUT_DIR (version $VERSION, channel $CHANNEL, source $SOURCE_SHA)"
