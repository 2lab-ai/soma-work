# ADR 0003: Session process monitor — one tree per session, reported per node

Status: Accepted
Date: 2026-11-23

## In short

Each work session runs one Claude Code process, and everything that process starts runs under it. We tie that
process to its session when the SDK spawns it, sample the whole tree on the node it runs on, and report the result
as one snapshot per node. Today the only node is the one the daemon runs on. Later, worker nodes will report the
same snapshot, and work will be placed by each node's free CPU and memory.

## Context

- The owner asked to see, per task, how much CPU and memory its Claude Code process and every process under it uses
  (on the task card), to see each process in the detail card, and to pause any of them. Work sessions will later be
  spread from the master node over worker nodes by their free CPU and memory.
- The Agent SDK spawns the CLI through `spawnClaudeCodeProcess`. soma-work already owns that hook
  (`createTrackedClaudeProcessSpawner`, `src/agent-runtime/claude-child-process-registry.ts`) to drain children on
  shutdown. Nothing tied a child to a session.
- A session's tree is not stable. Bash tools, MCP servers and background jobs come and go. A child whose parent exits
  is re-parented by the OS. A pid can be reused for another program.
- Reading another process's environment (to tag descendants with an env marker) is not reliable: macOS hides it from
  `ps -E` under the sandbox, and it would pull every process's secrets into the daemon.

## Decision

1. **Tie at spawn, not by search.** The spawn hook takes an owner (`{ sessionKey }`). `ClaudeHandler.streamSdkQuery`
   passes the turn's session key through `buildStreamOptions({ processOwner })`. Children with no owner (title,
   dispatch, voice one-shots) are the node's `unattributed` use.
2. **Walk the tree with `ps`, remember what was seen.** Each sample runs `ps` twice: first the whole parent map
   (`-A -o pid=,ppid=`, small), then the details for the tree members only. Every process seen under a session is
   remembered by (pid, start time). A process re-parented after its parent exits stays with the session. A
   remembered pid with another start time is a reused pid and is dropped, together with its children. A process born
   and orphaned between two samples is not seen. This is the known limit.
3. **CPU from cumulative CPU time.** CPU is the change in `ps time` between two samples divided by the wall time
   between them (100% = one core). This means the same on macOS and Linux, unlike `ps %cpu`.
4. **Pause is a signal guarded by identity.** Pause is `SIGSTOP` and resume is `SIGCONT`. A request names the pid and
   its start time. The monitor samples again at that moment and signals only a process that is in that session's tree
   with that start time. The route allows the owner, or an admin in admin mode, with CSRF. Aborting a turn continues
   the paused root (in the spawner) and everything the monitor paused in that session, so a stop still lands.
5. **Per-node snapshot behind an interface.** `NodeProcessSnapshot` holds the node's capacity (cores, whole-node CPU
   in use, load, total and available memory) and each session's usage and processes. The dashboard and a future
   scheduler call `ProcessHost` (`latest`, `fresh`, `control`). They never touch `ps` or signals. `SOMA_NODE_ID`
   names the node (default: the host name). A worker node implements `ProcessHost` over its own transport.
   `GET /api/dashboard/nodes` (admins) is the scheduler-shaped read.
6. **Board privacy unchanged.** A card's usage is a field of its board card (`KanbanSession.procUsage`). It travels
   through the existing per-viewer board and the single-card pushes, and only cards whose chip changed are pushed. The
   process list route sits under `/api/dashboard/session/:key`, so the private-task gate covers it. Commands are
   previews: values after config, prompt and secret flags, `NAME=secret` values, JSON blobs and long tokens are cut,
   and then the logger's token redaction runs over the result.

## Consequences

- One sample costs two `ps` runs (plus `vm_stat` on macOS) every 5 seconds, and only while a tracked root or a
  remembered process exists. An idle daemon spawns nothing.
- Multi-instance boards: a sibling instance's cards carry their own instance's usage through the aggregator. Its
  process tab answers 409 here (open that instance's dashboard).
- Placing work on worker nodes is not built. This ADR fixes the shape the placement will read.
- Windows has no job-control signals: control answers `unsupported`. Sampling there is not supported.

## Evidence

- Code: `src/process-monitor/` (types, `ps-table.ts`, `tree-sampler.ts`, `node-capacity.ts`, `process-monitor.ts`,
  `command-preview.ts`). The spawn owner is in `src/agent-runtime/claude-child-process-registry.ts`. The dashboard
  side is `setDashboardProcessSource`, `procCardsToPush`, and the routes in `src/conversation/dashboard.ts`.
- Tests: `src/process-monitor/__tests__/` include `process-monitor.real.test.ts`, which runs against the real `ps` and
  real signals on macOS and Linux. Route and client tests are `src/conversation/__tests__/dashboard-processes*.test.ts`.
