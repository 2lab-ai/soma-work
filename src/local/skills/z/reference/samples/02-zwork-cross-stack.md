# Sample 2 — phase-2 dispatch: zwork (cross-stack with wire alignment)

**Purpose**: template for the orchestrator's `Agent` dispatch when a sub-task spans two stacks and the wire format must be aligned (e.g. server enum serialization ↔ client enum). Backward-compat fallback is mandatory for one cycle.

**Subagent type**: `general-purpose`
**`run_in_background`**: `true`

---

You will complete sub-task `<SUB_KEY>` of epic `<EPIC_NUM>` end-to-end across two stacks. Result = a merge-ready PR.

## Work environment
- **cwd (worktree)**: `<ABSOLUTE_WORKTREE_PATH>`
- **branch**: `<BRANCH_NAME>` (already branched from `<BASE_BRANCH>`)
- **base**: `<BASE_BRANCH>` (origin/`<ORG>`/`<REPO>`)

## Sub-issue
- URL: `<SUB_ISSUE_URL>`
- Parent epic: `<EPIC_URL>`

## Changes (exact)

### 1. Stack A (e.g. `<rust-crate-or-dotnet-project>`)

#### 1a. New type / enum
- Add at: `<file/path>` — variants `<V1, V2, V3>`.
- Wire form decision: `<int via serde_repr / string PascalCase / string snake_case>` — must match Stack B's serializer.

#### 1b. Wire DTO update
- File: `<file/path>:<lines>`.
- Add field `<field_name: T>` (new), keep `<deprecated_field>` for one cycle (server prefers the new field).

#### 1c. Config / parsing update
- File: `<file/path>:<lines>`.
- New field, with **legacy fallback** rule:
  - If new field empty → derive from legacy field via the documented mapping (see Stack-B §2a).
  - Unknown legacy values → `warn` log, skip.

#### 1d. Payload assembly call site
- File: `<file/path>:<lines>` — include both fields in the request (server tolerates either).

### 2. Stack B (e.g. `<dotnet-or-go-server>`)

#### 2a. DTO field
- File / class: `<location>` — add `<NewField>` as nullable for backward compat.

#### 2b. Service handler
- File / method: `<location>:<lines>` — validation rules:
  - `null` or empty new field → legacy registration path (existing behavior).
  - Unknown enum value → `BadRequest` with descriptive message.

#### 2c. Compatibility guarantees
- Legacy clients (without the new field) still register. Heartbeat / liveness paths must not break.
- The downstream consumer (`<next-sub-task>`) is responsible for using the new field — this PR only normalizes the wire.

### 3. Tests

#### 3a. Stack A
- Serialization round-trip: new field appears in payload as `<wire form>`.
- Config parsing: `<file>::tests`.
- Legacy fallback: parses old config without new field → maps via documented rule.

#### 3b. Stack B (4 cases)
- `Register_WithNewField_Valid_Succeeds`.
- `Register_WithNewField_LegacyEmpty_Succeeds`.
- `Register_WithNewField_InvalidEnum_ReturnsBadRequest`.
- `Register_BackwardCompat_OnlyLegacy_Succeeds`.

## Procedure

1. `cd <ABSOLUTE_WORKTREE_PATH>`.
2. **Confirm Stack-B wire form** before writing Stack-A enum: read `<serializer config / converter usage>` and decide int vs. string. Mis-aligned wire = silent failure.
3. Apply §1, §2, §3.
4. Stack-B build / test:
   - `<dotnet build / go build / etc>` — warning baseline preserved.
   - `<dotnet test / go test / etc>` — all green.
5. Stack-A build / test / lint:
   - `cargo build --release` (or equivalent).
   - `cargo test --release`.
   - `cargo clippy --release -- -D warnings`.
6. `git add` + `git commit` (HEREDOC):

```
[<TICKET_KEY>] <SUB_KEY>: <one-line title>

<3–6 line behavior-level description across both stacks. State the
backward-compat guarantee explicitly: legacy clients keep working for
one cycle, after which the deprecated field is removed.>

<Stack A>:
- <bullet>
- <bullet>

<Stack B>:
- <bullet>
- <bullet>

Compatibility: <explicit one-line statement>.

Refs: #<SUB_NUM>, #<EPIC_NUM>

Co-Authored-By: Z <z@2lab.ai>
```

7. `git push -u origin <BRANCH_NAME>`.
8. `gh pr create` with title `[<TICKET_KEY>] <SUB_KEY>: <one-line title>` and body:

```
## Summary
- Stack A: <bullets>
- Stack B: <bullets>
- Compatibility: <statement>

## Refs
- Sub-issue: #<SUB_NUM>
- Parent epic: #<EPIC_NUM>
- Dependency: <none / Group X>
- Follow-up: <next-sub-task that consumes the new field>

## Test plan
- [x] Stack-A build / test / clippy
- [x] Stack-B build / test
- [x] Wire round-trip
- [x] Legacy compat (4 cases)

## Risks / Rollback
- Rollback unit: revert this PR.
- Compat: legacy clients keep working — solo revert safe.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Z <z@2lab.ai>
```

## Hard rules
- Confirm wire form (int vs. string) **before** writing the Stack-A enum. Wrong choice = silent failure.
- Legacy fallback mapping is permissive (warn + skip on unknown value). Never error in fallback path — that breaks compat.
- PR description must include `## Summary` and `## Test plan`.
- After PR creation, report the wire-form decision so the orchestrator can record it for downstream subs.
- Do not stop midway. Do not return without a PR URL.

## Final report
- PR URL.
- Wire-form decision (int / string + concrete shape).
- Files changed (Stack A and Stack B).
- Build / test results per stack.
- Blockers.
