# zworkflow

[한국어](./README.ko.md)

zworkflow is the Claude Code plugin that soma-work ships by default: an SSOT-driven development
pipeline (`z` / `zcheck` / `ztrace` / `autoz` / `zwork` / `trinity`) plus `calldiff` call-flow
summaries, agents, commands, hooks, prompts and skills. This directory, `src/local/`, is the plugin
root: its manifest is [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json), and the
repository's marketplace file ([`/.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json),
marketplace name `soma-work`) points the `zworkflow` entry at `./src/local`. soma-work agents
already load it; the steps below are for using it in your own Claude Code.

## Install

Inside a Claude Code session:

```
/plugin marketplace add 2lab-ai/soma-work
/plugin install zworkflow@soma-work
```

From a shell:

```bash
claude plugin marketplace add 2lab-ai/soma-work
claude plugin install zworkflow@soma-work
```

The HTTPS form also works: `claude plugin marketplace add https://github.com/2lab-ai/soma-work.git`.
Install scope defaults to `user`; pass `--scope project` or `--scope local` to limit it.
`claude plugin list` shows what is installed.

`marketplace add` clones the whole soma-work repository, not only this directory.

## What you get

Measured on 2026-10-27 with Claude Code 2.1.311 against plugin 2.5.0, in a clean config directory:

| Item | Measured |
|---|---|
| `marketplace add` | about 17 s; marketplace directory about 205 MB |
| `install` | plugin cache about 7.5 MB |
| `claude plugin details zworkflow@soma-work` | 59 skills, 16 agents, 3 hooks |
| Always-on context | about 8,506 tokens added to every session |

These numbers are a dated measurement, not a guarantee. Version 2.6.0 adds one skill,
`using-intentfirst`. Run `claude plugin details zworkflow@soma-work` for the current figures.

Plugin skills are namespaced: invoke them as `/zworkflow:using-intentfirst`,
`/zworkflow:using-ssot`, and so on.

## Update and uninstall

```bash
claude plugin marketplace update soma-work
claude plugin update zworkflow@soma-work
claude plugin uninstall zworkflow@soma-work
```

`marketplace update` refreshes the clone; `update` then moves the plugin to the new version and
needs a Claude Code restart to apply.

## Hooks outside soma-work

The plugin registers hooks in [`hooks/hooks.json`](./hooks/hooks.json):

- **PreToolUse / PostToolUse, every tool** run `hooks/hook-proxy.sh`. With `HOOKS_PROXY_ENABLED`
  unset (the default) it runs standalone: for Agent/Task and MCP calls, `hooks/call-tracker.sh`
  writes a call log under `/tmp/claude-calls`. No network. soma-work sets
  `HOOKS_PROXY_ENABLED=true` for its own agents, which forwards the events to the local soma-work
  service instead; do not set it in your own install. Every path of `hook-proxy.sh` exits 0 and
  writes nothing to stdout, so these hooks never block a tool call.
- **Stop** runs `hooks/stop-hook.sh` (Ralph loop) and `hook-proxy.sh cleanup`. The Ralph loop
  does nothing unless `.claude/ralph-loop.local.md` exists in the project, and this plugin does not
  create that file. When the file exists, the hook continues the session by design.
- **Requirements:** `jq`. Without it the PreToolUse / PostToolUse hooks do nothing and exit 0.
  `stop-hook.sh` checks for `jq`, `perl`, `sed` and `awk` at every Stop; if one is missing it
  prints a warning to stderr and exits 0.

## Lightweight path: two skills only

If you want `using-intentfirst` without the plugin's hooks, agents and always-on context, copy it
and the skill it depends on, `using-ssot`, into your user skills directory:

```bash
d="$(mktemp -d)/soma-work" && git clone --depth 1 --filter=blob:none --sparse https://github.com/2lab-ai/soma-work.git "$d" && git -C "$d" sparse-checkout set src/local/skills/using-ssot src/local/skills/using-intentfirst && mkdir -p ~/.claude/skills && cp -R "$d/src/local/skills/using-ssot" "$d/src/local/skills/using-intentfirst" ~/.claude/skills/
```

The clone goes into a new directory made by `mktemp -d`, so it never touches an existing checkout.
For a single project, copy
the two folders into `<project>/.claude/skills/` instead. Copied skills are not namespaced: invoke
the skill as `/using-intentfirst`. The copy does not update itself; repeat it to update.

## using-intentfirst

An instruction usually arrives as the workflow its author thought of, not as the intent behind it.
[`using-intentfirst`](./skills/using-intentfirst/SKILL.md) works from the intent:

- It keeps the raw instruction as the SSOT through [`using-ssot`](./skills/using-ssot/SKILL.md)
  (Hook 1 intake, Hook 2 drift, Hook 4 completion report).
- It separates the intent from the workflow-shaped instruction and labels proposed solutions as
  examples, not specs.
- It builds an INTENT-LIST and an INTENT-TASK-TREE, then diffs that tree against the
  SSOT-TASK-TREE (covered, dropped, added, reshaped), with a cause for each difference.
- It shows the diff and proceeds on the intent tree without waiting for confirmation. A reply
  steers the work; it does not restart it.
- It never takes an irreversible (`[irrev]`) step on inferred intent.

Invoke it as `/zworkflow:using-intentfirst` (plugin) or `/using-intentfirst` (copied). Its
description tells Claude to load it first on every instruction. The skill text is in Korean;
"G" in it means you, the person giving the instructions.
