#!/bin/bash
# setup-wizard.sh — compatibility alias.
#
# The macOS setup wizard lives in `setup-wizard-macos.sh`. This file used to be
# a byte-for-byte copy; it now delegates so there is a single source of truth.
#
# Usage (identical to the wizard):
#   ./scripts/setup-wizard.sh           # Run all steps
#   ./scripts/setup-wizard.sh 07        # Resume from step 07
#   ./scripts/setup-wizard.sh --status  # Show completion status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/setup-wizard-macos.sh" "$@"
