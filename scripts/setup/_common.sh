#!/bin/bash
# _common.sh - Shared utilities for setup wizard
# Sourced by all step scripts. Do not run directly.
# Compatible with macOS bash 3.2 (no associative arrays).

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Paths ---
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_FILE="$REPO_DIR/.setup-state"
SCRIPTS_DIR="$REPO_DIR/scripts/setup"

# --- Output helpers ---
info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
header()  { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════${NC}"; echo -e "${BOLD}${CYAN}  $1${NC}"; echo -e "${BOLD}${CYAN}══════════════════════════════════════${NC}\n"; }
step_header() { header "Step $1: $2"; }

# --- State management ---
# File-based key=value store. No associative arrays (bash 3.2 compatible).

load_state() {
    if [[ ! -f "$STATE_FILE" ]]; then
        touch "$STATE_FILE"
    fi
}

get_state() {
    local key="$1"
    local default="${2:-}"
    local val
    val=$(grep "^${key}=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    echo "${val:-$default}"
}

set_state() {
    local key="$1"
    local value="$2"

    if [[ ! -f "$STATE_FILE" ]]; then
        echo "# soma-work setup state - DO NOT COMMIT" > "$STATE_FILE"
    fi

    # Remove existing key, then append
    local tmp="${STATE_FILE}.tmp"
    grep -v "^${key}=" "$STATE_FILE" > "$tmp" 2>/dev/null || true
    echo "${key}=${value}" >> "$tmp"
    mv "$tmp" "$STATE_FILE"
}

# --- User input helpers ---

# Ask for a value with optional default (from state or provided)
# Usage: result=$(ask_value "Prompt text" "state_key" "fallback_default")
ask_value() {
    local prompt="$1"
    local state_key="$2"
    local fallback="${3:-}"
    local default_val
    default_val=$(get_state "$state_key" "$fallback")

    if [[ -n "$default_val" ]]; then
        echo -en "${BOLD}$prompt${NC} ${DIM}[$default_val]${NC}: " >&2
    else
        echo -en "${BOLD}$prompt${NC}: " >&2
    fi

    local input
    read -r input
    local result="${input:-$default_val}"

    if [[ -n "$state_key" && -n "$result" ]]; then
        set_state "$state_key" "$result"
    fi

    echo "$result"
}

# Ask for a secret value (not stored in state, not echoed)
# Usage: result=$(ask_secret "Prompt text" "current_hint")
ask_secret() {
    local prompt="$1"
    local hint="${2:-}"

    if [[ -n "$hint" ]]; then
        echo -en "${BOLD}$prompt${NC} ${DIM}[${hint}...press Enter to keep]${NC}: " >&2
    else
        echo -en "${BOLD}$prompt${NC}: " >&2
    fi

    local input
    read -rs input
    echo "" >&2  # newline after hidden input

    echo "$input"
}

# Ask yes/no with default
# Usage: ask_confirm "Question?" "Y" → returns 0 for yes, 1 for no
ask_confirm() {
    local prompt="$1"
    local default="${2:-Y}"

    local hint
    if [[ "$default" == "Y" || "$default" == "y" ]]; then
        hint="Y/n"
    else
        hint="y/N"
    fi

    echo -en "${BOLD}$prompt${NC} [$hint]: "
    local input
    read -r input
    input="${input:-$default}"

    [[ "$input" =~ ^[Yy] ]]
}

# Ask to choose from numbered options
# Usage: result=$(ask_choice "Pick one" "option1" "option2" "option3")
ask_choice() {
    local prompt="$1"
    shift
    local i=1

    echo -e "${BOLD}$prompt${NC}" >&2
    for opt in "$@"; do
        echo -e "  ${CYAN}${i})${NC} ${opt}" >&2
        i=$((i + 1))
    done
    echo -en "Choice [1]: " >&2

    local input
    read -r input
    input="${input:-1}"

    local idx=$((input))
    if [[ $idx -ge 1 && $idx -le $# ]]; then
        # Get the idx-th argument
        shift $((idx - 1))
        echo "$1"
    else
        echo "$1"  # first option as fallback
    fi
}

# Check if a step was completed
is_step_done() {
    [[ "$(get_state "step_$1")" == "done" ]]
}

# Mark step as completed
mark_step_done() {
    set_state "step_$1" "done"
}

# Ask to reconfigure a completed step
# Returns 0 if should run, 1 if should skip
should_run_step() {
    local step="$1"
    local desc="$2"

    if is_step_done "$step"; then
        echo -e "${GREEN}[DONE]${NC} $desc"
        if ask_confirm "  Reconfigure?" "N"; then
            return 0
        fi
        return 1
    fi
    return 0
}

# --- Validation helpers ---
check_command() {
    local cmd="$1"
    local name="${2:-$cmd}"
    if command -v "$cmd" &>/dev/null; then
        success "$name found: $(command -v "$cmd")"
        return 0
    else
        error "$name not found"
        return 1
    fi
}

# Get masked version of a secret for display (first N chars + ...)
mask_secret() {
    local val="$1"
    local show="${2:-6}"
    if [[ ${#val} -gt $show ]]; then
        echo "${val:0:$show}..."
    else
        echo "$val"
    fi
}

# Detect Node.js path (for service.sh)
detect_node_path() {
    local node_bin
    node_bin="$(which node 2>/dev/null)"
    if [[ -n "$node_bin" ]]; then
        dirname "$node_bin"
    else
        echo ""
    fi
}
