---
name: skill-description
description: "Use when writing, reviewing or fixing the description of a skill, command or agent. Also when skills fire at the wrong moment, the skill listing is long, or descriptions go missing from it. Triggers: 'skill-description', '스킬 디스크립션', 'description 고쳐줘', 'fix skill descriptions'."
---

# skill-description — a description says when, never what or how

## In short

A description is the only part of a skill the model reads before it decides to load the skill — on every turn, for every user. So it answers one question: when should this skill be loaded? What the skill does and how it does it belong in the body, which loads only after the skill is chosen.

## Why it matters

- A description that summarises the workflow gets followed instead of the workflow. The model acts on the summary and never reads the body's real steps, rules and stop conditions.
- Every description costs tokens on every turn for every user. A host cuts a listing that runs over its budget, so long descriptions push other skills' descriptions out of the listing, and those skills stop being chosen.
- Steps, flags, engine names and file paths in a description go stale without anyone noticing. The body has tests and gets read; the description rarely does.

## The format

```
Use when <situation>[, or <situation>]. [Also when <situation>.] Triggers: '<phrase>', '<phrase>'. [Not for <situation> (<sibling>).]
```

1. Every sentence starts with `Use when`, `Also when`, `Triggers:` or `Not for` — nothing else. `scripts/check-descriptions.mjs` enforces this.
2. A situation is something visible before the skill runs: what the user asks or says, the input at hand, the point in a workflow ("after a PR is opened", "when local:z reaches phase 3"), a symptom ("animations stutter").
3. Never in a description: what the skill produces, its steps, tools, engines or models, file paths, arguments or flags, phase names that only make sense after reading the body, praise ("comprehensive", "powerful").
4. Triggers: up to 8 short phrases a user actually types, in every language its users write in.
5. `Not for` only when a sibling skill would otherwise be picked for the same words. Name the sibling.
6. Aim for 300 characters or fewer. The checker stops at 400.
7. Frontmatter: one line, double-quoted, inner quotes single ('…'). For a host-kept user skill in soma-work (`MANAGE_SKILL`), use no quote characters at all — the host's listing cuts a description at its first quote.
8. Agents follow the same rule: the description says when to dispatch the agent. Example dialogues go in the body.

## Applying it to a set of skills

1. List every description with its length: `node scripts/check-descriptions.mjs <plugin dir>` prints each violation; a clean set prints nothing.
2. For each description, read it and the body's opening section. Keep the situations, triggers and the `Not for` that separates a sibling. Drop everything else.
3. Before you drop a rule, check that the body carries it. An argument list, a constraint or an exception found only in the description moves into the body first (an `## Args` or `## Input` section) — a rule is never lost in the rewrite.
4. Rewrite, run the checker, fix every line it prints.
5. Contract tests that asserted the old description text: make them assert the situation in the description and the behaviour in the body.
6. When the total shrank, lower the listing budget test (soma-work: `src/__tests__/prompt-budget.test.ts`) so the saving cannot grow back unnoticed.

## Example

Before:

> Diff call stacks across git refs — git diff for who-calls-whom. Shows which callees appeared, disappeared, or moved under an entrypoint across 22 languages (diff / tree / reach). Use it to summarize what a change actually did to call flow when work completes, and during code review when line diffs bury the shape of the change. Triggers on 'calldiff', '콜스택 diff'.

After:

> Use when work that changed code is finishing and its call-flow change must be summarised, or when a code review needs who-calls-whom across two refs. Triggers: 'calldiff', '콜스택 diff', '호출 흐름 변경', 'summarize the code changes'.

The 22 languages, the three modes and the output shape are all still true — they live in the body, where they are read when they matter.

## Before you finish

- Does the checker print nothing for every file you touched?
- Could a model decide from each description alone whether this is the moment, without being able to act on it?
- Did every argument, constraint and exception you removed land in the body?
- Did the listing total go down, and did the budget test follow it?
