# Slack UI API Reference (Block Kit + Messaging + Interactivity)

Last verified: 2026-02-06
Scope: Slack UI/API details that directly affect message rendering, interactivity, and common runtime failures (`invalid_blocks`, `invalid_name`, `429`, etc.).

## 1) Block Kit core limits and schema

### Global block limits
- Messages: up to 50 blocks.
- Modals/Home tabs: up to 100 blocks.

Source: https://docs.slack.dev/reference/block-kit/blocks/

### Actions block
- `elements`: max 25 interactive elements.
- `block_id`: max 255 chars; should be unique per message iteration/update.

Source: https://docs.slack.dev/reference/block-kit/blocks/actions-block/

### Context block
- `elements`: max 10 items.
- `block_id`: max 255 chars.

Source: https://docs.slack.dev/reference/block-kit/blocks/context-block/

### Section block
- `text`: min 1, max 3000 chars.
- `fields`: max 10 items, each text max 2000 chars.
- `block_id`: max 255 chars; use new value on updates.

Source: https://docs.slack.dev/reference/block-kit/blocks/section-block/

### Markdown block
- Cumulative `text` limit across markdown blocks in one payload: 12,000 chars.
- `block_id` is ignored for markdown blocks.

Source: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/

### Text object
- `type`: `plain_text` or `mrkdwn`.
- `text`: min 1, max 3000 chars.
- `emoji` usable only with `plain_text`.

Source: https://docs.slack.dev/reference/block-kit/composition-objects/text-object/

### Button element (critical for `invalid_blocks`)
- Supported fields are documented as:
  - `type`, `text`, `action_id`, `url`, `value`, `style`, `confirm`, `accessibility_label`
- Notably, `disabled` is not a supported button field.
- `text`: max 75 chars (can truncate around ~30 in UI).
- `action_id`: max 255 chars.
- `value`: max 2000 chars.
- `url`: max 3000 chars.

Source: https://docs.slack.dev/reference/block-kit/block-elements/button-element/

## 2) Messaging behavior (`chat.postMessage`, `chat.update`, `chat.postEphemeral`)

### `chat.postMessage`
- If `blocks` are present, top-level `text` is fallback text (notifications/accessibility context).
- Slack strongly recommends including top-level `text` when using `blocks`.
- Accessibility: screen readers default to top-level `text` and do not read inner block content by default.
- For `text` field:
  - best practice: keep <= 4000 chars
  - truncation may happen beyond 40,000 chars
- `chat.postMessage` special rate limiting:
  - generally 1 message/second/channel
  - additional workspace-wide limits apply

Source: https://docs.slack.dev/reference/methods/chat.postMessage/

### `chat.update`
- Ephemeral messages cannot be updated with `chat.update`.
- Update semantics:
  - if `text` provided without `blocks`, previous blocks are removed
  - if `blocks` omitted and `text` omitted, previous blocks may be retained
  - send empty arrays to explicitly clear `blocks` or `attachments`

Source: https://docs.slack.dev/reference/methods/chat.update/

### `chat.postEphemeral`
- Visible only to target user.
- Delivery is not guaranteed:
  - user must be active
  - user must be a member of the channel
- Ephemeral messages do not persist across sessions/reloads.
- `message_ts` returned by `chat.postEphemeral` cannot be used with `chat.update`.

Source: https://docs.slack.dev/reference/methods/chat.postEphemeral/

## 3) Interactivity timing and lifecycle

- You must acknowledge interaction payloads with HTTP 200 within 3 seconds.
- `response_url` responses:
  - up to 5 uses
  - within 30 minutes
- `trigger_id`:
  - expires in 3 seconds
  - single-use only
  - reuse leads to `trigger_exchanged`; expired leads to `trigger_expired`

Source: https://docs.slack.dev/interactivity/handling-user-interaction/

## 4) Rate limiting and retries

- General Web API rate limits are method-tier based (Tier 1..4 and special).
- On limit breach, Slack returns HTTP 429 with `Retry-After` header.
- Design recommendation from Slack: assume roughly 1 request/sec baseline and allow burst only temporarily.

Source: https://docs.slack.dev/apis/web-api/rate-limits/

## 5) Reactions and emoji naming

- `reactions.add` requires valid emoji `name`.
- Unicode emoji with tone modifiers use form:
  - `thumbsup::skin-tone-6`
- Invalid/unknown emoji aliases can produce `invalid_name`.

Source: https://docs.slack.dev/reference/methods/reactions.add/

## 6) Error-to-cause quick map

### `invalid_blocks` + `invalid additional property: disabled`
Cause:
- Unsupported field included in Block Kit JSON (for example button `disabled`).

Fix:
- Remove unsupported fields.
- Represent disabled state in text/context.
- Enforce restrictions server-side when actions are clicked.

### `invalid_name` on reactions
Cause:
- Invalid emoji alias for `reactions.add`.

Fix:
- Use valid Slack emoji alias names.
- Validate alias via workspace emoji set (`emoji.list`) or known standard aliases.

### `cant_update_message`
Cause:
- Trying to update message not authored by current token context or unsupported message type.

Fix:
- Update only messages your bot/user authored.
- For ephemeral message flows, use `response_url` workflows instead of `chat.update`.

### `user_not_in_channel` / `no_permission` (ephemeral)
Cause:
- Target user is not in channel or app is not channel member.

Fix:
- Verify channel membership and target user membership before posting ephemeral.

### HTTP 429
Cause:
- Method/workspace/app rate limit exceeded.

Fix:
- Respect `Retry-After`.
- Add per-method and per-channel throttling.

## 7) Practical implementation rules for this repo

1. Never add undocumented fields to Block Kit elements.
2. Never use `button.disabled`; Slack schema rejects it.
3. For "disabled" UX, hide buttons or show context text and reject in action handler.
4. Always include top-level `text` fallback when sending `blocks`.
5. `ack()` interaction requests immediately (target < 3s).
6. Handle `429` with backoff using `Retry-After`.
7. Do not rely on ephemeral persistence or updateability.
8. Use valid reaction aliases only.

## 8) Official references

- Block Kit overview: https://docs.slack.dev/reference/block-kit/
- Blocks: https://docs.slack.dev/reference/block-kit/blocks/
- Actions block: https://docs.slack.dev/reference/block-kit/blocks/actions-block/
- Button element: https://docs.slack.dev/reference/block-kit/block-elements/button-element/
- Context block: https://docs.slack.dev/reference/block-kit/blocks/context-block/
- Section block: https://docs.slack.dev/reference/block-kit/blocks/section-block/
- Markdown block: https://docs.slack.dev/reference/block-kit/blocks/markdown-block/
- Text object: https://docs.slack.dev/reference/block-kit/composition-objects/text-object/
- chat.postMessage: https://docs.slack.dev/reference/methods/chat.postMessage/
- chat.update: https://docs.slack.dev/reference/methods/chat.update/
- chat.postEphemeral: https://docs.slack.dev/reference/methods/chat.postEphemeral/
- Interactivity handling: https://docs.slack.dev/interactivity/handling-user-interaction/
- Web API rate limits: https://docs.slack.dev/apis/web-api/rate-limits/
- reactions.add: https://docs.slack.dev/reference/methods/reactions.add/

