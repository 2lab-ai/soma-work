# Deploy-triggered cron lanes

A cron job can also fire when a deploy lands. The job's owner opts in with
`onDeploy: [{ "repo": "acme/app", "target": "deploy/dev2" }]` (cron MCP
`cron_create` / `cron_update`; `clear_onDeploy` or `[]` removes it). The deploy
workflow runs in the session of whoever asked for the deploy and, for each repo,
emits one `deploy_completed` directive after the merge succeeded and the
deployment of the merge commit is confirmed
(`src/prompt/workflows/deploy.prompt`, step 7). The harness strips the directive
from the visible text, matches it against every job's `onDeploy` (repo
case-insensitive, target exact after dropping `refs/heads/` — `dev2` does not
match `deploy/dev2`), and fires each match through `CronScheduler.runJobNow`:
the owner's identity and the job's own target/mode/model, with the deployer
recorded as `triggeredBy` in cron history. The owner's `onDeploy` entry is the
consent, so there is no run-allowlist check or permission prompt. The deploy
thread gets one line naming the lanes started and where they post (or why a
matched lane did not start); nothing is posted when no lane matched. The deploy
turn never waits for a lane.

```json
{
  "type": "deploy_completed",
  "repo": "acme/app",
  "target": "deploy/dev2",
  "before": "<target sha before the merge, optional>",
  "after": "<merge commit sha, required>"
}
```

`repo` must be `owner/repo`; `after` (and `before` when present) is 7–40 hex
characters. An invalid directive is logged, left visible, and fires nothing.

Notes for lane owners:

- The signal is model output from any session, so the lane must check the
  deploy itself (e.g. the target branch's head is `after`) and be idempotent. The
  harness only drops a repeat of the same (job, `after`) within 6 hours, in
  memory — a restart forgets it.
- A lane that should run only on deploys can use an expression that never
  matches, e.g. `0 0 31 2 *`.
- A `mode: default` job in the owner's active session queues behind it, as any
  cron fire does; `mode: fastlane` always opens its own thread.

Code: `somalib/cron/cron-storage.ts` (`onDeploy`, `jobMatchesDeploy`),
`packages/slack/src/directives/deploy-completed-directive.ts`,
`packages/slack/src/pipeline/stream-executor.ts` (`onDeployCompleted`),
`src/deploy-lanes.ts`.
