#!/bin/bash
# Step 10: GitHub Actions Runner
# Downloads, configures, and installs a self-hosted runner.

RUNNER_DIR="$HOME/actions-runner"

run_step() {
    step_header "10" "GitHub Actions Runner"

    if ! should_run_step "10" "GitHub Actions runner installed"; then
        return 0
    fi

    local owner_repo
    owner_repo=$(get_state "owner_repo" "")

    if [[ -z "$owner_repo" ]]; then
        warn "No repository configured. Skipping runner setup."
        mark_step_done "10"
        return 0
    fi

    # Check if runner is already registered and online
    local runner_status
    runner_status=$(gh api "repos/$owner_repo/actions/runners" --jq '.runners[0].status' 2>/dev/null || echo "")

    if [[ "$runner_status" == "online" ]]; then
        local runner_name
        runner_name=$(gh api "repos/$owner_repo/actions/runners" --jq '.runners[0].name' 2>/dev/null)
        success "Runner already registered and online: $runner_name"
        if ! ask_confirm "Reinstall runner?" "N"; then
            mark_step_done "10"
            return 0
        fi
    fi

    echo -e "Setting up GitHub Actions self-hosted runner."
    echo -e "  Directory: ${CYAN}$RUNNER_DIR${NC}"
    echo ""

    # Determine architecture
    local arch
    arch=$(uname -m)
    local runner_arch
    case "$arch" in
        arm64) runner_arch="osx-arm64" ;;
        x86_64) runner_arch="osx-x64" ;;
        *) error "Unsupported architecture: $arch"; return 1 ;;
    esac

    # Get latest runner version
    info "Finding latest runner version..."
    local latest_version
    latest_version=$(gh api repos/actions/runner/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^v//')
    if [[ -z "$latest_version" ]]; then
        latest_version="2.322.0"
        warn "Could not determine latest version, using $latest_version"
    fi
    echo -e "  Version: $latest_version ($runner_arch)"

    # Download and extract
    mkdir -p "$RUNNER_DIR"
    local tarball="actions-runner-${runner_arch}-${latest_version}.tar.gz"
    local download_url="https://github.com/actions/runner/releases/download/v${latest_version}/${tarball}"

    if [[ ! -f "$RUNNER_DIR/config.sh" ]]; then
        info "Downloading runner..."
        curl -sL -o "$RUNNER_DIR/$tarball" "$download_url"
        cd "$RUNNER_DIR"
        tar xzf "$tarball"
        rm -f "$tarball"
        success "Runner extracted"
    else
        success "Runner binary already present"
    fi

    # Get registration token
    info "Getting registration token..."
    local reg_token
    reg_token=$(gh api -X POST "repos/$owner_repo/actions/runners/registration-token" --jq '.token' 2>/dev/null)
    if [[ -z "$reg_token" ]]; then
        error "Could not get registration token. Do you have admin access?"
        return 1
    fi

    # Runner name
    local runner_name
    runner_name=$(ask_value "Runner name" "runner_name" "$(hostname -s)")

    # Configure
    info "Configuring runner..."
    cd "$RUNNER_DIR"

    # Remove old config if exists
    if [[ -f ".runner" ]]; then
        ./config.sh remove --token "$reg_token" 2>/dev/null || true
    fi

    ./config.sh \
        --url "https://github.com/$owner_repo" \
        --token "$reg_token" \
        --name "$runner_name" \
        --labels "self-hosted,macOS,ARM64,soma-work" \
        --unattended \
        --replace

    success "Runner configured: $runner_name"

    # Install as LaunchAgent
    info "Installing runner as LaunchAgent..."
    ./svc.sh install 2>/dev/null || true
    ./svc.sh start 2>/dev/null || true

    # Verify
    sleep 3
    runner_status=$(gh api "repos/$owner_repo/actions/runners" --jq '.runners[] | select(.name=="'"$runner_name"'") | .status' 2>/dev/null || echo "unknown")

    if [[ "$runner_status" == "online" ]]; then
        success "Runner is online!"
    else
        warn "Runner status: $runner_status (may need a moment to connect)"
    fi

    set_state "runner_name" "$runner_name"
    mark_step_done "10"
    return 0
}
