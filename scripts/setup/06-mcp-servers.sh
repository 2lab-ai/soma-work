#!/bin/bash
# Step 06: MCP Servers Configuration
# Lets user choose which MCP servers to enable.

run_step() {
    step_header "06" "MCP Servers"

    if ! should_run_step "06" "MCP servers configured"; then
        return 0
    fi

    echo -e "MCP (Model Context Protocol) servers extend the bot's capabilities."
    echo -e "Select which servers to enable:"
    echo ""

    local mcp_file="$REPO_DIR/mcp-servers.json"

    # Available servers
    local servers=("jira" "codex" "gemini")
    local descriptions=(
        "Jira - Atlassian Jira integration (SSE)"
        "Codex - OpenAI Codex integration (requires 'codex' CLI)"
        "Gemini - Google Gemini integration (requires @2lab.ai/gemini-mcp-server)"
    )

    local enabled=()

    for i in "${!servers[@]}"; do
        local srv="${servers[$i]}"
        local desc="${descriptions[$i]}"
        local default="N"

        # Check if previously enabled
        local prev_enabled
        prev_enabled=$(get_state "mcp_servers" "")
        if [[ "$prev_enabled" == *"$srv"* ]]; then
            default="Y"
        fi

        if ask_confirm "  Enable $desc?" "$default"; then
            enabled+=("$srv")
        fi
    done

    # Save enabled list
    local enabled_csv
    enabled_csv=$(IFS=','; echo "${enabled[*]}")
    set_state "mcp_servers" "$enabled_csv"

    # Generate mcp-servers.json
    {
        echo '{'
        echo '  "mcpServers": {'

        local first=true
        for srv in "${enabled[@]}"; do
            if ! $first; then
                echo ','
            fi
            first=false

            case "$srv" in
                jira)
                    echo -n '    "jira": { "type": "sse", "url": "https://mcp.atlassian.com/v1/sse" }'
                    ;;
                codex)
                    echo -n '    "codex": { "type": "stdio", "command": "codex", "args": ["mcp-server"], "env": {} }'
                    ;;
                gemini)
                    echo -n '    "gemini": { "type": "stdio", "command": "npx", "args": ["@2lab.ai/gemini-mcp-server"], "env": {} }'
                    ;;
            esac
        done

        echo ''
        echo '  }'
        echo '}'
    } > "$mcp_file"

    if [[ ${#enabled[@]} -eq 0 ]]; then
        echo '{ "mcpServers": {} }' > "$mcp_file"
        warn "No MCP servers enabled"
    else
        success "MCP servers configured: ${enabled_csv}"
    fi

    mark_step_done "06"
    return 0
}
