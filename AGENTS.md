See CLAUDE.md

## Slack API Guardrails (Block Kit / Messaging / Interactivity)

Slack payload validation is strict. Any undocumented field can fail the whole request with `invalid_blocks`.

### 1) Block Kit schema hard rules

- Never send undocumented properties in block elements.
- **Do not use `button.disabled`**. Slack Button element does not support it.
- If action must be "disabled", either:
  - hide/omit the button, or
  - show non-interactive context text and reject action in handler logic.

### 2) Block and text limits

- Message payload: max 50 blocks.
- `actions` block: max 25 elements.
- `context` block: max 10 elements.
- `section.text`: max 3000 chars.
- `section.fields`: max 10 items, each max 2000 chars.
- Top-level text object (`plain_text`/`mrkdwn`): max 3000 chars.
- Markdown block total text per payload: max 12,000 chars.

### 3) Messaging method constraints

- `chat.postMessage` with blocks must include top-level `text` fallback.
- `chat.update` cannot update ephemeral messages.
- `chat.postEphemeral` is non-persistent and not guaranteed delivery.
- Never design flows that depend on ephemeral message persistence.

### 4) Interactivity timing constraints

- Must `ack()` interaction payloads within 3 seconds.
- `trigger_id` is single-use and expires in 3 seconds.
- `response_url` can be used up to 5 times within 30 minutes.

### 5) Rate limit and retry behavior

- Assume ~1 request/sec baseline per channel/method.
- On HTTP 429, must respect `Retry-After` and retry with backoff.
- Do not fire repeated post/update retries without throttling.

### 6) Reactions and emoji

- `reactions.add` requires valid emoji alias name.
- Invalid alias returns `invalid_name`.
- Validate alias before use when emoji source is dynamic.

### 7) Channel routing safety (product behavior requirement)

- If channel move target cannot be resolved from repo mapping, do not silently fail.
- Fallback must be deterministic:
  - route to configured default channel, or
  - continue in current channel.
- Bot must explicitly notify user and request confirmation when fallback is applied.
- Bot should start a controllable thread-header message for routing state changes.

### 8) Reference

- Keep authoritative details in `docs/slack-block-kit.md`.
- Before adding new Slack UI payload fields, verify against official Slack docs first.

<!-- bv-agent-instructions-v1 -->

---

## Beads Workflow Integration

This project uses [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) for issue tracking. Issues are stored in `.beads/` and tracked in git.

### Essential Commands

```bash
# View issues (launches TUI - avoid in automated sessions)
bv

# CLI commands for agents (use these instead)
bd ready              # Show issues ready to work (no blockers)
bd list --status=open # All open issues
bd show <id>          # Full issue details with dependencies
bd create --title="..." --type=task --priority=2
bd update <id> --status=in_progress
bd close <id> --reason="Completed"
bd close <id1> <id2>  # Close multiple issues at once
bd sync               # Commit and push changes
```

### Workflow Pattern

1. **Start**: Run `bd ready` to find actionable work
2. **Claim**: Use `bd update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `bd close <id>`
5. **Sync**: Always run `bd sync` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `bd ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers, not words)
- **Types**: task, bug, feature, epic, question, docs
- **Blocking**: `bd dep add <issue> <depends-on>` to add dependencies

### Session Protocol

**Before ending any session, run this checklist:**

```bash
git status              # Check what changed
git add <files>         # Stage code changes
bd sync                 # Commit beads changes
git commit -m "..."     # Commit code
bd sync                 # Commit any new beads changes
git push                # Push to remote
```

### Best Practices

- Check `bd ready` at session start to find available work
- Update status as you work (in_progress → closed)
- Create new issues with `bd create` when you discover tasks
- Use descriptive titles and set appropriate priority/type
- Always `bd sync` before ending session

<!-- end-bv-agent-instructions -->
