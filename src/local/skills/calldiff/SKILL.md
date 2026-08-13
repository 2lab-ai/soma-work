---
name: calldiff
description: "Diff call stacks across git refs — git diff for who-calls-whom. Shows which callees appeared, disappeared, or moved under an entrypoint across 22 languages (diff / tree / reach). Use it to summarize what a change actually did to call flow when work completes, and during code review when line diffs bury the shape of the change. Triggers on 'calldiff', '콜스택 diff', '호출 흐름 변경', '코드 변경점 요약', 'summarize the code changes', 'call flow changed'."
---

# calldiff — diff the call flow, not just the lines

Line diffs tell you which characters moved. They do not tell you that `createSession`
stopped calling `AuthStorage.create()` directly and now goes through `getServices()`.
`calldiff` parses both git trees with tree-sitter, builds per-function callee trees, and
diffs those trees.

```diff
  PiService.createAgentSession(options)
- ├─ AuthStorage.create()
- ├─ new ModelRegistry
- ├─ createCodingTools()
+ ├─ PiService.getServices()
+ │  ├─ SettingsManager.create()
+ │  ├─ AuthStorage.create()
+ │  └─ new ModelRegistry
```

## When to use

- **Completion summary (default).** Work is done, the branch has commits — run `diff` and
  report the call-flow delta alongside the file-level summary.
- **Code review.** A PR touches many files and you need the shape of the change, not the
  line noise.
- **Impact check.** Before editing, see who reaches the symbol you are about to change
  (`reach`), or what an entrypoint pulls in (`tree`).

## When not to use

- Pure docs / config / prompt / skill changes with no source functions — there is no call
  flow to diff. Say so in one line instead of running it.
- Non-git working copies, or repos in a language outside the supported list.

## Invocation

No install step. Run it through npx, from the repo root, **pinned and bounded**:

```sh
npx calldiff@0.5.0 diff
```

- **Pin the version.** `@latest` re-resolves on every cold cache and runs whatever upstream
  published since — unreviewed code inside the user's checkout, with an output shape that
  can change under you. Bump the pin here deliberately, never implicitly.
- **Bound the call.** One attempt, with the Bash tool's own `timeout` capped at 120000 ms.
  Do **not** prefix the command with the `timeout` binary — it does not exist on macOS
  hosts, which is where this bot runs. A cold cache downloads the package plus tree-sitter
  grammars; an unbounded hang is the expensive failure mode.

Prefer `--format json` when you need to post-process; the default ASCII output is already
the right shape for a human-facing summary.

## When it fails — degrade, never block

calldiff is an accessory to the summary, not a gate on it. If the command exits non-zero,
times out, cannot reach the registry, or is denied by the sandbox: **stop after one
attempt**, write `calldiff unavailable: <reason>` in one line, and report the file-level
summary instead. Do not retry in a loop, do not install anything else, do not withhold the
report waiting for it.

Distinguish the two quiet outcomes — they mean opposite things:

| Outcome | Meaning | What to say |
|---|---|---|
| exit 0 + `No callstack changes between <from> and <to>.` (verified output of v0.5.0 — it prints this line, it does not print nothing) | The change genuinely did not move call flow | "No call-flow change" + file-level summary |
| non-zero exit / timeout / no output at all | The tool did not run | `calldiff unavailable: <reason>` + file-level summary |

## `diff` — call-flow delta between two trees

Ref semantics match `git diff`: no refs → `HEAD` vs working tree; one ref → that ref vs
working tree; two refs → those two trees.

```sh
# HEAD vs working tree
npx calldiff@0.5.0 diff

# branch base vs current work (the usual completion summary).
# Detect the base — do not hardcode `main`. Repos differ (master, develop, a PR base).
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null \
       || git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' \
       || echo main)
npx calldiff@0.5.0 diff "$BASE"

# two explicit refs
npx calldiff@0.5.0 diff abc123 def456

# force entrypoints: functionName or ClassName.method
npx calldiff@0.5.0 diff main HEAD --entry createAgentSession
npx calldiff@0.5.0 diff main HEAD -e PiService.createAgentSession -e boot

# every exported symbol of one file as the entrypoint set
npx calldiff@0.5.0 diff main HEAD --file src/routes.ts

# limit to path prefixes (trailing positionals)
npx calldiff@0.5.0 diff main HEAD src/agent-runtime
```

`-` lines existed in *from* and are gone in *to*. `+` lines are new in *to*. With no
`--entry` / `--file`, calldiff infers the exported functions whose call trees changed.

## `tree` — one call tree, no diff

```sh
npx calldiff@0.5.0 tree --entry createAgentSession
npx calldiff@0.5.0 tree HEAD -e PiService.createAgentSession --max-depth 8 src/lib
npx calldiff@0.5.0 tree --file src/routes.ts --locs
```

`--entry` / `-e` or `--file` / `-F` is required. `--locs` adds `file:line` — the root uses
the definition site, children use the call site inside the parent.

## `reach` — every call path from A to B

```sh
npx calldiff@0.5.0 reach -e runCheckout --to sendEmail
npx calldiff@0.5.0 reach HEAD -e runCheckout --to sendEmail examples/checkout
```

Requires `--entry` / `--file` plus `--to`. Prints all paths, including alternate `if` /
`else` arms.

## Options worth knowing

| Flag | Default | What it does |
|---|---|---|
| `--entry` / `-e` | inferred | Entrypoint symbol: `functionName` or `ClassName.method` (repeatable) |
| `--file` / `-F` | — | Entrypoint file: expands to that file's exports (exact path or unique suffix) |
| `--max-depth` | `12` | Call-tree depth cap |
| `--locs` | off | Show `file:line` for definitions and call sites |
| `--format` | omitted | Accepts `toon` / `json` / `yaml` / `md` / `jsonl`. `ascii` is **not** an accepted value — the ASCII tree is what you get when you omit the flag |

## Reading the labels

- `functionName` — free function
- `ClassName.method` — class method
- `new ClassName` — constructor call
- `Component` — JSX/TSX component tag; children nest under it
- `if (cond)` / `else if (cond)` / `else` — conditional arms
- `file:line` — location, only with `--locs`

## How to turn the output into a summary

1. Run `npx calldiff@0.5.0 diff <base-ref>` at the repo root.
2. If it exits 0 with `No callstack changes between <from> and <to>.`, the change did not
   move call flow — say exactly that, then fall back to a file-level summary. That line is
   a finding, not a failure. (Silence plus a non-zero exit is the opposite case — see
   "When it fails" above.)
3. Otherwise report, per entrypoint: what it stopped calling (`-`), what it now calls
   (`+`), and what that means behaviorally. Quote the tree — the ASCII shape carries more
   than a paraphrase.
4. Flag anything surprising: a new call under a hot path, a dropped validation step, a
   dependency inversion you did not intend.

## In a pull request body — the report goes first

Every PR carrying code changes opens with this block. It is the **first section of the PR
body**, before context, before the test plan. A reviewer should see what moved in the call
graph before reading prose about it.

```sh
BASE=$(gh pr view --json baseRefName -q .baseRefName 2>/dev/null \
       || git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' \
       || echo main)
npx calldiff@0.5.0 diff "$BASE" HEAD
```

Shape of the block:

````md
## Summary

```
<calldiff output, verbatim>
```

<2–3 lines: what the delta means behaviorally — what the entrypoint stopped calling,
what it now calls, and why that matters.>
````

The block is never omitted. When there is no tree to show, exactly one line stands in for
it:

| Case | Line to write |
|---|---|
| exit 0, `No callstack changes between <base> and HEAD.` | that line verbatim, then the file-level summary |
| non-zero exit / timeout / no network / sandbox denial | `calldiff unavailable: <reason>` — never block or delay PR creation |
| PR touches only docs / config / prompts | `Call-flow report N/A — no source files in this PR.` |

Push more source commits to the PR later? Re-run and update the block. A stale call-flow
report is worse than none.

## Limits — do not over-claim

- Analysis is **syntactic** (AST-based, tree-sitter), not a typechecker. Dynamic calls,
  reflection, and calls through unresolved values will not resolve.
- Grammars download on first use into `~/.cache/calldiff/grammars`
  (override with `CALLDIFF_GRAMMAR_CACHE`). First run in a sandbox may need network.
- Supported: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, Ruby, C, C++, C#,
  PHP, Kotlin, Swift, Scala, Lua, Elixir, Bash, Haskell, Zig, Solidity, OCaml.

## Upstream

Adapted from [tanishqkancharla/calldiff](https://github.com/tanishqkancharla/calldiff)
(MIT). The CLI is the upstream `calldiff` npm package, invoked unmodified; this skill only
adds the usage discipline for agents.
