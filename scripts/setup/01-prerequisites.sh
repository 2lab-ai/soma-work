#!/bin/bash
# Step 01: Prerequisites Check
# Verifies required tools are installed and gh is authenticated.

run_step() {
    step_header "01" "Prerequisites"

    if ! should_run_step "01" "Prerequisites verified"; then
        return 0
    fi

    local all_ok=true

    # --- Required tools ---
    info "Checking required tools..."
    echo ""

    # Node.js
    if check_command "node" "Node.js"; then
        echo -e "  Version: $(node --version)"
        local node_major
        node_major=$(node --version | sed 's/v//' | cut -d. -f1)
        if [[ "$node_major" -lt 18 ]]; then
            warn "  Node.js 18+ recommended (found v$node_major)"
        fi
        set_state "node_path" "$(detect_node_path)"
    else
        error "  Install Node.js 18+: https://nodejs.org or use nvm"
        all_ok=false
    fi

    # npm
    if check_command "npm"; then
        echo -e "  Version: $(npm --version)"
    else
        all_ok=false
    fi

    # git
    if check_command "git"; then
        echo -e "  Version: $(git --version | awk '{print $3}')"
    else
        error "  Install git: xcode-select --install"
        all_ok=false
    fi

    # GitHub CLI
    if check_command "gh" "GitHub CLI"; then
        echo -e "  Version: $(gh --version | head -1 | awk '{print $3}')"
    else
        error "  Install: brew install gh"
        all_ok=false
    fi

    if ! $all_ok; then
        error "Missing required tools. Install them and re-run."
        return 1
    fi

    echo ""

    # --- gh auth check ---
    info "Checking GitHub CLI authentication..."

    if ! gh auth status &>/dev/null; then
        warn "GitHub CLI not authenticated."
        echo -e "  Run: ${CYAN}gh auth login${NC}"
        echo ""
        if ask_confirm "Run 'gh auth login' now?" "Y"; then
            gh auth login
        else
            error "gh auth required for runner setup and environment configuration."
            return 1
        fi
    fi

    # Show authenticated user
    local gh_user
    gh_user=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
    success "Authenticated as: $gh_user"
    set_state "gh_user" "$gh_user"

    # --- Verify repo access ---
    local owner_repo
    owner_repo=$(get_state "owner_repo")

    if [[ -n "$owner_repo" ]]; then
        echo ""
        info "Verifying repository access..."
        local perms
        perms=$(gh api "repos/$owner_repo" --jq '.permissions.admin' 2>/dev/null || echo "false")
        if [[ "$perms" == "true" ]]; then
            success "Admin access to $owner_repo confirmed"
        else
            warn "No admin access to $owner_repo"
            echo -e "  Some features (runner setup, environments) require admin access."
            echo -e "  You can still configure local deployment."
        fi
        set_state "repo_admin" "$perms"
    fi

    mark_step_done "01"
    return 0
}
