#!/bin/bash
# Step 00: Welcome & Fork Check
# Verifies this is a forked repo and cleans up legacy services.

run_step() {
    step_header "00" "Welcome & Fork Check"

    if ! should_run_step "00" "Welcome & Fork Check"; then
        return 0
    fi

    # --- Fork check ---
    local remote_url
    remote_url=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || echo "")

    if [[ -z "$remote_url" ]]; then
        error "No git remote 'origin' found."
        echo "  This script should be run from a cloned/forked repository."
        return 1
    fi

    echo -e "Repository: ${CYAN}$remote_url${NC}"

    # Check if this is the original repo
    if [[ "$remote_url" == *"2lab-ai/soma-work"* ]]; then
        warn "This appears to be the original 2lab-ai/soma-work repository."
        echo ""
        echo -e "  To deploy your own instance, you should:"
        echo -e "  1. Fork this repo to your own GitHub account/org"
        echo -e "  2. Clone your fork"
        echo -e "  3. Run this wizard from your fork"
        echo ""
        echo -e "  ${DIM}This is needed so you can configure your own:"
        echo -e "  - GitHub Actions self-hosted runner"
        echo -e "  - GitHub Environment secrets"
        echo -e "  - Deploy workflows${NC}"
        echo ""
        if ! ask_confirm "Continue anyway (for local dev only)?" "N"; then
            echo "Fork the repo first, then re-run."
            return 1
        fi
    else
        success "Fork detected: $remote_url"
    fi

    # Save repo info
    local owner_repo
    owner_repo=$(echo "$remote_url" | sed -E 's|.*github\.com[:/]||' | sed 's/\.git$//')
    set_state "repo_url" "$remote_url"
    set_state "owner_repo" "$owner_repo"

    # --- Legacy service cleanup ---
    echo ""
    info "Checking for legacy services..."

    local found_legacy=false

    # Check LaunchDaemons (old sudo-based)
    for old_plist in /Library/LaunchDaemons/com.dd.claude-slack-bot.plist \
                     /Library/LaunchDaemons/com.dd.soma-work.plist; do
        if [[ -f "$old_plist" ]]; then
            found_legacy=true
            warn "Found legacy LaunchDaemon: $old_plist"
            if ask_confirm "  Stop and remove?" "Y"; then
                sudo launchctl unload "$old_plist" 2>/dev/null || true
                sudo rm "$old_plist"
                success "  Removed: $old_plist"
            fi
        fi
    done

    # Check LaunchAgents (old naming)
    for old_plist in "$HOME/Library/LaunchAgents/com.dd.claude-slack-bot.plist" \
                     "$HOME/Library/LaunchAgents/com.dd.soma-work.plist"; do
        if [[ -f "$old_plist" ]]; then
            found_legacy=true
            warn "Found legacy LaunchAgent: $old_plist"
            if ask_confirm "  Stop and remove?" "Y"; then
                launchctl unload "$old_plist" 2>/dev/null || true
                rm "$old_plist"
                success "  Removed: $old_plist"
            fi
        fi
    done

    if ! $found_legacy; then
        success "No legacy services found"
    fi

    mark_step_done "00"
    return 0
}
