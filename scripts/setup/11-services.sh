#!/bin/bash
#
# ============================== DEPRECATED ==============================
# UNREACHABLE. Nothing invokes this file.
#
# The only caller was scripts/setup-wizard-macos.sh, which is now a shim that
# `exec somawork setup`. Onboarding is `somawork setup`: it authorizes Slack
# through the Slack CLI and captures the runtime tokens over a profile-scoped
# Unix socket into a 0600 secrets.env — no terminal token prompt, no
# repo-relative .env, no /opt materialization.
#
# This directory is excluded from the runtime bundle
# (scripts/deploy/stage-bundle.sh; enforced by scripts/smoke/setup-package.js)
# and is scheduled for DELETION once the clean-machine receipt for
# `somawork setup` is green. Do not extend it, and do not wire a new caller.
# ========================================================================

# Mechanical enforcement of the banner above. The comment asserted
# unreachability; this makes it true for both entry paths -- direct execution
# and `source`. The credential-collecting bodies below are still live code, and
# these files survive until the clean-machine receipt, so the invariant is
# enforced rather than described.
printf '%s\n' "$(basename "${BASH_SOURCE[0]:-$0}") is deprecated and unreachable; run \`somawork setup\`." >&2
return 1 2>/dev/null || exit 1
# Step 11: Service Install
# Installs LaunchAgents for main/dev environments via scripts/service.sh.

run_step() {
    step_header "11" "Service Install"

    if ! should_run_step "11" "Services installed"; then
        return 0
    fi

    local deploy_envs
    deploy_envs=$(get_state "deploy_envs" "")

    if [[ -z "$deploy_envs" ]]; then
        warn "No deploy environments configured. Skipping service install."
        echo -e "  ${DIM}Install manually: ./scripts/service.sh main install${NC}"
        mark_step_done "11"
        return 0
    fi

    local service_sh="$REPO_DIR/scripts/service.sh"

    for env in $(echo "$deploy_envs" | tr ',' ' '); do
        local dir="/opt/soma-work/$env"
        local plist="$HOME/Library/LaunchAgents/ai.2lab.soma-work.${env}.plist"

        echo ""
        info "Installing $env service..."

        if [[ ! -d "$dir" ]]; then
            warn "  $dir not found. Skipping."
            continue
        fi

        # Check if .env exists in deploy dir
        if [[ ! -f "$dir/.env" ]]; then
            warn "  $dir/.env not found. Service will fail without it."
            echo -e "  Run step 08 first, or copy manually."
            continue
        fi

        if [[ -f "$plist" ]]; then
            # Already installed -- restart
            info "  LaunchAgent exists, restarting..."
            launchctl unload "$plist" 2>/dev/null || true
            sleep 1
        fi

        # Use scripts/service.sh to install
        bash "$service_sh" "$env" install
        sleep 2

        # Check if running
        if launchctl list 2>/dev/null | grep -q "ai.2lab.soma-work.${env}"; then
            local pid
            pid=$(launchctl list 2>/dev/null | grep "ai.2lab.soma-work.${env}" | awk '{print $1}')
            success "  $env service running (PID: $pid)"
        else
            warn "  $env service installed but not running. Check logs:"
            echo -e "    ${CYAN}./scripts/service.sh $env logs stderr${NC}"
        fi

        set_state "service_${env}" "installed"
    done

    mark_step_done "11"
    return 0
}
