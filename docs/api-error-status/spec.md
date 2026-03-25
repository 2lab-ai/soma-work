# API Error Status Page Capture — Spec

> STV Spec | Created: 2026-03-26

## 1. Overview

When Claude Code SDK returns 4xx/5xx API errors, the bot currently displays raw error text that gives users no context about whether the issue is on Anthropic's side. This feature automatically fetches https://status.claude.com on API errors and enriches the error message with live service status — showing active incidents, per-component health, and uptime data in a clean Slack-formatted block.

## 2. User Stories

- As a **bot user**, I want to see Claude's service status when API errors occur, so that I know whether to wait or retry.
- As a **bot user**, I want the status information displayed cleanly in the same error message, so that I don't need to manually check status.claude.com.
- As a **bot admin**, I want status fetching to be resilient and cached, so that it doesn't add latency or cascade failures.

## 3. Acceptance Criteria

- [ ] When a Claude SDK error with 4xx/5xx pattern occurs, status.claude.com is fetched
- [ ] Status information is appended to the existing error message in Slack
- [ ] Display includes: overall status, per-component status (operational/degraded/outage), active incidents
- [ ] Status data is cached with short TTL (~2min) to avoid hammering the status page
- [ ] If status.claude.com is unreachable, error message is sent without status (graceful degradation)
- [ ] Status fetch does not add more than 3 seconds to error reporting (timeout)
- [ ] Unit tests cover: successful fetch + parse, cache hit, fetch failure, non-API errors skip status

## 4. Scope

### In-Scope
- Fetching and parsing status.claude.com HTML for component statuses and incidents
- Enriching error messages in `stream-executor.ts` with status data
- In-memory cache with TTL
- Slack mrkdwn formatted status block

### Out-of-Scope
- Screenshot/image generation of the status page (overkill — structured text is cleaner in Slack)
- Proactive status monitoring (polling when no error occurs)
- Historical incident display (only active incidents)
- Webhook integration with status page providers

## 5. Architecture

### 5.1 Layer Structure

```
stream-executor.ts (handleError)
    ↓ calls
claude-status-fetcher.ts (fetchClaudeStatus)
    ↓ fetches
status.claude.com (HTML with embedded JSON)
    ↓ returns
StatusInfo { components, incidents, overall }
    ↓ formats
formatStatusForSlack(status) → Slack mrkdwn string
    ↓ appends to
formatErrorForUser() output
```

### 5.2 Module: `src/claude-status-fetcher.ts`

New standalone module following `link-metadata-fetcher.ts` pattern:
- Module-level Map cache with 2-minute TTL
- Native `fetch()` with 3-second timeout
- HTML parsing via regex (no external dependency) to extract component statuses and incidents
- Exported pure functions, no class instantiation needed

```typescript
// Key exports
export interface ClaudeStatusInfo {
  overall: 'operational' | 'degraded' | 'outage' | 'unknown';
  components: Array<{
    name: string;
    status: 'operational' | 'degraded' | 'outage' | 'unknown';
  }>;
  incidents: Array<{
    title: string;
    status: string; // e.g., "Investigating", "Monitoring"
  }>;
  fetchedAt: number;
}

export async function fetchClaudeStatus(): Promise<ClaudeStatusInfo | null>
export function formatStatusForSlack(status: ClaudeStatusInfo): string
export function invalidateStatusCache(): void
```

### 5.3 Integration Point: `stream-executor.ts`

No new dependency injection needed. Import as pure functions (same pattern as `tokenManager` import).

In `handleError()`, after classifying the error as non-abort:
1. Start `fetchClaudeStatus()` in parallel with existing error handling
2. In `formatErrorForUser()`, accept optional `ClaudeStatusInfo` parameter
3. If status available, append formatted status block after existing error lines

### 5.4 Slack Output Format

```
:x: *[Bot Error]* API Error: 500 Internal server error

> *Type:* Claude SDK (Error)
> *Session:* :white_check_mark: 유지됨 - 대화를 계속할 수 있습니다.

:bar_chart: *Claude Service Status* (status.claude.com)
> :red_circle: *Claude API* — Partial Outage
> :red_circle: *Claude Code* — Partial Outage
> :large_green_circle: *Claude for Government* — Operational
>
> :warning: *Active Incidents:*
> • Elevated errors on Claude Opus 4.6 (Investigating)
> • Elevated connection reset errors (Monitoring)
```

When all operational:
```
:bar_chart: *Claude Service Status* — :large_green_circle: All Systems Operational
```

### 5.5 Integration Points

| Existing File | Change | Size |
|---|---|---|
| `src/slack/pipeline/stream-executor.ts` | Call `fetchClaudeStatus()` in handleError, pass to formatErrorForUser | ~15 lines |
| `src/slack/pipeline/stream-executor.ts` | Extend `formatErrorForUser()` to accept and render status | ~10 lines |
| New: `src/claude-status-fetcher.ts` | Standalone fetcher + formatter + cache | ~120 lines |
| New: `src/claude-status-fetcher.test.ts` | Unit tests | ~150 lines |

## 6. Non-Functional Requirements

- **Performance**: 3-second fetch timeout; 2-minute cache TTL; fetch runs in parallel with error formatting
- **Reliability**: Graceful degradation — null return on any fetch/parse failure
- **Security**: No credentials needed (public status page)
- **Scalability**: Single in-memory cache instance; no external state

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Standalone module (not class/dep injection) | tiny | Follows link-metadata-fetcher.ts pattern exactly |
| Native fetch() + regex parsing | tiny | No new dependencies; status page is simple HTML |
| 2-minute cache TTL | tiny | Balance freshness vs. not hammering; easily changed |
| Slack mrkdwn text (not Block Kit blocks) | small | Error messages use `say({ text })` pattern; Block Kit would require refactoring say() calls (~20 lines) |
| No screenshot/image generation | small | Structured text is more accessible in Slack, works on all devices, and avoids puppeteer dependency |
| Emoji-based status indicators | tiny | :large_green_circle:/:yellow_circle:/:red_circle: are standard Slack status conventions |

## 8. Open Questions

None — all dimensions covered by codebase patterns and user requirements.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/api-error-status/spec.md`
