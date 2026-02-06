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

- Keep authoritative details in `docs/slack_api.md`.
- Before adding new Slack UI payload fields, verify against official Slack docs first.
