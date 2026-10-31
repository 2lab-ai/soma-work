# Runbook: epic sessions on the dashboard (E4)

**In one line:** each user turns it on (`/z epictasks on`). Turning it off stops new epics but not running ones. To stop an epic, close it on its card. To remove the feature, revert the merges and deploy.

**Contents:**

1. What runs where
2. State and logs
3. Rollback (three tiers, fastest first)
4. Dev measurement checklist (.prd/19 §5 ⑩)

**Reference:**
- Spec: `.prd/19-epic-session-e4-spec.md`.
- Wiring: `docs/misc/reference/architecture.md` (E4 ①–⑩).
- Epic #677. Measurement issue #688.

## 1. What runs where

- **Making an epic:** the dashboard composer's 에픽 chip, shown only to users whose flag is on, sends `kind: 'epic'` to the new-task API. The launcher (`src/task-turn/task-launcher.ts`) checks the flag again. If the flag is off, the API answers 403.
- **The epic's tools:** the `epic` MCP server (`src/task-turn/epic-server.ts`) is attached on the epic's own turns only. It has four tools:
  - `plan_write` writes the whole node tree;
  - `spawn_child` makes one child per node, at most 7 per epic;
  - `child_status` reads the tree and the children;
  - `instruct_child` gives a child its next instruction or an answer.
- **Children** are Slack-less tasks with `parentTaskId` and `planNodeId`. At most 3 run at once per epic tree. A tree is limited to 30 starts per 10 minutes and has a cost limit (`epicCostLimitUsd`, default $50). These limits live in `src/task-turn/task-turn-controller.ts`.
- **Waking** (`src/task-turn/epic-wake.ts`): when a child's chain ends, the epic gets an event. An idle epic that is not done then gets one host turn whose text is `Epic wake: N events — <node>:<word>, …`. That turn's start consumes the events. A restart puts the events that an unfinished epic turn consumed back to pending, and the boot scan wakes the epic again.
- **Closing** (`src/task-turn/task-close.ts`): closing an epic marks each running child "closed by its parent", cancels them all, then closes the epic. The mark names the chain it cancelled. Closing a child records a `closed` event on its epic. A close never wakes the epic.
- **The board:** the EPIC lane draws each epic with:
  - its state chip;
  - its progress (accepted nodes of all nodes);
  - its plan tree;
  - its children's cards.

  An epic's children appear only in its lane, not in the board's columns.

## 2. State and logs

| Where | What |
|---|---|
| `<DATA_DIR>/user-settings.json` | `epicTasks: true` per user (off when absent) |
| `<DATA_DIR>/sessions.json` | epic: `kind: 'epic'`, `plan` (nodes, `accepted`, `done`, `retired`), `epicEvents` (`state` pending/delivered, `consumedBy`), `childTaskIds`. Child: `parentTaskId`, `planNodeId`, `closedBy` (`by`, `at`, `chain`) |
| `<DATA_DIR>/archives/*.json` | the same fields, after the normal clock archives a done tree |
| `<DATA_DIR>/conversations/<id>.json` | the epic's turns. Each wake turn is a user turn starting with `Epic wake:` |

**Log lines** (in `logs/stdout.log` and `logs/stderr.log`):
- `Epic wake not started — its events stay pending`: the start was refused. On 429, 500 or 503 it retries once after a minute.
- `Epic wake failed — its events stay pending`: the wake threw.
- `Epic event dropped — the epic is closing`: logged at info. This is by design while an epic closes.
- `Epic event dropped — the epic is gone`: logged at warn. A child reported to an epic that no longer exists.
- `A Slack-less task turn tried to call Slack — a missed seam`: a task turn called Slack. This must never appear (T9).

## 3. Rollback

### Tier 1 — one user (immediate, no restart)

The user sends `/z epictasks off`, or turns off **에픽 작업 (실험)** in the dashboard settings.

- The composer no longer shows the 에픽 chip, and the new-task API refuses `kind: 'epic'` with 403.
- Epics that already exist keep running and keep waking. To stop one, close it on its card. That cancels its running children first.

### Tier 2 — every user (one restart)

Stop the service first. The store keeps settings in memory and writes them back.

```bash
sudo ./scripts/service.sh stop
cd /opt/soma-work/<env>/data
cp user-settings.json user-settings.json.pre-epictasks-off
node -e 'const f="user-settings.json";const s=JSON.parse(require("fs").readFileSync(f));for(const u of Object.values(s))delete u.epicTasks;require("fs").writeFileSync(f+".tmp",JSON.stringify(s,null,2));require("fs").renameSync(f+".tmp",f)'
sudo ./scripts/service.sh start
```

Existing epics behave as in Tier 1. Close them on their cards.

### Tier 3 — remove the feature (a deploy)

Close every live epic on its card first. Then revert the E4 merges, newest first, and deploy (`main:deploy/dev`, then `main:deploy/prod`).

- The merges, newest first: #711, #709, #708, #707, #706, #705, #704, #703, #702, #701, #700, #699, #697, #695, #692, #689.
- Tier 2 plus closing every epic stops all epic work without a deploy. Prefer that unless the code itself must go.

## 4. Dev measurement checklist (.prd/19 §5 ⑩)

**Owner's steps:** turn it on, make one epic, restart once while a child runs.

1. Send `/z epictasks on` to the dev bot, or turn on **에픽 작업 (실험)** in the dashboard settings.
2. On the dev dashboard, go to **새 작업** → **대시보드 작업** and turn on the **에픽** chip. Give an instruction that splits into three parts, for example: `README 초안의 설치·사용·라이선스 세 섹션을 각각 다른 파일로 써줘`.
   - **Check:** the EPIC lane shows the epic, a plan tree with 3 nodes, progress 0/3, and the children's cards as they are made.
3. Wait for one child to finish while another still runs. Then restart dev (`sudo ./scripts/service.sh restart`).
   - **Check:** after the restart, the epic, its children and their events are still there. The epic wakes once for what the restart cut.
4. Let it run until every node is accepted.
   - **Check:** progress reaches 3/3 and the epic's state is done.

**Measurements** (read-only, on the dev host):

```bash
node scripts/e4-epic-measure.mjs /opt/soma-work/dev/data /opt/soma-work/dev/logs
```

For each epic, it prints:
- its nodes and verdicts, and whether it is done;
- how many children each node spawned;
- its events by state and outcome;
- the chains that consumed them;
- each wake turn and what it woke for.

Add `--json` for the raw report.

**Targets (each must be 0):**
- `wrongStarts`: a live child off its epic's plan, or a child of another owner.
- `duplicateChildren`: a node that spawned more than one child, or two live children on one node.
- `missedWakes`: pending chain ends on a live, idle epic that is not done.
- `extraWakeTurns`: wake turns beyond the chains that consumed events. A restart that cut an epic turn adds one released wake, so this number must match the restarts that cut an epic turn, not be 0.
- `slackCalls`: task turns that tried to call Slack (T9).

**Not a target:** "nothing pending". A child that ends after its epic wrote done leaves its event pending, and a done epic is never woken.

**Also worth a look:** the tree window (30 starts per 10 minutes) and the cost limit ($50) were set as guesses (spec §6). Note whether either was hit (`Epic wake not started` with 429).
