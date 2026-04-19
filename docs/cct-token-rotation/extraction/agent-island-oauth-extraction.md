# OAuth HTTP Contract — agent-island extraction

> This file documents the OAuth HTTP contract used by soma-work's CCT
> subsystem, extracted from the `agent-island` reference implementation.
> It is a reference for reviewers working on CCT token rotation and for
> any future non-Slack consumer (dashboard, cron worker, agent-session)
> that needs to refresh an `OAuthAttachment`.

## Endpoint

`POST https://platform.claude.com/v1/oauth/token`

## Client ID

`9d1c250a-e61b-44d9-88ed-5944d1962f5e`

## Request body

JSON (`Content-Type: application/json`):

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "<current refresh_token>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

## Response (200 OK)

```json
{
  "access_token": "sk-ant-oat01-...",
  "refresh_token": "sk-ant-ort01-...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "scope": "user:inference user:profile"
}
```

- `expires_in` is seconds-from-now. Soma-work stores
  `expiresAtMs = Date.now() + expires_in * 1000`.
- `refresh_token` may be rotated; always replace the stored value with
  the response value.
- `scope` is a space-separated list.

## Error mapping

| HTTP status | Body signal | Soma-work action |
|-------------|-------------|------------------|
| 400 | `error: "invalid_grant"` | Slot `authState = 'revoked'` (terminal). See audit blocker A3. |
| 401 | any | Usage endpoint: force-refresh path only (A4). Refresh endpoint: `refresh_failed` retriable. |
| 403 | any | Slot `authState = 'revoked'` (terminal). |
| 429 | `Retry-After` header | Honour backoff, retry after interval. |
| 5xx / network | any | Transient: single retry with 500ms delay (C6). |

## Source

Extracted from `agent-island@a6ca08c2`:
<https://github.com/2lab-ai/agent-island/tree/a6ca08c28ffe311760ac18bb759279253a5c6e3a>

Relevant symbols in that tree:

- `refreshClaudeCredentials(current)` — the canonical refresh function.
- `CLAUDE_OAUTH_CLIENT_ID` — the client-id constant (mirrored above).

## Consumer in soma-work

- `src/oauth/refresher.ts` — wraps this endpoint for CCT slot refresh.
- `src/token-manager.ts` — consumes the refresher; passes the current
  `OAuthAttachment` in and stores the returned tokens back.
- `src/cct-store/types.ts` — defines `OAuthAttachment`, the persisted
  shape that mirrors the response fields plus
  `acknowledgedConsumerTosRisk`.

## Scope note

This document describes the HTTP contract only. Further factoring of
`src/oauth/**` into a separately packaged island is out of scope for
issue #575 and not part of the 2-PR stack (PR-A + PR-B).
