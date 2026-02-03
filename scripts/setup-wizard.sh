#!/bin/bash
# setup-wizard.sh - soma-work macOS Setup Wizard
#
# Interactive CLI wizard that configures everything needed to run
# soma-work on a macOS machine after forking the repository.
#
# Usage:
#   ./setup-wizard-macos.sh           # Run all steps
#   ./setup-wizard-macos.sh 07        # Resume from step 07
#   ./setup-wizard-macos.sh --status  # Show completion status
#
# Idempotent: re-running skips completed steps (press Enter to keep defaults).
# State saved to .setup-state (add to .gitignore).

set -euo pipefail

# Resolve through symlinks
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
    DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
SETUP_DIR="$SCRIPT_DIR/setup"

# Source common utilities
source "$SETUP_DIR/_common.sh"

# Load saved state
load_state

# --- Status command ---
if [[ "${1:-}" == "--status" ]]; then
    header "Setup Wizard Status"
    STEPS=(00 01 02 03 04 05 06 07 08 09 10 11 12)
    STEP_NAMES=(
        "Welcome & Fork Check"
        "Prerequisites"
        "Slack App Setup"
        "GitHub Integration"
        ".env Configuration"
        ".system.prompt Setup"
        "MCP Servers"
        "Deploy Directories"
        "Write Configs"
        "GitHub Environments"
        "GitHub Actions Runner"
        "Service Install"
        "Verification"
    )
    completed=0
    total=${#STEPS[@]}
    for i in "${!STEPS[@]}"; do
        step="${STEPS[$i]}"
        name="${STEP_NAMES[$i]}"
        if is_step_done "$step"; then
            echo -e "  ${GREEN}[done]${NC} Step $step: $name"
            ((completed++))
        else
            echo -e "  ${DIM}[    ]${NC} Step $step: $name"
        fi
    done
    echo ""
    echo -e "Progress: ${BOLD}$completed/$total${NC} steps completed"
    exit 0
fi

# --- Main wizard ---
header "soma-work Setup Wizard"
echo -e "This wizard will configure everything needed to run soma-work."
echo -e "Re-run at any time - completed steps will be skipped."
echo -e "${DIM}State saved to: .setup-state${NC}"
echo ""

# Determine start step
START_FROM="${1:-00}"

# Step files to execute in order
STEPS=(00 01 02 03 04 05 06 07 08 09 10 11 12)

for step in "${STEPS[@]}"; do
    # Skip steps before the start point
    if [[ "$step" < "$START_FROM" ]]; then
        continue
    fi

    # Find the step file
    step_file=$(ls "$SETUP_DIR/${step}-"*.sh 2>/dev/null | head -1)
    if [[ -z "$step_file" ]]; then
        warn "Step $step: file not found, skipping"
        continue
    fi

    # Source and run
    source "$step_file"
    if ! run_step; then
        echo ""
        error "Step $step failed."
        echo -e "  Re-run with: ${BOLD}./setup-wizard-macos.sh $step${NC}"
        exit 1
    fi
done

# --- Done ---
echo ""
header "Setup Complete!"
echo -e "All steps completed. Your soma-work deployment is ready."
echo ""
echo -e "Useful commands:"
echo -e "  ${CYAN}./service.sh main status${NC}    Check production service"
echo -e "  ${CYAN}./service.sh dev status${NC}     Check development service"
echo -e "  ${CYAN}./service.sh status-all${NC}     Check all environments"
echo -e "  ${CYAN}./service.sh main logs f${NC}    Stream production logs"
echo ""
echo -e "To reconfigure: ${BOLD}./setup-wizard-macos.sh${NC}"
echo -e "To check status: ${BOLD}./setup-wizard-macos.sh --status${NC}"
