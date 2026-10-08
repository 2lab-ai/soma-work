# llmux SDK authentication isolation

## Acceptance and client surface

Slack conversations and helper requests keep using the Claude Agent SDK Messages
transport against the installed llmux. Selecting llmux owns the downstream URL
and tenant key; inherited provider authentication must not replace that identity.
There is no change to Slack commands, CCT behavior, model selection or tool policy.

## Vertical trace

1. **Entry/auth**: a conversation acquires its existing slot lease; llmux mode
   acquires `ensureTenantKey(userId)` or uses the existing shared-key fallback.
2. **Input**: inherited environment + operator `claude.env` + live auth mode +
   optional `{baseUrl, secret}` tenant lease. The lease is an atomic endpoint/key pair.
3. **Flow**: `buildQueryEnv` copies the environment, applies the operator overlay,
   removes competing credentials/provider selectors and filters credential custom
   headers in llmux mode, with `tenant.baseUrl → ANTHROPIC_BASE_URL` and
   `tenant.secret → ANTHROPIC_API_KEY`. Unrelated custom headers survive.
   The pinned SDK copies `options.env` as the complete child environment,
   rather than merging the parent environment again. Deleted values remain absent.
   Agent SDK `query(options.env)` sends `/v1/messages` with that `x-api-key`;
   llmux resolves the key to its tenant before routing the selected model.
4. **Effects**: only the new per-call map changes; no process-global env writes,
   persisted settings changes, key rotation, Slack sends or tool-policy changes.
5. **Errors**: SDK/daemon errors use existing callers' handling. Auth selection
   does not silently switch endpoints or tenants on failure. CCT remains unchanged.
6. **Output**: SDK messages/results flow through the existing stream processor;
   llmux attributes usage to the presented tenant key.
7. **Verification**: actual pinned SDK against a local HTTP fixture captures
   request headers; unit tests cover overlay, provider flags, concurrency and
   unchanged CCT/env behavior. Deployment is outside this PR.

## File map / status

- `src/auth/query-env-builder.ts`: removes competing values from the per-call map.
- `src/auth/__tests__/query-env-builder.llmux.test.ts`: RED/GREEN for overlay, header filtering and deleted-key semantics.
- `src/auth/__tests__/query-env-builder.sdk.test.ts`: actual SDK 0.3.284 RED/GREEN for bearer/custom authentication headers; OAuth-only compatibility coverage.
- README pair / docs index / architecture: synchronized.

No SDK or llmux version bump is required: soma-work is a Messages client; the new
Codex Responses frontend is an additional llmux ingress, not a required migration.

## Verification boundary

On 2026-10-08 the unmodified baseline failed the actual SDK bearer and custom-header
wire cases: inherited bearer auth added an Authorization header; a custom
`x-api-key` replaced the intended tenant key. The OAuth-only case already passed
because the baseline deletes `CLAUDE_CODE_OAUTH_TOKEN`; it is compatibility coverage,
not a newly reproduced defect. The corrected fixture leaves the bearer variable
absent in that case instead of setting it to an empty string.

SDK 0.3.284's `query` copies the supplied environment (`yt=k?{...k}:{...process.env}`
in the installed `sdk.mjs`), and the transport passes that map to `spawn` unchanged.
There is no second parent-environment merge requiring undefined entries.

The implementation passes all three local wire cases. The fixture uses a loopback
HTTP server, explicit `CLAUDE_CONFIG_DIR`, empty settings sources, disabled session
persistence and disabled nonessential traffic. It preserves HOME and never starts
a Slack app. Live provider/tool execution and deployment are not claimed by this
PR; the user requested a PR only.
