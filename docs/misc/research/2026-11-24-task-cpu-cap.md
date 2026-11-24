# A CPU cap per task on macOS and Linux (2026-11-24)

**In short:** neither OS gives a daemon running as an ordinary user a quota it can put on a process tree that is
already running. Linux has one (cgroup v2 `cpu.max`) only when systemd delegates the cpu controller to the user's
slice; macOS has none. So soma-work caps a task the way `cpulimit` does: a duty cycle of `SIGSTOP` / `SIGCONT` over
the task's tree, measured from cumulative CPU time. Default: 100% (one core) per task for everyone but admins, who
have no cap; an admin sets a person's cap in the settings page's 작업 큐 tab.

What this decided: `src/process-monitor/cpu-throttler.ts` and `cpu-limits.ts` (ADR 0003 §9).

## Options

| Mechanism | Linux | macOS | Needs | Notes |
| --- | --- | --- | --- | --- |
| cgroup v2 `cpu.max` (`systemd-run --user --scope -p CPUQuota=100%`) | yes, when the cpu controller is delegated to the user slice (systemd ≥ 252 delegates it by default; older ones only memory and pids) | — | a wrapper at spawn, user systemd | exact and cheap, enforced by the kernel. Fails silently without delegation: the scope runs uncapped, so `/proc/<pid>/cgroup` → `cpu.max` must be checked |
| `setrlimit(RLIMIT_CPU)` | yes | yes | — | a total CPU-seconds budget, then SIGXCPU/SIGKILL — a kill, not a rate |
| `nice` / `renice`, `taskpolicy -c utility` (macOS) | yes | yes | — | lowers priority only: a tree still takes every idle core |
| CPU affinity (`taskset`, `sched_setaffinity`) | yes | no API for other processes | — | pins to N cores; a child can widen its own mask; only whole cores |
| Duty cycle (`SIGSTOP`/`SIGCONT`, the `cpulimit` tool) | yes | yes | signals to own processes | a rate cap at any percentage, adjustable live; costs one `ps` per period while a task is over its cap; stops are visible to the process tree as brief pauses |

The deploy hosts are macOS today and Linux later, the cap must change live per person, and the processes to cap are
already running when a task goes over (Bash tools, test runners, builds). The duty cycle is the one mechanism that
works the same on both without root or a wrapper. A cgroup path on Linux can come later for hosts that delegate the
controller; it would replace the throttler there, not sit beside it.

## How the duty cycle works here

- **When.** The monitor samples every 5 s. A task whose tree used more than its cap over a sample starts being
  metered. A metered task that runs under half its cap for 8 periods in a row (2 s on an idle host) is let go; one
  held to its cap reads at its cap, so it stays metered.
- **Each period (250 ms; up to 4 s, see below).** The parent map (`ps -A -o pid=,ppid=`) finds what the tree started
  since the sample — only under members whose start time this period's read matched. One
  `ps -o pid=,ppid=,stat=,lstart=,time=` reads every member (Linux: `/proc/<pid>/stat` ticks over ps's whole seconds);
  a new worker is adopted only if that read, which gives its identity, names a parent already in the tree — a pid
  that changed hands since the parent map is someone else's. The tree's rate since the last period sets the share of
  the period it may run: `share = share × cap / rate`, at least 1% (a tree up to 100 times its cap is held to it).
  Everything held is continued — each only if a read shows the same start time it was stopped with (a pid no read
  answers for is checked with one batched `ps`, and kept held while unknown; a held pid is read again with any
  later read of the period). The candidates are read once more and stopped at the share's end, each only if it is
  still that process, running, and not a person's pause. A failed read skips one period, never the loop.
- **The period's length.** The tree runs through the read before each stop, so that read sets a floor under the
  share: a 150 ms `ps` in a 250 ms period let a tree run 60% of it whatever its cap, and a 16-core tree under a 100%
  cap (a 6% share) read 274% in the simulated test with a 900 ms period. So a period is at least six reads long and
  its run part at least 1.5 reads (`period ≥ 1.5 × read ÷ share`, the read time smoothed), at most 4 s; the stop's
  read starts early so the stop lands at the share's end; a stop whose read comes back after the next period already
  continued is dropped (it would hold the tree a whole period).
- **An aborted turn.** Its processes are never metered again: not by a sample that was in flight when the turn
  aborted (the abort released them), nor by later samples while its workers clean up. The session's next turn is.
- **What it cannot see.** A process that starts and exits between two periods is never read; it runs uncapped for its
  short life.
- **Measured:** a two-thread spinner at 184–190% free runs at 102–105% under a 100% cap (owner-mac, 4 s windows); a
  one-thread spinner under a 20% cap ran at 18.0–19.6% on owner-mac at a load average of 13–30 (the real-OS test
  allows 5–40% on macOS and Linux CI).

## What it never does

- Stop the session's Claude Code process (its CPU counts toward the cap; holding it would stall the turn's I/O).
- Continue a process it did not stop: a person's 일시중지, or a process stopped by someone else, is left alone. A person
  who pauses a held process makes it theirs.
- Signal a pid whose start time is not the one the tree sampled (a reused pid).
- Leave anything stopped: an abort of the task, a cap change, the tree leaving the sample and daemon shutdown continue
  everything it holds — shutdown first, before the monitor's own resume pass. Release and shutdown read each held
  pid's start time live first; a hold whose identity cannot be read, or whose continue the OS refuses, is kept and
  tried again every period (shutdown: three passes, then a warning naming the pids).

## What a person sees

- The 프로세스 tab's totals: `CPU 한도 100%`, and `· 맞추는 중` while the cap holds the tree. A held process reads
  as running with a `한도` tag — not as paused.
- The card's CPU chip and node badge say the cap in their titles.
- The settings page's 작업 큐 tab: a CPU 한도 choice per person (기본값 · 50% · 100% · 200% · 400% · 800% · 무제한).

## Sources

- cgroup v2 `cpu.max`: https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu-interface-files
- systemd delegation: https://systemd.io/CGROUP_DELEGATION/ and `systemd.resource-control(5)` `CPUQuota=`
- `cpulimit`: https://github.com/opsengine/cpulimit (the SIGSTOP/SIGCONT work-rate loop)
- `setrlimit(2)` `RLIMIT_CPU`; `taskpolicy(8)` (macOS)
