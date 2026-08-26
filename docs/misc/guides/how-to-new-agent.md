# Sub-Agents — status and architecture note

> **This is a status and architecture note, not setup instructions.**
> There is **no supported end-to-end path for provisioning an additional sub-agent
> today.** This page explains what exists in the code, what was removed and why, and
> what a supported path would have to provide before it can be written.

---

## 1. Where things stand

| Question | Answer |
|---|---|
| Can I onboard the **main** profile? | Yes — `somawork setup`. See the packaged-onboarding section of [README.md](../../../README.md), including its status box (the formula is not published yet). |
| Does `somawork setup` create additional sub-agent Slack apps? | **No.** It creates and installs exactly **one** Slack app: the profile's primary app. There is no `somawork agent add` and no additional-app provisioning command. |
| Is there a script that provisions a sub-agent? | **No.** See §2. |
| Can I run sub-agents at all? | Only on an **existing source-development deployment**, by hand, accepting that the credential handling is unsolved (§4). |

## 2. The removed provisioning paths — do not run these

Two scripts used to appear here as "Method 1" and "Method 2". Neither is a supported
provisioning path, and **neither should be run to mint, copy, or store credentials**.

- **`scripts/provision-agent.ts`** is a hard deprecation wrapper. It provisions nothing and
  exits nonzero. Its implementation was deleted rather than ported because every step of it
  was a credential path the current design forbids: a long-lived Slack **configuration
  token** kept in a local `config.json`, a local HTTP server used as an **OAuth callback** to
  read a bot token out of a redirect, a terminal **prompt asking the operator to paste an
  app-level token**, and token writes into that same config file. The reasoning is recorded
  in the file's own header.
- **`scripts/create-agent.sh`** still exists and still runs, but it is the same shape of
  path: it prints a Slack app URL, then reads a bot token, an app-level token and a signing
  secret from the terminal and writes them into `config.json`. It is **not** a supported
  provisioning path and is not part of the packaged runtime — the runtime bundle ships
  neither script.

The design that replaced them states the rule these violate: no credential may enter argv, a
URL, stdout/stderr, a state file, or mutable package state. On the supported path, Slack app
creation and installation are owned by the Slack CLI, and the runtime tokens travel
child env → local Unix socket → a `0600 secrets.env` without ever being a value a wizard
holds or prints.

Historical detail lives in the design document, not here:
[`docs/superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md`](../../superpowers/specs/2026-08-23-somawork-setup-onboarding-design.md).

## 3. What the runtime actually does with sub-agents

This part is current code, and it is why the config schema below exists.

Each configured sub-agent is an independent Slack app **running inside the same process** as
the main bot, with its own Bolt `App`, its own Socket Mode connection, its own
`SessionRegistry`, and its own prompt directory.

```
index.ts
  → config load
  → agent entries parsed and validated (src/config-loader.ts)
  → AgentManager(agentConfigs, mcpManager).startAll()
      → per agent: AgentInstance → Bolt App + Socket Mode connection
      → failure is isolated: an invalid or failing agent is skipped, siblings keep running
```

**Validation is skip-on-warn, not fatal** (`src/config-loader.ts`). An entry is skipped, with
a warning naming the field, when `slackBotToken` or `slackAppToken` is missing, mistyped, or
carries the wrong prefix; or when a `signingSecret` is *declared* but shorter than the
minimum. Omitting `signingSecret` entirely is valid — every agent runs Socket Mode, so no
request signature is ever exchanged.

**Prompt resolution** (`src/prompt-builder.ts`) tries the agent's own directory first and
falls back to the main bot's, for both the entry prompt and every `{{include:…}}`.

**Delegation** is via the `agent` MCP server ([`packages/mcp-servers/agent/`](../../../packages/mcp-servers/agent/)),
which exposes `chat` and `chat-reply` (surfaced to the model as `mcp__agent__chat` /
`mcp__agent__chat-reply`). It receives agent metadata through the `SOMA_AGENT_CONFIGS`
environment variable, with credentials stripped out first (`src/mcp-config-builder.ts`).

> **Integration is partial.** Sub-agent apps connect and receive events, but @mention/DM
> handling and the Claude SDK query behind `agent_chat` are still placeholders — see the
> TODOs in `src/agent-instance.ts` and `packages/mcp-servers/agent/agent-mcp-server.ts`.
> README.md's Multi-Agent Architecture section states the same limitation.

### Config schema (conceptual)

Agent entries live under the `agents` key of the runtime config (`config.json`, or
`config.dev.json` on non-`main` branches unless `SOMA_CONFIG_DIR` is set). The fields the
loader reads, from `AgentConfig` in `src/types.ts` — that type is the source of truth, this
table is a description of it:

| Field | Required | Notes |
|---|---|---|
| `slackBotToken` | yes | Bot user token. **A credential.** |
| `slackAppToken` | yes | App-level token for Socket Mode. **A credential.** |
| `signingSecret` | no | HTTP signature verification only; omit it under Socket Mode. **A credential when present.** |
| `promptDir` | no | Defaults to `src/prompt/<agentName>` |
| `persona` | no | Persona file name |
| `description` | no | Human-readable description |
| `model` | no | Inherits the main bot's model when absent — do not copy a model id out of a document; check the model catalog |

No example values are given for the three credential fields on purpose. **Do not paste
credential literals into a config file from a document**, and do not treat this table as a
recipe: filling it in by hand is the unsupported path described in §4.

Two agent prompt directories exist in the tree today (`src/prompt/jangbi`,
`src/prompt/gwanu`); the directory listing is the source of truth, not this sentence.

## 4. Why additional-agent provisioning is unsupported, and what would unblock it

Adding a sub-agent needs two long-lived Slack credentials per agent. Everything the current
design solved for the primary app — minting them without a human seeing them, and storing
them in a mode-`0600` file outside any package or repository tree — has **no equivalent for
the second, third, or Nth app**. The only ways to do it today all end with an operator
holding raw tokens and pasting them into a plaintext config file.

So the honest state is: **unsupported, pending a secrets-store-backed design.** What such a
design has to provide, at minimum:

1. per-agent app creation through the Slack CLI, the way the primary app is created;
2. capture of each agent's runtime tokens over the same non-printing channel used for the
   primary app;
3. per-agent secret storage in the profile's secret store rather than a config file, with the
   config carrying only non-secret references;
4. a controller command that is resumable and revalidating, like `somawork setup`.

Until that exists, an operator running sub-agents on a source-development checkout is
accepting plaintext credentials in a local config file, and should treat that file
accordingly: it is not committed (it is git-ignored), it is not synced, and it is not shared.

## 5. Troubleshooting an already-configured agent

| Problem | Where to look |
|---|---|
| Agent not responding | Token validity; Socket Mode enabled on that Slack app |
| "Skipping agent" in logs | The warning names the failing field — see the validation rules in §3 |
| Agent uses the main bot's prompt | Its own `default.prompt` was not found under `promptDir` |
| Duplicate Socket Mode connections | More than one instance running with the same tokens; check the PID lock |
| `agent_chat` → "Unknown agent" | The name must match the config key exactly (case-sensitive) |
