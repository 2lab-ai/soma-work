#!/bin/bash
# Step 05: .system.prompt Setup
# Collects repo list and generates .system.prompt.

run_step() {
    step_header "05" ".system.prompt Setup"

    if ! should_run_step "05" ".system.prompt configured"; then
        return 0
    fi

    echo -e "The system prompt tells the bot which repositories to work with."
    echo -e "Enter GitHub repository URLs (one per line, empty line to finish):"
    echo ""

    # Load existing repos from state
    local existing_repos
    existing_repos=$(get_state "repos" "")
    if [[ -n "$existing_repos" ]]; then
        echo -e "${DIM}Previously configured repos:${NC}"
        echo "$existing_repos" | tr ',' '\n' | while read -r r; do
            [[ -n "$r" ]] && echo -e "  ${DIM}- $r${NC}"
        done
        echo ""
        if ! ask_confirm "Reconfigure repo list?" "N"; then
            success "Keeping existing .system.prompt"
            mark_step_done "05"
            return 0
        fi
    fi

    local repos=()
    while true; do
        echo -en "${BOLD}Repo URL${NC} (or Enter to finish): "
        local url
        read -r url
        [[ -z "$url" ]] && break
        repos+=("$url")
    done

    if [[ ${#repos[@]} -eq 0 ]]; then
        warn "No repos entered. Using example template."
        repos=("https://github.com/example/repo")
    fi

    # Save repo list to state (comma-separated)
    local repos_csv
    repos_csv=$(IFS=','; echo "${repos[*]}")
    set_state "repos" "$repos_csv"

    # Collect PR target branch
    local pr_target
    pr_target=$(ask_value "Default PR target branch" "pr_target" "develop")

    # Generate .system.prompt
    local prompt_file="$REPO_DIR/.system.prompt"
    {
        echo "# Facts"
        echo "## Repository"
        for repo in "${repos[@]}"; do
            echo "- $repo"
            echo "  - PR target: $pr_target"
        done
    } > "$prompt_file"

    success ".system.prompt written (${#repos[@]} repos)"
    mark_step_done "05"
    return 0
}
