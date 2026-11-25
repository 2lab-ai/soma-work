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
   remembered pid with another start time is a reused pid and is dropped, together with its children. A new pid whose
   parent differs between the two `ps` calls was reused in between and is dropped too. A process born and orphaned
   between two samples is not seen. This is the known limit. A remembered process still in the parent map whose detail
   row is missing (ps skipped it) stays remembered, so an orphan is not lost to one bad row. Details are read in
   batches of 200 pids, and a failing batch costs only its rows. Start times have one-second resolution (`lstart`), so
   a pid reused within the same second would pass the identity check. On macOS (pid max 99999) that needs about 100k
   forks a second.
3. **CPU from cumulative CPU time.** CPU is the change in cumulative CPU time between two samples divided by the wall
   time between them (100% = one core). This means the same on macOS and Linux, unlike `ps %cpu`. On Linux the time
   comes from `/proc/<pid>/stat` (clock ticks), because `ps time` there has whole-second resolution.
4. **Pause is a signal guarded by identity.** Pause is `SIGSTOP` and resume is `SIGCONT`. A request names the pid and
   its start time. The monitor samples again at that moment and signals only a process that is in that session's tree
   with that start time. A pause whose check spans an abort of that turn is refused, because the abort's cleanup has
   already run. Once shutdown cleanup starts, no pause is accepted. Right before a manual signal, and before every
   automatic resume (abort, shutdown), the pid's live start time is read and a pid the OS has reused is skipped. An
   unreadable identity is unknown, not gone: the manual signal is refused, and an automatic resume keeps its entry, as
   it does when the OS refuses the resume. An abort continues only what was paused under that turn, or between turns,
   so a late abort of an earlier turn leaves the next turn's pauses alone. An abort's resume that could not be done is
   retried on every sample until it lands. A turn is its spawn's number in the registry (`turnId`), not the Claude Code
   pid, which the OS can hand to the next turn. A process keeps the turn it was seen under after it is orphaned, and
   what an orphan starts inherits it. A pause is refused only when its own turn is aborted during the check. A pause
   missing from a sample is dropped only when its live start time says the process is gone. A pause in a turn whose
   abort already ran is refused, because nothing would continue it. Shutdown retries a few times within a 5-second
   probe budget and logs whatever it could
   not continue. The route allows the owner, or an admin in admin mode, with CSRF. Aborting a turn continues
   the paused root (in the spawner) and everything the monitor paused in that session, so a stop still lands. The
   same holds when the abort arrives after the root has exited. On shutdown (drain, crash kill) the registry first tells
   the monitor, which continues everything it paused; the SIGTERM grace period starts after that pass. Every
   non-SIGKILL kill is followed by SIGCONT through the child's own handle. (Claude Code handles SIGTERM, and a handled
   signal waits while its process is stopped.) No process is left stopped once the daemon is gone.
5. **Per-node snapshot behind an interface.** `NodeProcessSnapshot` holds the node's capacity (cores, whole-node CPU
   in use, load, total and available memory) and each session's usage and processes. The dashboard and a future
   scheduler call `ProcessHost` (`latest`, `fresh`, `control`). They never touch `ps` or signals. `SOMA_NODE_ID`
   names the node (default: the host name). A worker node implements `ProcessHost` over its own transport.
   `GET /api/dashboard/nodes` (admins) is the scheduler-shaped read.
6. **Board privacy unchanged.** A card's usage is a field of its board card (`KanbanSession.procUsage`). It travels
   through the existing per-viewer board and the single-card pushes, and only cards whose chip changed are pushed. The
   process list route sits under `/api/dashboard/session/:key`, so the private-task gate covers it. Commands are shown
   only to the task's owner and admins (the work log's rule), and only as previews. A preview is an allow-list,
   because ps has flattened argv, and even with argv a flag's arity is unknown: a value can look like a flag
   (`jq --arg name --swordfish`) or a path (`p@ss/word`). So nothing after the program is copied from the command
   line:
   - The preview shows the program's basename and, for an interpreter, its script's basename: the first operand, with
     only known no-value options before it. After any cut value no word is taken as the script, because ps may have
     split that value and its tail can look like one.
   - It shows flag names from a fixed list (`SHOWN_FLAGS` in `command-preview.ts`). A listed flag that takes a value
     shows as `--model …`, and its next word is cut whatever it looks like.
   - The walk stops at the first word it does not know (an unknown or short flag, an operand, `NAME=value`, a second
     value). Everything from there is one `…`.
   - Every word of a preview is a constant of that module or the program's (or script's) own name. The logger's token
     redaction runs over that name.

7. **Where and what, by default; one process in depth, on purpose (2026-11-24).** Each sample also reads every
   session process's working directory (Linux `/proc/<pid>/cwd`, macOS one `lsof -a -d cwd` for all pids), cached
   15 seconds per (pid, start time); a folder is kept only when the pid's start time read after it is the one the
   sample saw (a reader names a pid, not a process). It travels with the command preview, under the same rule: the owner and admins
   see it, everyone else gets `''`. The preview now names a multi-command tool's subcommand (`npm run build`,
   `git status`, `gh pr view`): only for a fixed list of tools, only right after the program, only subcommand-shaped
   words. A row of the tab opens the process in depth: `ProcessHost.inspect` checks the pid and its start time against
   the session's tree, then reads the process once (ps fields, Linux `/proc` status, cmdline, fd links and net tables,
   macOS `ps -M` and `lsof`), and checks the start time again after the reads. The answer is a snapshot: the route
   (`GET …/processes/:pid/detail?start=`, owner and admins) never pushes it and the client never polls it. Its command
   line is the full line with secret values masked (`command-mask.ts`: JSON spans, secret-named flags and variables,
   HTTP credentials, URL passwords, known key shapes, long high-entropy runs; a delimiter inside a JSON string does not
   end a span, and an exact argument that is a command of its own — `bash -c '…'` — is masked word by word). This is a deny-list, so a secret with no
   shape after a flag whose name says nothing still shows. That is why the detail is the owner's and admins' only and
   is read only on a click. The environment is never read.
8. **The node on the card (2026-11-24; the task's own usage since 2026-11-25).** A card with a live tree is drawn
   with one badge in the head (`@2lab.ai/ui` 0.46.0 `card.node`): the node's name and two 10-step gauges for **this
   task's** CPU and memory. CPU is full at one core (100%, the default CPU cap; a stripe is 10% of a core). Memory is
   full at one core's share of the node's memory (its size ÷ its cores — `nodeMemBytes` and `cpuCount` ride with the
   usage). No number is drawn before the name: the pill's level says it (busy from 10% of a core; hot, a red ring, from
   100%), and its title and accessible name give the numbers. The head is the part a one-line card keeps, so the foot's
   CPU · 메모리 chip went (2026-11-25) — a layout saved with it drops it. A card is pushed again only when a gauge
   crosses a step or the level changes; the node's own load is not on the card (the 프로세스 tab's node line has it).

9. **A CPU cap per task (2026-11-24).** One task of a person may use at most their cap: 100% (one core) by default,
   none for an admin, an admin's choice per person in the settings page's 작업 큐 tab (`DATA_DIR/user-cpu-limits.json`,
   `cpu-limits.ts`). Neither OS gives an unprivileged quota on a running tree (Linux cgroup `cpu.max` needs delegated
   systemd; macOS has none), so the monitor holds a task over its cap with a duty cycle (`cpu-throttler.ts`): each
   period (250 ms, up to 30 s — long enough that its run part holds the identity read before each stop and its
   stopped part the period's reads) it reads the tree's CPU time, sets the share of the period the tree may run
   (share × cap / rate, at least 0.2%), runs it that long and stops it (`SIGSTOP`) the rest. A new worker joins the
   tree only if the read that gives its identity names a parent in it; an aborted turn's processes are never metered
   again. The parent map is read again at each stop: a worker the tree started since the period's scan (a shell that
   forks after each continue) is held at that stop too, and the CPU it used so far counts toward the next period's
   rate. A worker found right after a failed scan may be old, so its counter is baselined instead of charging its
   whole lifetime to one window (only a period's own scan sets that bound; a stop's extra scan failing does not
   erase it, and a stop that finishes after the next period started leaves discovery to that period). When the
   period's read misses a hold, every hold is read again, asynchronously, before any continue; only a pid two reads
   missed is probed live, and that synchronous probe runs while the tree is still stopped (no stop timer can fire
   during it). A cap change keeps a held tree metered on the new cap (its free rate is about old cap ÷ share; the
   sample reads it at its old cap, so re-metering from the sample would let it run free until the next one) and lets
   it go only when the new cap is over that rate. A stop whose identity read keeps failing, a read of workers found at
   a stop that keeps failing, and a saved cap that does not parse are said in the log. It never stops the Claude Code
   process itself, never continues what it did not stop (a person's pause becomes theirs), never signals a reused pid,
   and continues everything it holds on an abort, a cap change and shutdown (before the monitor's own resume pass). A held process reads as running with `throttled`, not as paused;
   a session says its `cpuCapPercent` and whether the cap is `throttling`. Research: [2026-11-24 task CPU
   cap](../misc/research/2026-11-24-task-cpu-cap.md).

## Consequences

- One sample costs two `ps` runs (plus `vm_stat` on macOS) every 5 seconds, and only while a tracked root or a
  remembered process exists. An idle daemon spawns nothing.
- Multi-instance boards: a sibling instance's cards carry their own instance's usage through the aggregator. Its
  process tab answers 409 here (open that instance's dashboard).
- Placing work on worker nodes is not built. This ADR fixes the shape the placement will read.
- Windows has no job-control signals: control answers `unsupported`. Sampling there is not supported.
- A capped task over its cap costs four `ps` runs a period (the parent map, the tree, the read before the stop, the
  parent map again at the stop) while it is over (none otherwise), and its processes see brief stops — what a cap
  is. A process that starts and exits within one run part is never read by the cap and runs uncapped for that short
  life.
- The working directory costs one `lsof` (macOS) or one `readlink` per pid (Linux) every 15 seconds per process, and
  nothing for the unattributed group. The detail read costs a handful of `ps`/`lsof` runs per click.

## Evidence

- Code: `src/process-monitor/` (types, `ps-table.ts`, `tree-sampler.ts`, `node-capacity.ts`, `process-monitor.ts`,
  `command-preview.ts`, `cwd-reader.ts`, `process-inspector.ts`, `command-mask.ts`, `cpu-throttler.ts`, `cpu-limits.ts`). The spawn owner is in `src/agent-runtime/claude-child-process-registry.ts`. The dashboard
  side is `setDashboardProcessSource`, `procCardsToPush`, and the routes in `src/conversation/dashboard.ts`.
- Tests: `src/process-monitor/__tests__/` include `process-monitor.real.test.ts`, which runs against the real `ps` and
  real signals on macOS and Linux. Route and client tests are `src/conversation/__tests__/dashboard-processes*.test.ts`.
- Browser receipt: `scripts/screenshot-processes.ts` (real page, real routes, real monitor over a real tree). Research
  behind the tree's design: [2026-11-24 process tree visualization](../misc/research/2026-11-24-process-tree-visualization.md).
