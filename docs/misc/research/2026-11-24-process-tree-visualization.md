# Process tree visualization for the 프로세스 tab (2026-11-24)

**In short:** draw the tree the way htop does (guides), fold it the way btop does (a folded parent carries its
subtree's totals), put a small meter in each row, and mark CPU in three steps — quiet under 1% of a core, busy from
10%, hot from 100% — with words and a glyph as well as colour. A row opens one process's snapshot, the way Process
Explorer's Properties window does. Treemaps and sunbursts were rejected for trees of 5–200 processes.

What this decided: the layout of the 프로세스 tab and its detail dialog in soma-work (ADR 0003 §7). Code:
`panelProcsHtml`, `procTreeRows`, `procDetailHtml` in `src/conversation/dashboard.ts`.

## What the reference tools do

| Tool | Tree | Per-row load | Busy / hot | Detail |
| --- | --- | --- | --- | --- |
| htop (F5 tree) | `├─ └─ │` guides by depth, children under their parent | `CPU%` `MEM%` columns, meters only in the header | colour of the value | none (strace, lsof by key) |
| btop | guides, `[+]` / `[-]` fold per parent; a folded parent shows the sum of its subtree | inline mini graphs per row (CPU history) | gradient from green to red by load | a detail box: command line, status, threads, memory, I/O |
| Process Explorer | tree with fold per parent | CPU column, a graph per process in Properties | row tint by type (service, own, suspended), new / exited rows flash | Properties: Image (path, command line, current directory, parent, user, started), Performance, Threads, TCP/IP, Environment |
| Activity Monitor | flat or "All processes, hierarchically" | `% CPU` column, graph only for the whole machine | none | Inspect window: parent, user, CPU time, threads, ports, open files and ports |

Takeaways that carried over:

1. The guide characters are what makes a flat table read as a tree at a glance; indentation alone does not survive a
   narrow column.
2. A fold that hides children must still say what it hides (count and totals), or a busy grandchild disappears.
3. A meter per row lets the eye find the heavy process without reading numbers; one shared scale per column (one core
   for CPU, the tree's largest process for memory) keeps rows comparable.
4. Colour alone fails for colour-blind readers and in forced-colors mode: every level also changes weight, and "hot"
   adds ▲ and the core count in words (`1.8코어`).
5. The detail is a snapshot people read on purpose. Process Explorer refreshes its Properties live, which makes long
   values jump while being read; the owner asked for a fixed snapshot with an explicit re-take.

## Thresholds

- **Under 1% of a core — quiet.** The value is dimmed so the eye skips it.
- **10% or more — busy.** Amber, bold; its meter is amber.
- **100% or more — hot (more than one core).** Red, extra bold, ▲ before the value, the cores in words, a striped
  meter that is full, a red tint and a left rail on the row. The session total in the summary line takes the same
  level.

CPU is the tree sampler's measured rate (change in CPU time over wall time, 100% = one core), so a multi-threaded
process reads over 100% exactly when it uses more than one core.

## Layout under a detail card's width

The detail card is about 430 px wide. Five fixed columns (CPU, memory, PID, state, the button) left the name column
near zero in the first receipt, which hid the guides and the fold toggles. The table now has the tree, CPU, memory and
an icon-only pause button; each row's PID, state, working directory and command read on a line under it.

## Rejected

- **Treemap / sunburst / icicle.** They show share well for hundreds of nodes, but here a tree has 5–200 processes, the
  reader's question is "which one is busy and what is it doing", and the labels (command, folder) do not fit in cells.
- **Live detail.** See takeaway 5.
- **Per-row history graphs (btop).** They need a sample history per process on the client. The tab polls every 3
  seconds, so a short sparkline is possible later. It was left out to keep the first version's rows one height.

## Sources

- htop: `man htop` (tree view, F5), https://htop.dev
- btop: https://github.com/aristocratos/btop (process box: tree mode, collapse, detailed view)
- Process Explorer: https://learn.microsoft.com/sysinternals/downloads/process-explorer (Properties: Image,
  Performance, TCP/IP tabs)
- Activity Monitor: https://support.apple.com/guide/activity-monitor/ (View › All Processes, Hierarchically; Inspect)
- WCAG 2.2 SC 1.4.1 Use of Color: https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html
