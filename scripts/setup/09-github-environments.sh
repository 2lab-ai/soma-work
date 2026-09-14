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
# Step 09: GitHub Environments (optional)
# Creates production/development environments on GitHub with branch policies.

run_step() {
    step_header "09" "GitHub Environments (optional)"

    if ! should_run_step "09" "GitHub Environments configured"; then
        return 0
    fi

    local repo_admin
    repo_admin=$(get_state "repo_admin" "false")
    local owner_repo
    owner_repo=$(get_state "owner_repo" "")

    if [[ "$repo_admin" != "true" ]]; then
        warn "Skipping: requires admin access to $owner_repo"
        echo -e "  ${DIM}You can set up environments manually at:${NC}"
        echo -e "  ${CYAN}https://github.com/$owner_repo/settings/environments${NC}"
        mark_step_done "09"
        return 0
    fi

    echo -e "GitHub Environments allow branch-specific deployment protection."
    echo -e "This creates 'production' and 'development' environments with branch policies."
    echo ""

    if ! ask_confirm "Create GitHub Environments?" "Y"; then
        info "Skipped."
        mark_step_done "09"
        return 0
    fi

    # Create production environment
    info "Creating 'production' environment..."
    gh api -X PUT "repos/$owner_repo/environments/production" \
        --input - <<'JSON' 2>/dev/null && success "  production created" || warn "  production may already exist"
{
    "deployment_branch_policy": {
        "protected_branches": false,
        "custom_branch_policies": true
    }
}
JSON

    # Add branch policy for deploy/prod
    gh api -X POST "repos/$owner_repo/environments/production/deployment-branch-policies" \
        --field name="deploy/prod" --field type="branch" 2>/dev/null || true
    success "  Branch policy: deploy/prod → production"

    # Create development environment
    info "Creating 'development' environment..."
    gh api -X PUT "repos/$owner_repo/environments/development" \
        --input - <<'JSON' 2>/dev/null && success "  development created" || warn "  development may already exist"
{
    "deployment_branch_policy": {
        "protected_branches": false,
        "custom_branch_policies": true
    }
}
JSON

    gh api -X POST "repos/$owner_repo/environments/development/deployment-branch-policies" \
        --field name="main" --field type="branch" 2>/dev/null || true
    success "  Branch policy: main → development"

    echo ""
    success "GitHub Environments configured"
    echo -e "  ${DIM}View at: https://github.com/$owner_repo/settings/environments${NC}"

    mark_step_done "09"
    return 0
}
