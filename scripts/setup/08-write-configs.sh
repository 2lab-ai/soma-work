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
# Step 08: Write Configs to Deploy Directories
# Copies .env, .system.prompt, config.json to each deploy dir.

run_step() {
    step_header "08" "Write Configs to Deploy Directories"

    if ! should_run_step "08" "Configs written to deploy dirs"; then
        return 0
    fi

    local deploy_envs
    deploy_envs=$(get_state "deploy_envs" "")

    if [[ -z "$deploy_envs" ]]; then
        warn "No deploy environments configured. Skipping."
        mark_step_done "08"
        return 0
    fi

    local config_files=(".env" ".system.prompt" "config.json")

    for env in $(echo "$deploy_envs" | tr ',' ' '); do
        local dir="/opt/soma-work/$env"

        if [[ ! -d "$dir" ]]; then
            warn "$dir does not exist. Run step 07 first."
            continue
        fi

        echo ""
        info "Writing configs to $dir..."

        for f in "${config_files[@]}"; do
            local src="$REPO_DIR/$f"
            local dst="$dir/$f"

            if [[ ! -f "$src" ]]; then
                warn "  $f not found in repo (skipping)"
                continue
            fi

            if [[ -f "$dst" ]]; then
                # Compare
                if diff -q "$src" "$dst" &>/dev/null; then
                    success "  $f (unchanged)"
                    continue
                fi

                if ask_confirm "  $f differs in $dir. Overwrite?" "Y"; then
                    cp "$src" "$dst"
                    success "  $f updated"
                else
                    info "  $f kept as-is"
                fi
            else
                cp "$src" "$dst"
                success "  $f copied"
            fi

            # Secure .env
            [[ "$f" == ".env" ]] && chmod 600 "$dst"
        done
    done

    mark_step_done "08"
    return 0
}
