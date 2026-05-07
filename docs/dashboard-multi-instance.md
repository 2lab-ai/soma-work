# Dashboard Multi-Instance Aggregation (#814)

When two or more soma-work instances run on the **same host** (e.g.
`oudwood-dev:33000` + `mac-mini-dev:33001`), each instance now publishes a
heartbeat file under `~/.soma/instances/<port>.json` and the dashboard at
`:33000/dashboard` automatically fans out to its siblings, merges their
kanban boards, and tags every card with an environment badge.

## Operator setup

1. Set `INSTANCE_NAME` on **every** instance (e.g.
   `INSTANCE_NAME=oudwood-dev`). Without it the heartbeat record falls
   back to `${hostname}:${port}` — still functional, just less readable.
2. Set the **same** `CONVERSATION_VIEWER_TOKEN` on every instance that
   should aggregate together. The aggregator authenticates cross-port
   GETs with `Authorization: Bearer ${CONVERSATION_VIEWER_TOKEN}` against
   each sibling. Mismatched / missing tokens cause the dashboard to fall
   back to self-only with a one-shot warn log.
3. (rare) Set `SOMA_INSTANCE_DIR` to relocate the heartbeat directory.
   Default: `~/.soma/instances`.

That's it. No restart-ordering requirements, no leader election. Each
instance writes its own heartbeat and discovers others independently.

## What you see in the UI

- Each card gets a colored `env-badge` in the meta row identifying the
  owning instance. Hovering shows `<instanceName> (<host>:<port>)`.
- The topbar **token usage** stat is the sum across instances. Hovering
  the value reveals an env-grouped breakdown:
  `oudwood-dev: 12K · mac-mini-dev: 8K · Total: 20K`. On touch
  devices, tap the value to toggle.
- Single-env case (one instance running, or `INSTANCE_NAME` unset) keeps
  the topbar quiet — no tooltip, no badge — so single-instance deploys
  are visually unchanged.

## Failure modes (intentionally graceful)

| Condition                                | Behaviour                                                   |
| ---------------------------------------- | ----------------------------------------------------------- |
| Sibling instance crashed (no heartbeat refresh for 30s) | Excluded from aggregation; treated as gone               |
| Sibling instance returns 5xx / timeout    | Silently skipped; `Sibling dashboard fetch failed` warn (1×) |
| `CONVERSATION_VIEWER_TOKEN` mismatched    | Self-only fallback; `… set` warn (1×)                       |
| `CONVERSATION_VIEWER_TOKEN` empty everywhere | Self-only fallback; `…not set` warn (1×)                  |
| Aggregator throws unexpectedly            | Self-only fallback; the `/api/dashboard/sessions` endpoint never 500s |

## Architecture

Three modules:

1. **`src/conversation/instance-registry.ts`** — heartbeat read/write.
   Atomic write (`tmp + rename`) with `0600` perms. Stale records
   (`lastSeen > 30s`) are filtered out by readers. The owner process
   refreshes every 5s.

2. **`src/conversation/aggregator.ts`** — sibling fan-out. Discovers via
   `readAllInstances`, filters out self by both port AND pid (defends
   against port reuse after a crash), fetches each sibling's
   `/api/dashboard/sessions?selfOnly=true` (the `selfOnly=true` is the
   recursion guard — siblings must not re-aggregate). Stamps each
   sibling card's `environment` and rewrites the wire-format key as
   `${instanceName}::${originalKey}` to avoid client-cache collisions.

3. **`src/conversation/dashboard.ts`** — calls `fetchSiblingBoards` from
   the existing `/api/dashboard/sessions` handler and merges the
   results. Self cards get the local env stamp + composite key on the
   way out via `sessionToKanban`. Action endpoints (`/stop`, `/close`,
   ...) strip the `${selfInstance}::` prefix before resolving against
   the local session map.

## Lifecycle

- `web-server.ts` calls `startHeartbeatLoop` immediately after
  `server.listen` succeeds (so `activePort` is final), and
  `removeHeartbeat` + `clearInterval` from `stopWebServer` so SIGTERM /
  SIGINT cleans up registry entries before we tear down listeners.

## Out of scope (for #814)

- Cross-host network discovery (only same-machine multi-instance).
- WebSocket merging — `ws://...` is still per-instance; the kanban
  board polls every 30s and that's where sibling data refreshes.
- Cross-instance action routing — clicking Stop on a sibling card from
  `:33000` will fail because the action endpoint hits `:33000`'s
  session map (which doesn't own the sibling session). Workaround:
  open the sibling's dashboard directly. Tracked separately.

## Testing

- `src/conversation/__tests__/instance-registry.test.ts` — atomic write,
  stale filter, 0600 perms, glob, lifecycle.
- `src/conversation/__tests__/aggregator.test.ts` — self exclusion
  (port+pid), `selfOnly=true` enforcement, 5xx / timeout / parse-error
  resilience, token-missing fallback, board merge with env stamping.
- `src/conversation/__tests__/dashboard-multi-instance.test.ts` —
  end-to-end through the Fastify route; verifies composite keys, env
  stamping on self/sibling, action-endpoint prefix stripping, and the
  `selfOnly=true` short-circuit.
- `src/conversation/__tests__/dashboard-multi-instance-frontend.test.ts`
  — static structural assertions on the inline JS/CSS bundle.
