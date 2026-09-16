# Auth capacity architecture

Status: in-progress
Date: 2026-09-16
Contract: [06-auth-capacity-spec.md](06-auth-capacity-spec.md) · [Execution loop](auth-capacity-overview/loop.md)

## Boundaries

[BUNDLE] The existing TypeScript Slack app stays in place. No dependency, database, scheduler, credential-storage or provider-authentication changes are introduced.

- Entry: `AuthHandler.execute` and `createAuthTopicBinding` call `renderAuthCard`.
- Read: `fetchLlmuxStatus` calls the existing authenticated `GET /llmux/status`. Its five-second abort remains in the client.
- Transform: `src/slack/auth/capacity.ts` groups accounts, validates ratios, separates quota windows, formats reset times and describes unknown observations.
- View: `builder.ts` emits provider summaries from the whole pool, paged account rows, and navigation state `{viewerMode,page}`. The page is presentation state, never scheduler state.
- Act: `registerAuthActions` acknowledges clicks before work and rechecks the actor. `renderAuthCard` independently clamps unauthorized admin overrides to readonly. Existing management actions remain admin-gated.
- Legacy: `renderCctCard` accepts an embedding input so `auth` can paginate slots without trimming away accounts. Direct `cct` rendering is unchanged. Embedded mutations must return to the wrapper with its page and viewer mode; tests cover that contract before shipment.

## Data contract

[RESEARCH] `/llmux/status` supplies ratios, reset timestamps and optional manual-reset counters. Absolute remaining subscription tokens and plan weights do not exist in that response. A provider total is the sum of measured remaining ratios, labelled `계정분`, separately for each window and model scope. It includes blocked accounts and says so. Missing values do not become zero or unlimited.

Grok's ratio represents a rate limit, not a five-hour subscription allowance. Its synthetic reset is suppressed. Cumulative token counters describe consumption, never remaining capacity.

Slack date tags carry epoch seconds so each client displays reset and snapshot times in its own timezone. The relative duration and conditional recovered percentage remain alongside the reset.

## State and effects

There is no new persistent UI state. Navigation travels in button values; modal metadata carries the originating surface. Runtime auth mode/settings still use the existing atomic `data/auth-runtime.json` storage. Credential mutation occurs only through existing management paths. Displaying Codex reset credits does not redeem them.

## Payload and authority invariants

- Default `auth` is readonly for both admins and ordinary users.
- Admin eligibility exposes only the opt-in button, not management controls.
- Forged viewer state cannot grant mutation authority.
- Pagination keeps each account reachable and leaves room under Slack's 50-block message cap for cancel and result banners.
- Provider data is escaped before mrkdwn rendering. Infrastructure settings are absent from the overview.

## Verification boundary

[BUNDLE] Unit tests, real command-to-emitted-button integration tests, and CSS-approximation screenshots verify local behavior. They do not prove a deployed Slack client accepted the card.

[LIVE] The final gate requires CI, review, merge, a permitted preview deployment and post-deploy observations. Production deployment remains a separate authorization boundary. Numbered documents remain `in-progress` until those receipts exist.
