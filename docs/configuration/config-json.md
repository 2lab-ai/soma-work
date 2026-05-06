# config.json

The single configuration file for soma-work. It carries:

- `mcpServers` — Model Context Protocol servers wired into Claude Agent SDK
- `server-tools` — internal tool servers (DB, SSH, logs, …) and per-tool permission levels
- `agents` — multi-tenant Slack agent registrations (tokens, persona, prompt dir)
- `claude.env` — operator-controlled env vars injected into every Claude SDK subprocess
- `plugin` — marketplace + plugin enablement
- `a2t` — audio-to-text settings

This page covers two things:

1. Where `config.json` lives and how it is loaded
2. **`${VAR}` environment variable substitution** — how to keep secrets out of the file

## Where the file lives

Resolution is in `src/env-paths.ts`. Two modes:

| Mode | Trigger | `config.json` path | `.env` path |
|---|---|---|---|
| **Explicit** | `SOMA_CONFIG_DIR=/path` | `${SOMA_CONFIG_DIR}/config.json` | `${SOMA_CONFIG_DIR}/.env` |
| **Branch-aware** | (no env var) | `<repo>/config.json` on `main`, `<repo>/config.dev.json` otherwise | `<repo>/.env` or `<repo>/.env.dev` |

Legacy `mcp-servers.json` was removed in PR #808 — operators with that file should move its contents under the `mcpServers` key in `config.json`.

## Environment variable substitution

Any string value in `config.json` may reference `${VAR}` placeholders. The loader resolves them at parse time, before any structural validation runs.

### Example

```jsonc
{
  "mcpServers": {
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "headers": {
        "Authorization": "Basic ${JIRA_PAT_TOKEN}"
      }
    }
  }
}
```

With `JIRA_PAT_TOKEN=abc123` in `.env` or the OS environment, the loader produces:

```json
"Authorization": "Basic abc123"
```

### Supported syntax

| Form | Behavior |
|---|---|
| `${VAR}` | Replaced with `process.env.VAR`. If unset, the placeholder is **left verbatim** and a one-shot warning is logged. |
| `${VAR:-default}` | `process.env.VAR` if set **and non-empty**, otherwise `default`. Same semantics as Bash / Docker Compose. |
| `${VAR:?msg}` | `process.env.VAR` if set and non-empty, otherwise the loader **throws** with `msg`. Use for required secrets where a missing value should fail-fast at boot rather than silently 401 at request time. |
| `$$` | A literal `$`. Escape needed when a real `$` would otherwise be misread as the start of `${...}`. |

Plain `$VAR` (no braces) is **not** substituted. Only `${...}` is recognized — this avoids surprises with shell-style variables in paths and command lines.

### The "verbatim on missing" rule

When `${VAR}` is unreferenced and there's no default, the placeholder text is preserved unchanged in the loaded value. So a missing `JIRA_PAT_TOKEN` produces:

```
Authorization: Basic ${JIRA_PAT_TOKEN}
```

That string is sent to the remote server, which replies 401. The 401 plus the warning at boot makes the failure mode visible. The alternative — silently substituting an empty string — produces `Authorization: Basic ` and the same operator wonders why the token "doesn't work" a week later.

If you want a hard failure at boot instead, opt in with `${VAR:?...}`.

### What never gets logged

Substituted values are never logged. Only placeholder **names** appear in warnings, and only once per name per process. Operators put secrets in env vars precisely because they shouldn't reach stdout — the loader respects that.

## `.env` discovery

The loader tries three paths in priority order on every config load:

1. `${cwd}/.env`
2. Same directory as the resolved `config.json`
3. Parent of that directory

First-writer-wins: a variable already present in `process.env` (set by the OS, by an earlier dotenv load, or by `env-paths.ts` at module init) is **not** overwritten. So:

- OS env vars beat `.env` files (12-factor friendly — production secrets stay outside the repo)
- `${cwd}/.env` beats a `.env` next to the config (running from the repo root in development uses the repo's `.env`)
- A `.env` next to the config beats one in its parent (per-deployment overrides win over shared defaults)

Files that don't exist are silently skipped. Each file is parsed at most once per process (the dedupe survives multiple `loadUnifiedConfig` calls from boot + plugin-manager saves).

## Common patterns

### Atlassian MCP with a scoped API token

```jsonc
{
  "mcpServers": {
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "headers": {
        "Authorization": "Basic ${JIRA_PAT_TOKEN}"
      }
    }
  }
}
```

`.env`:

```
JIRA_PAT_TOKEN=ZGV2MUBleGFtcGxlLmNvbTpBVEFUVDN4Rg...
```

Generate the token at <https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=mcp&selectedScopes=all>; then base64-encode `email:token` *without* a trailing newline:

```bash
printf '%s' 'you@example.com:ATATT3xFf...' | base64 -w0
```

(`echo "..." | base64` produces a base64 string with `\n` in the encoded payload. Some Atlassian endpoints trim it, others 401; `printf` avoids the question entirely.)

### Failing fast on missing required secrets

```jsonc
{
  "mcpServers": {
    "atlassian": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "headers": {
        "Authorization": "Basic ${JIRA_PAT_TOKEN:?set JIRA_PAT_TOKEN in .env or the OS environment}"
      }
    }
  }
}
```

If `JIRA_PAT_TOKEN` is unset, boot aborts with that exact message — surfaced before any agent starts taking traffic.

### Per-environment defaults

```jsonc
{
  "mcpServers": {
    "atlassian": {
      "type": "http",
      "url": "${ATLASSIAN_MCP_URL:-https://mcp.atlassian.com/v1/mcp}",
      "headers": {
        "Authorization": "Basic ${JIRA_PAT_TOKEN}"
      }
    }
  }
}
```

Production overrides `ATLASSIAN_MCP_URL` to a regional endpoint; dev and CI use the default.

## Things to avoid

- **Slack auto-link brackets in URLs.** When you paste a URL into Slack and copy from a quoted message, you can end up with `"<https://...>"` literally in JSON. The loader does not strip these — it would mask a real typo in another value. Strip them yourself.
- **`echo "email:token" | base64`** — see the `printf` note above.
- **Secrets in committed config.** Use `${VAR}` references and put the actual values in `.env` (gitignored).
- **Plain `$VAR` (no braces).** Not substituted. Always wrap in `${...}`.

## Where the substitution happens in code

- `src/config-env-substitution.ts` — pure substitution + `.env` discovery
- `src/unified-config-loader.ts` — calls `loadDotenvForConfig` then `substituteEnvVars` before structural validation
- `src/mcp-config-builder.ts` — applies the same substitution to `server-tools` entries

## Tests

- `src/__tests__/config-env-substitution.test.ts` — grammar, `.env` priority, dedupe, secret-leak guard
- `src/__tests__/unified-config-loader.test.ts` — integration through `loadUnifiedConfig` (`mcpServers` headers, `${VAR:-default}`, verbatim-on-missing)
