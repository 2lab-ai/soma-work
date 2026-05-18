# ADR 0001: Documentation System Of Record

Status: Accepted
Date: 2026-05-18

## Context

`soma-work` already has several useful documentation layers:

- root `README.md` / `README.ko.md`
- agent instructions in `CLAUDE.md` and `AGENTS.md`
- evergreen system specs under `docs/current/spec/`
- feature `spec.md` / `trace.md` pairs
- historical material under `docs/archive/`

The problem is not absence of docs; it is routing and lifecycle clarity. AI agents need a small, stable entrypoint instead of reading the whole tree or appending history to `CLAUDE.md`.

## Decision

Adopt this documentation system of record:

1. Root `README.md` and `README.ko.md` remain product entrypoints.
2. `CLAUDE.md` and `AGENTS.md` remain concise agent behavior instructions, not changelogs.
3. `docs/README.md` is the canonical map for documentation routing and lifecycle rules.
4. `docs/misc/research/YYYY-MM-DD-topic.md` stores external research and date-sensitive findings.
5. `docs/archive/completed-work.md` stores evidence-backed completion status and archive pointers.
6. `docs/adr/` stores cross-cutting architecture decisions.
7. Existing feature `spec.md` / `trace.md` pairs remain in place unless completion/staleness is explicitly evidenced.
8. Existing `Auto-Decisions` sections remain valid for local implementation choices; only repo-wide decisions are promoted to ADR.

## Consequences

- Future agents can start from `docs/README.md` instead of scanning every markdown file.
- Completion history is kept out of `CLAUDE.md`, preserving a small instruction surface.
- Existing completed cleanup work remains discoverable through `docs/archive/completed-work.md`.
- The repo avoids a risky bulk move of feature docs whose completion state is not explicit.
- ADRs become useful because they are reserved for durable, cross-cutting decisions.

## Evidence

- OpenAI Codex customization docs recommend small `AGENTS.md` guidance, memories, skills, MCP, and subagents as separate complementary layers: <https://developers.openai.com/codex/concepts/customization>
- OpenAI Codex AGENTS.md docs describe layered project instructions and verification of loaded instruction sources: <https://developers.openai.com/codex/guides/agents-md>
- Anthropic Claude Code memory docs recommend concise, specific, structured `CLAUDE.md` files and separating project instructions from other memory: <https://code.claude.com/docs/en/memory>
- Anthropic Help Center says `CLAUDE.md` should contain commands, conventions, architecture, hard constraints, and gotchas, not history or full API documentation: <https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts>
- Prior repo cleanup is already captured in [../archive/features/docs-cleanup/trace.md](../archive/features/docs-cleanup/trace.md) and [../archive/features/project-gardening/trace.md](../archive/features/project-gardening/trace.md).

## Follow-up

- When a feature trace reaches explicit Done/Complete status, add it to [../completed-work.md](../archive/completed-work.md).
- When an architecture decision supersedes this routing model, create a new ADR and mark this one Superseded.
