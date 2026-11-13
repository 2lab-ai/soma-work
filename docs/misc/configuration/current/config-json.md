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

## `server-tools` section

The `server-tools` MCP server runs operational queries (DB read-only SQL, Docker `ps`/`logs`, Docker Swarm stack inspection) over SSH against named servers. Configuration lives under the `server-tools` key.

### Shape

```jsonc
{
  "server-tools": {
    "permission": {
      "list": "read",
      "list_service": "read",
      "list_stack": "read",
      "logs": "read",
      "db_query": "write"
    },
    "<server-name>": {
      "ssh": { "host": "<sshHost or alias>" },
      "databases": {
        "<db-alias>": {
          "type": "mysql" | "redis" | "mongodb" | "clickhouse",
          "host": "...", "port": 0, "user": "...", "password": "..."
        }
      }
    }
  }
}
```

`permission` is a reserved key — every other top-level key under `server-tools` is a server entry. Each server entry carries an `ssh.host` (resolved through your `~/.ssh/config`) and an optional `databases` map for DB-backed tools.

### Permission map

Per-tool levels follow the `read` / `write` convention from `mcp-tool-permission-config.ts`. `read` covers tools that only observe; `write` is required for anything that can mutate. The new `list_stack` tool is `read`-only — it just runs `docker stack ls`.

| Tool | Default level | Notes |
|---|---|---|
| `list` | `read` | List configured servers + database types |
| `list_service` | `read` | `docker ps` (default) or `docker stack services` (with `stack` arg) |
| `list_stack` | `read` | `docker stack ls` — Swarm-only |
| `logs` | `read` | `docker logs` (default) or `docker service logs` (with `stack` arg) |
| `db_query` | `write` | Read-only SQL via SSH tunnel — but treated as `write` because the validator gating SQL is non-trivial |
| `redis_query` / `mongodb_query` / `clickhouse_query` | `write` | Same rationale as `db_query` |

### Docker Swarm stack support

Standalone Docker (`docker ps` / `docker logs`) and Swarm-managed services (`docker stack ls` / `docker stack services` / `docker service logs`) share the same SSH host — there is **no per-mode config**. The same server entry handles both:

```jsonc
{
  "server-tools": {
    "permission": { "list_service": "read", "list_stack": "read", "logs": "read" },
    "swarm-manager": {
      "ssh": { "host": "swarm-manager.example.com" }
    }
  }
}
```

Tool invocation (LLM side):

```jsonc
// List stacks deployed on the manager
{ "tool": "list_stack", "args": { "server": "swarm-manager" } }

// List services inside a specific stack
{ "tool": "list_service", "args": { "server": "swarm-manager", "stack": "myapp" } }

// Tail Swarm service logs (caller passes the full <stack>_<svc> name)
{ "tool": "logs",
  "args": { "server": "swarm-manager", "stack": "myapp", "service": "myapp_web", "tail": 200, "since": "10m" } }
```

Constraints worth knowing:

- `--until` is **not supported** when `stack` is set (`docker service logs` has no `--until` flag). The tool throws with a remediation hint.
- If the SSH host is not a Swarm manager, `list_stack` and `list_service` (with `stack`) throw `Server '<name>' is not a Docker Swarm manager` — typed error so the agent can suggest fixes immediately.
- Output for `list_stack` and `list_service` (with `stack`) is **opaque NDJSON pass-through** — field names differ between modes (e.g. `Names` from `docker ps` vs `Name` from `docker stack services`).

### Secrets

Every string value above accepts `${VAR}` substitution. Keep DB passwords out of the file:

```jsonc
{
  "server-tools": {
    "prod": {
      "ssh": { "host": "prod.example.com" },
      "databases": {
        "main": {
          "type": "mysql", "host": "127.0.0.1", "port": 3306,
          "user": "${PROD_DB_USER}",
          "password": "${PROD_DB_PASSWORD:?set PROD_DB_PASSWORD in .env}"
        }
      }
    }
  }
}
```

### Environment user and `gh_pr` (env-access WU3, #1211)

A server entry can stand for an environment that acts as its own user: `envUser` names it, and `github` gives it the
environment's own GitHub token and what it may approve and merge. The token is a `{"$secret": "<name>"}` reference into
the secret store (`<config dir>/secrets/<name>`); server-tools reads it outside every model sandbox and no model sees it.

```jsonc
{
  "server-tools": {
    "dev2": {
      "envUser": "env:acme-dev2",
      "skills": ["acme-env:deploy-dev2", "acme-env:qa-dev2"],
      "ssh": { "host": "dev2" },
      "github": {
        "token": { "$secret": "gh-org-admin" },
        "repos": ["acme/app"],
        "approveWhen": { "authors": ["soma-bot[bot]"], "bases": ["develop"] },
        "mergeWhen": { "authors": ["soma-bot[bot]"], "bases": ["develop"] },
        "mergeMethods": ["merge", "squash"],
        "requiredChecks": ["ci"]
      }
    }
  }
}
```

| `gh_pr` action | Runs when |
|---|---|
| `view` | the repository is one of `repos`. Returns state, author, base, head SHA and checks |
| `approve` | the PR is open and not a draft, its author is in `approveWhen.authors`, its base in `approveWhen.bases`, every check has reported and is green (unless `requiredChecksGreen` is `false`), and `sha` is still the head. If the head or base changes while the review is posted, the review is dismissed |
| `merge` | the same conditions under `mergeWhen`, and the method is in `mergeMethods` (default `merge` only). Head and base are read once more right before the merge, which is pinned to `sha` |

`token` must be a `{"$secret": …}` reference; a token written into config.json is ignored and the `github` section is
left out. Approve and merge refuse to run for a session that names no Slack user. A retarget in the last moment
before a merge is not caught by the tool — a branch rule on the repository is what keeps the environment's token
out of branches it must not touch.

`approve` and `merge` write an intent line to `DATA_DIR/env-audit/env-audit.jsonl` before they call GitHub, and a
`done` or `failed` line after. If the intent cannot be written, nothing is called. If only the outcome cannot be
written, the tool says the write was made and must not be retried. A write that gets no answer (a dropped
connection, the 30-second timeout, an unreadable body) is looked up — the environment's own approval at that SHA,
or whether the PR is merged — and recorded as `done` when found; anything short of that (not seen yet, a lookup
that fails or answers something unexpected) is recorded as `unknown` and the tool says to check the PR before
retrying. `authors`, `bases`, `repos`, `mergeMethods` and `requiredChecks` must be lists: a string there is refused,
since it would match by substring. Each line names the server, the `envUser` and the Slack user the session runs for.

"Every check is green" means: each required check has passed, and nothing else on the head is unfinished or red.
The required checks are `requiredChecks`, else the base branch's protection (its required status checks; a check
the protection binds to an app counts only from that app's check run — list it in `requiredChecks` if that app
reports a commit status instead). When neither names any, or the protection cannot be read, no PR is green — a
check that has not registered yet would otherwise go unseen. A server or gateway error (5xx) on approve or merge is
treated like no answer: the write is looked up. An approval carries a marker unique to the call, so a lost answer is
matched to that approval and never to an older one.

`skills` lists the environment-plugin skills that belong to this environment (`plugin:skill`, or `plugin:*`).
Entries that share an `envUser` are one environment. When a non-admin asks for one of its skills, the admins' card
offers **accept (this thread) · reject · this skill always · `<environment>` always**; the last one grants the requester
every skill of the environment and every server-tools tool on its servers (`ssh_exec` and `gh_pr` included), kept in
`DATA_DIR/env-skill-grants.json` `perEnvironment` (env-access WU4, #1212). A server-tools call that names one of
the environment's servers runs for a non-admin only on such a grant, or on a grant of one of its skills. On a server
that is no environment's, `ssh_exec`, `gh_pr` and `login` stay admin-only.

### Environment Cloudflare calls (`cf_api`, env-access WU6, #1214)

`cloudflare` gives an environment its own **scoped** Cloudflare API token and the zones it acts on. server-tools
reads the token from the secret store outside every model sandbox; no model sees it, and nothing hands it out.

```jsonc
{
  "server-tools": {
    "dev2": {
      "envUser": "env:acme-dev2",
      "cloudflare": {
        "token": { "$secret": "cf-dev2" },
        "zones": { "dev2.example": "0123456789abcdef0123456789abcdef" },
        "write": true
      }
    }
  }
}
```

`cf_api {server, method, path, query, body}` calls `https://api.cloudflare.com/client/v4<path>`. `path` is
`/zones/<id>/…` for one of `zones` (32-hex IDs), with plain segments only (no `..`, `//`, `%`, `\`, `?`, `#`); the
query goes in `query`. Paths with `token`, `member` or a `user…` segment are never reachable, whatever the token's
scope. Below the zone, only these parts are reachable: `dns_records`, `settings`, `purge_cache`, `ssl`,
`custom_hostnames`, `rate_limits`, `workers`, `load_balancers`, `analytics`, `cache`, plus any the operator lists in
`cloudflare.parts`. Parts that can answer with another system's credentials are reachable only once the operator lists
them: `healthchecks` (request headers), `rulesets`, `firewall`, `filters` and `pagerules` (static header values,
expressions, forwarding URLs), `logpush`. A redirect is never followed (a read fails, a write is `unknown`). The zone itself can be
read but never written: no delete, pause or plan change. `GET` always runs; `POST`/`PUT`/`PATCH`/`DELETE` only with `write: true`, for a session that names a Slack
user, with an intent line in `env-audit.jsonl` before the call and `done`/`failed` after. The line records the zone, the
path, the query and the SHA-256 of the body, but not the body itself. A 2xx whose body says `success: false` is
recorded `failed`; one whose body cannot be read, or does not say `success: true`, is recorded `unknown`; an empty
204 is `done`. A write that gets no answer (or a 5xx, or a 3xx) is recorded `unknown` and the tool says to check before
retrying. The body may be at most 64 KiB as UTF-8. Errors give Cloudflare's status
and `errors[]` codes and messages, with the token scrubbed. A token written into config.json is ignored and the
section left out. Like the other environment tools, `cf_api` is admin-only except on an environment's server for a
user that environment's admin granted.

This replaces the broker's Cloudflare leases (`cf_lease_request` / `cf_api` / `cf_lease_revoke`): instead of a
token-creating "forge" key that minted short-lived tokens behind a Slack card, the operator creates one scoped token
per environment (for example Zone · DNS · Edit on the environment's zones) and stores it under `secrets/`.

### Environment repository reads (`gh_read`, env-access WU5, #1213)

`gh_read {server, path, query}` GETs one path of the environment's repository with the same `github.token` that
`gh_pr` uses, outside every model sandbox. `path` is `repos/<owner>/<name>/…` with the repository in `github.repos`
and no query string (parameters go in `query`: strings, numbers, booleans). It reads only the routes deploy
confirmation and QA read, as an allowlist of path shapes: the repository itself; `pulls[/<n>[/files|commits|reviews|
comments|merge]]`; `commits[/<sha>[/check-runs|check-suites|status|statuses|pulls]]`; `compare/<base>...<head>`;
`issues[/<n>[/comments|events|labels]]` and `issues/comments|events[/<n>]`; `branches[/<b>]`; `contents/…`;
`statuses/<sha>`; check runs and suites; deployments; releases; tags; `git/ref(s)/…` and git objects; milestones;
labels; `actions/runs[/<id>[/jobs|attempts/<n>[/jobs]]]`, `actions/jobs/<id>`, `actions/workflows[/<id>[/runs]]`.
Not settings (`branches/<b>/protection`), secrets, variables, hooks, keys, environments or collaborators, and not
routes that answer with another repository's data (`issues/<n>/parent`, `sub_issues`, a timeline's
cross-references, a `compare` across forks with `owner:branch`, a branch path that reaches `protection`) — the token may be an org admin's. Segments may hold GitHub path characters (`(auth)`,
`alice:branch`, `a+b`); a segment that does not decode, or decodes to a `.`/`..` component, a backslash or a NUL,
is refused. It answers `{path, status, truncated, body}`: a 204 (`pulls/<n>/merge` of a merged PR) is
`body: null`; a body longer than 200000 characters of JSON comes back cut, as text, with `truncated: true`. The token never comes back: every string of the answer (and a base64 file's decoded content) and GitHub's error message have it replaced with `[redacted]`. Reads are not written to the audit ledger. Like `gh_pr`, it is admin-only except on an
environment's server for a user that environment's admin granted.

The QA skills (`deploy-qa`, `qa-issue`) read through it when the environment profile names `github.server`, and
log in through `login` when it maps a role to `qaEnv.logins.<role>` = `{server, account}`. Without `github.server`
they read through the broker until it is removed (#1214).

### Environment web logins (`login`, env-access WU3b, #1211)

`web.logins` names the environment's own web app accounts. `login` posts one of them and hands back only the session —
the password is a `{"$secret": …}` reference that server-tools resolves outside every model sandbox, and no model sees
it.

```jsonc
{
  "server-tools": {
    "dev2": {
      "envUser": "env:acme-dev2",
      "web": {
        "logins": {
          "player": {
            "url": "https://app.dev2.example/api/login",
            "body": { "username": "qa-player", "password": { "$secret": "dev2-player" } },
            "token": "json:data.accessToken"
          },
          "backoffice": {
            "url": "https://bo.dev2.example/login",
            "format": "form",
            "body": { "id": "qa-admin", "pw": { "$secret": "dev2-backoffice" } },
            "token": "cookie:SESSION",
            "successRedirect": "/home"
          }
        }
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `url` | where the account is posted. `https` only — the password travels in the body |
| `format` | `json` (default) posts `body` as JSON; `form` posts it as `application/x-www-form-urlencoded` (values must be strings, numbers or booleans) |
| `body` | the object posted; any value may be a `$secret` reference |
| `token` | where the session comes back: `json:<dot.path>` (a non-empty string in the JSON answer, returned as `kind: "bearer"`) or `cookie:<name>` (a cookie the answer sets, returned as `kind: "cookie"`; the last `Set-Cookie` for it wins, and one that deletes it — empty value, `Max-Age` ≤ 0, or no `Max-Age` and an `Expires` already past — leaves no session) |
| `successRedirect` | for a `cookie:` login that answers with a redirect: the path a successful login goes to. A redirect is taken only to that path (or below it; `/` means the root page only) on the login's own host, never to the login page or below it; without `successRedirect` a redirect is refused — a refused form login often redirects back to the login page with an anonymous cookie |

`login` answers `{server, account, kind, token}` (and `cookie` for a cookie session). A refused login says only the
host and the status — never the answer's body, which may echo what was sent. No redirect is followed: a `cookie:`
session is also taken from a 3xx answer that goes to `successRedirect`, a `json:` token only from a 2xx. A login
whose `body` names no `{"$secret": …}` anywhere in it is left out with a warning, so a password written
into config.json is never posted; a `web.logins` that is not an object of named logins is left out the same way. With
`successRedirect` set, a 2xx answer is refused too (a refused form login shows its page again). Each login
writes an intent line to `DATA_DIR/env-audit/env-audit.jsonl` and a `done` (with `kind`) or `failed` line after,
without the session or the password; if the intent cannot be written nothing is posted, and if the `done` line cannot
be written the session is not handed out. A session that names no Slack user is refused. On an environment's server a
non-admin needs that environment's grant (above); elsewhere `login` is admin-only.

## Where the substitution happens in code

- `src/config-env-substitution.ts` — pure substitution + `.env` discovery
- `src/unified-config-loader.ts` — calls `loadDotenvForConfig` then `substituteEnvVars` before structural validation
- `src/mcp-config-builder.ts` — applies the same substitution to `server-tools` entries

## Tests

- `src/__tests__/config-env-substitution.test.ts` — grammar, `.env` priority, dedupe, secret-leak guard
- `src/__tests__/unified-config-loader.test.ts` — integration through `loadUnifiedConfig` (`mcpServers` headers, `${VAR:-default}`, verbatim-on-missing)
