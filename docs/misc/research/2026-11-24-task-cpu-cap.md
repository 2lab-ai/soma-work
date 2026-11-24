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
  metered. A metered task that runs under its cap for 8 periods in a row (2 s) is let go.
- **Each period (250 ms).** The parent map (`ps -A -o pid=,ppid=`) finds what the tree started since the sample;
  one `ps -o pid=,stat=,lstart=,time=` reads every member (Linux: `/proc/<pid>/stat` ticks over ps's whole seconds).
  The tree's rate since the last period sets the share of the next period it may run: `share = share × cap / rate`,
  at least 5%. Everything held is continued — each only if the read shows the same start time it was stopped with;
  after `share × 250 ms` the candidates are read once more and stopped, each only if it is still that process,
  running, and not a person's pause. A failed read skips one period, never the loop.
- **Measured:** a two-thread spinner at 184–190% free runs at 102–105% under a 100% cap (owner-mac, 4 s windows); a
  one-thread spinner under a 50% cap stays between 20% and 75% in the real-OS test on macOS and Linux CI.

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
