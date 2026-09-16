# Auth capacity overview

Status: in-progress
SSOT: [original instructions](auth-capacity-overview/ssot.md) · Architecture: [07-auth-capacity-architecture.md](07-auth-capacity-architecture.md) · Evidence: [verification](auth-capacity-overview/verification.md)

[BUNDLE] Source and synthetic Block Kit previews are verified locally. [LIVE] Deployed Slack interactions remain unverified. This changes soma-work's own UI; it does not reproduce an external product's branding or claim exhaustive live testing of provider dashboards.

## User outcome

Opening `auth` or `/z auth` answers three questions: which provider has capacity, which account can be used, and when each limit resets. Administrators get the same overview before explicitly opening management controls.

## Research and data limits

Reviewed 2026-09-16:

- [Claude usage guidance](https://support.claude.com/en/articles/9797557-usage-limit-best-practices): five-hour and weekly usage indicators; consumption depends on model, context and tools. No fixed token balance is published by this article.
- [Codex pricing and limits](https://learn.chatgpt.com/docs/pricing): included usage is distinct from credits and API billing. Five-hour and weekly allowances are not fixed token balances; reset times are account-specific.
- [xAI API rate limits](https://docs.x.ai/developers/rate-limits): request frequency and token throughput are separate dimensions. These are developer API limits, not evidence of consumer Grok subscription balances.
- Local wire contract: `src/auth/llmux-client.ts` exposes utilization ratios, epoch-second reset times, optional scoped limits, cooldown, in-flight and cumulative token telemetry. `totals.input_tokens/output_tokens` are consumed tokens, NOT remaining tokens.

Upstream verification (llmux pinned `8be574b18290d3bcb1b80ea644aa481e95aa2da6`, local source snapshot `../llmux-src/` in the session workspace):

- `src/proxy/server.rs` (`status_json`, `scoped_window_json`): every `five_hour` / `seven_day` / scoped window in `/llmux/status` serializes only `{utilization, resets_at, resets_in_secs}` (scoped rows add `scope_label` / `severity` / `is_active`). The status contract carries no token denominators and no plan weights — normalized account equivalents are the only aggregate the data supports.
- `src/scheduler/headers.rs` + `src/scheduler/mod.rs`: standard `x-ratelimit-*` request/token counts are collapsed into a ratio (`derived_utilization` = `1 - remaining/limit`) before the window is stored — the raw counts are discarded; Grok's reset-less cli-chat-proxy buckets get a synthesized `STANDARD_RESET_FALLBACK` = 60s horizon (`as_window_reading_with_fallback_reset`). The Slack card therefore renders Grok/API-key rows as an untimed rate-limit ratio and suppresses the synthetic reset instead of showing it as a quota-window countdown.
- `src/proxy/usage_controls.rs` (`UsageControlDoc`): `available_resets` (resets the account owns) and `applicable_resets` (server-reported "usable right now"; display information, never a permission gate) are real observed counters; an absent counter means unknown, never zero. soma-work displays them read-only (`src/slack/auth/capacity.ts`) and never redeems.

Never infer consumer Grok quota from xAI API documentation. Never turn utilization into token counts without a token-denominated limit.

## Acceptance

- A1 / T1: group accounts in Claude, Codex, Grok order, followed by other groups alphabetically. Older missing-group Codex credentials still group under Codex. Within a group use scheduler order then natural account name. Input arrays are not mutated.
- A2 / T1–T2: show remaining capacity per reported window. Provider totals are explicitly labelled normalized account equivalents (100% of one account = 1), not a pooled token balance; do not combine different window durations or scoped models. Report measurement coverage, missing/stale values, available vs blocked accounts. Different plan sizes are not assumed equal in token capacity.
- A3 / T2: every valid reset shows absolute local Slack date/time and time remaining. Prefer valid `resets_at`, fall back to finite positive `resets_in_secs` only when absolute timestamp is missing. Expired/invalid windows are unknown, never automatically replenished.
- A4 / T2: show the next reported reset with affected window, account and normalized amount reclaimed (used percentage). It is conditional on no additional usage and does not promise a whole account is usable. Exhausted overlapping windows cannot be treated as available after only the earliest one resets. Show cooldown and auth failures, model-scoped restrictions separately.
- A5 / T2: missing Grok/API-key telemetry renders 'unknown/not supplied', never zero or unlimited. Real additional supported upstream usage fields should be surfaced when found, with units preserved.
- A6 / T3: all initial entry points render readonly. Eligible admins see Admin mode, not mode/settings/add/remove/switch controls. Explicit admin render remains server-authorized.
- A7 / T3: Admin mode click opens controls, Overview returns, Refresh and pagination preserve the chosen view. A non-admin forged click cannot gain controls or mutate state. Existing mutation routes and modal submissions still require admin authorization.
- A8 / T1–T3: preserve legacy CCT handling, including readonly default on `auth` in legacy mode; direct `cct` command behavior unchanged. New view actions are registered on Bolt; naked and `/z` auth reach the same renderer.
- A9 / T1–T3: bounded message payload (50 blocks including cancel and mutation banners), section <=3000 characters, footer reachable on large pools. Pagination must allow every account to be reached rather than silently truncate the pool. Escape untrusted Slack mrkdwn; no raw credentials in overview.

## Wiring and implementation

`AuthHandler.execute` / `createAuthTopicBinding.renderCard` → `renderAuthCard` → `fetchLlmuxStatus` → pure capacity/group helpers → `buildAuthCardBlocks` → Slack response.

`registerAuthActions` → view/refresh/page click (ack first) → effective viewer-mode authorization → same renderer. Management mutations preserve explicit admin mode; no global persisted admin-view flag.

Builder input adds `canManage`, `page`. Navigation values encode `{viewerMode,page}`. `renderAuthCard` clamps unauthorized admin requests to readonly. Page size bounded independently of API account count; provider summaries use the complete pool, account pages follow global grouped order.

## Non-goals

No changes to credential storage, scheduler decisions, provider limits, billing, or token rotation policy. No production data or live credentials in fixtures. No production deployment is implied by the UI change.
