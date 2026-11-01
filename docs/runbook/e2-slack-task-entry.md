# Runbook: a Slack instruction as a dashboard task (E2)

**In one line:** each user turns it on (`/z taskentry on`). To turn it off for everyone, use Tier 2; to remove the code, use Tier 3. A task that is already live stays a dashboard task either way.

**Contents:**

1. What runs where
2. State and logs
3. Rollback (three tiers, fastest first)
4. Dev measurement checklist (.prd/18 §5 ⑨)

**Reference:**
- Spec: `.prd/18-slack-notifier-e2-spec.md`.
- Wiring: `docs/misc/reference/architecture.md` (E2 ①–⑧).
- Epic #652. The entry is #671 (⑧) and the hardening is #672 (⑨).

## 1. What runs where

- **Entry** (`src/slack/task-entry.ts`): `SlackHandler.processMessage` calls it after command routing.
- **Instruction-thread guard:**
  - the router calls it on `app_mention` and on the `file_share` "bot mention" path;
  - `processMessage` calls it first, for messages that drained from the queue.
- **Notices:** a separate deliverer (`src/task-turn/task-notice-deliverer.ts`) posts them to the thread. It is the only poster. The task runner never calls Slack.
- **Boot condition:** `index.ts` wires the entry only when the notice ledger loaded. If the ledger cannot be read:
  - the entry is off;
  - every instruction runs as a Slack session;
  - a task that still owes its thread cannot be closed. The dashboard answers 409 with the reason.

## 2. State and logs

| Where | What |
|---|---|
| `<DATA_DIR>/user-settings.json` | `slackTaskEntry: true` per user (off when absent) |
| `<DATA_DIR>/sessions.json` | a task's `originThread` (`channel`, `threadTs`, `messageTs`) and `notices` (still owed) |
| `<DATA_DIR>/task-notification-ledger.json` | one row per notice: `id`, `kind`, `state` (`pending` · `unknown` · `posted` · `failed` · `resolved` · `superseded`), `attempts`, `error`, `messageTs`, `createdAt`, `updatedAt` |

**Log lines** (in `logs/stderr.log`):
- `Slack instruction became a dashboard task`: the entry made a task.
- `Task notice not delivered`: a write failed before the post. It is retried up to `maxAttempts` in a row.
- `Task notice ledger unreadable`: the deliverer and the entry are off.
- `Close refused — the session is kept`: a dashboard close got 409.

The `<DATA_DIR>` on the fleet is `/opt/soma-work/<env>/data`.

## 3. Rollback

### Tier 1 — one user (immediate, no restart)

The user sends `/z taskentry off`, or turns it off in the dashboard settings ("Slack 지시 → 대시보드 작업").

- Their next instruction runs as a Slack session.
- Live tasks and their threads stay as they are: guarded, and their notices are still delivered.
- To end a task, close it on its card.

### Tier 2 — every user (one restart)

Stop the service first. The store keeps settings in memory and writes them back.

```bash
cd /opt/soma-work/<env>
sudo ./scripts/service.sh stop
cp data/user-settings.json data/user-settings.json.pre-taskentry-off
node -e 'const f="data/user-settings.json";const s=JSON.parse(require("fs").readFileSync(f));for(const u of Object.values(s))delete u.slackTaskEntry;require("fs").writeFileSync(f+".tmp",JSON.stringify(s,null,2));require("fs").renameSync(f+".tmp",f)'
sudo ./scripts/service.sh start
```

Live tasks stay dashboard tasks, as in Tier 1.

### Tier 3 — remove the entry (a deploy)

Revert the merge of #671, then deploy (`main:deploy/dev`, then `main:deploy/prod`).

- ①–⑦ and ⑨ stay. With no entry, they have no caller, but the deliverer still posts what live tasks owe their threads.
- After the revert the router no longer guards instruction threads. A mention in a live task's old thread then starts a Slack session there.
- To avoid that, close those tasks before the deploy. The dashboard filters them as Slack-less cards that have a Slack thread link.

### The ledger cannot be read

The deliverer and the entry are off, and tasks that owe their thread are kept (they cannot be closed). To recover:

1. Stop the service.
2. Move `task-notification-ledger.json` aside. The loader also tries its `.bak`.
3. Start the service. Owed notices are registered again from the task records, and the boot pass sends them. A notice that was in flight when the ledger broke may be sent twice (D7 allows one duplicate).

## 4. Dev measurement checklist (.prd/18 §5 ⑨)

**Owner's steps:** enable it, give instructions, restart once.

1. In a dev channel: `/z taskentry on`.
2. Mention the bot with an instruction that needs one approval, for example: `@bot 이 레포 README 첫 줄을 summary.txt에 써줘`.
   - **Check:** the thread gets only the card link. The work shows on the dashboard card.
3. Approve once on the card.
   - **Check:** the thread got an approval notice when it was asked, and a result notice at the end. Nothing else.
4. In the same thread, mention again and send `!멈춰`.
   - **Check:** one card-link notice each. No Slack session opens.
5. Give one more instruction, and while it runs, restart dev (`sudo /opt/soma-work/dev/scripts/service.sh restart`).
   - **Check:** exactly one "중단" notice in its thread.
6. `/z taskentry off`, then mention again.
   - **Check:** a normal Slack session, as before.

**Measurements** (read-only, on the dev host):

```bash
cd /opt/soma-work/dev/data
node -e '
const L=JSON.parse(require("fs").readFileSync("task-notification-ledger.json")).entries??[];
const S=JSON.parse(require("fs").readFileSync("sessions.json"));
const byTask=new Map(S.filter(s=>s.originThread).map(s=>[s.taskId,s]));
for(const e of (Array.isArray(L)?L:Object.values(L))){const t=byTask.get(e.taskId);if(!t)continue;
 const lag=e.messageTs?(Number(e.messageTs)-Number(t.originThread.messageTs)).toFixed(1)+"s from mention":"-";
 console.log(e.taskId.slice(0,8),e.kind.padEnd(12),e.state.padEnd(10),"attempts",e.attempts,"posted after",((e.updatedAt-e.createdAt)/1000).toFixed(1)+"s",lag);}'
```

**Targets:**
- Wrong runs: 0. No Slack session in a task's thread (search `stderr.log` for that thread's ts).
- Duplicate tasks: 0. One task per `originThread`.
- Lost results: 0. Every `result` row is `posted`.
- Latency:
  - mention → link: the link row's `messageTs` minus the mention ts;
  - end → notice: the result row's `updatedAt` minus `createdAt`.
- Message count per task: rows per `taskId`.
