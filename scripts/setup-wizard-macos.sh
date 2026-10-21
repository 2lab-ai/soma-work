#!/bin/bash
# setup-wizard-macos.sh — DEPRECATED compatibility shim.
#
# See scripts/setup-wizard.sh. macOS ARM64 is the only supported platform, so
# there is no longer a platform-specific wizard to be the "macOS" one of.
set -euo pipefail

echo "scripts/setup-wizard-macos.sh is deprecated; running \`somawork setup\` instead." >&2
exec somawork setup "$@"
