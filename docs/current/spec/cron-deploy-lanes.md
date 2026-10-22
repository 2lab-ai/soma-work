# Deploy-triggered cron lanes

A cron job can also fire when a deploy lands. The job's owner opts in with
`onDeploy: [{ "repo": "acme/app", "target": "deploy/staging" }]` (cron MCP
`cron_create` / `cron_update`; `clear_onDeploy`, `null` or `[]` removes it). The
deploy workflow runs in the session of whoever asked for the deploy and, for
each repo whose merge succeeded, emits one `deploy_completed` directive
(`src/prompt/workflows/deploy.prompt`, step 7) — with `"confirmed": false` when
neither a CD run nor a healthcheck could confirm the deployment. Only a
deploy-workflow session's directive is acted on; anywhere else it is stripped
and ignored, so a lane cannot re-trigger lanes. The harness matches it against
every job's `onDeploy` (repo case-insensitive, target exact after dropping
`refs/heads/` — `staging` does not match `deploy/staging`) and fires each match
through `CronScheduler.runJobNow` with the owner's identity and the job's model,
always in a **new thread in the job's channel** (`forceNewThread`; the job's
`mode`/`target` do not apply), with the deployer recorded as `triggeredBy`. The
prompt ends with a line naming the deploy:
`[deploy_completed repo=<repo> target=<target> before=<sha|-> after=<sha> by=<user>]`,
so a job registered for several repos runs once per repo, scoped by it. The
owner's `onDeploy` entry is the consent, so there is no run-allowlist check or
permission prompt. The deploy turn never waits for a lane.

```json
{
  "type": "deploy_completed",
  "repo": "acme/app",
  "target": "deploy/staging",
  "before": "<target sha before the merge, optional>",
  "after": "<merge commit sha, required>",
  "confirmed": false
}
```

`repo` must be `owner/repo`; `after` (and `before` when present) is 7–40 hex
characters; `confirmed` is optional (absent = true). In raw JSON `"type"` must be
the first key.

What the deploy thread hears (one line per case; every ⚠️ line ends with
`(owner: cron run <lane>)`):

| Case | Line |
|---|---|
| Lanes started | `▶ 배포 레인 시작 — <repo> → <target> (<sha7>): *lane* → #channel 새 스레드` |
| Same lane + merge commit again within 6 h | `ℹ️ 배포 레인 이미 발동됨 HH:MM KST — …` |
| No lane for this target, but the repo has lanes | `ℹ️ <repo> → <target>: 레인 없음 (등록: <targets>)` |
| `confirmed: false` and lanes match | `⚠️ <repo> → <target> 머지됨, 배포 미확인 — 레인 미발동: …` |
| A lane failed to start (or failed after the 5 s window) | `⚠️ 배포 레인 미발동 — …` / follow-up `⚠️ 배포 레인 실패 — …` |
| Scheduler not running and lanes match | `⚠️ 배포 레인 미발동 — cron scheduler not running: …` |
| Cron file unreadable | `⚠️ 배포 레인 확인 불가 — …` |
| A `"deploy_completed"` attempt that is invalid or unparseable | `⚠️ deploy_completed 무시됨 — <problem>; 레인 미발동` |

A repo no lane lists stays quiet. A directive still unflushed when the turn is
cut (stop, interrupt, supersede, idle timeout) is dispatched anyway: the deploy
it reports already happened.

Notes for lane owners:

- The signal is model output, so the lane must check the deploy itself (e.g. the
  target branch's head is `after`) and be idempotent. The harness only drops a
  repeat of the same (job, `after`) within 6 hours, in memory — a restart
  forgets it, and a failed fire frees the pair for a retry.
- A lane that should run only on deploys can use an expression that never
  matches, e.g. `0 0 31 2 *`.

Code: `somalib/cron/cron-storage.ts` (`onDeploy`, `jobMatchesDeploy`,
`getAllStrict`), `src/cron-scheduler.ts` (`runJobNow` `forceNewThread` / `note`),
`packages/slack/src/directives/deploy-completed-directive.ts`,
`packages/slack/src/stream-processor.ts`,
`packages/slack/src/pipeline/stream-executor.ts` (`onDeployCompleted`),
`src/deploy-lanes.ts`.
