---
name: qa-issue
description: "Use when one tracker issue that is already deployed to a QA environment needs QA at a chosen depth, recorded on the issue — called per issue by local:deploy-qa, or standalone. At high and max it covers what a human QA covers (Coverage matrix) and checks every case's preconditions before running anything, asking the requester once when one is missing (Precondition gate). Args — <ISSUE-KEY> qa=default|medium|high|max env=<environment skill whose Environment and Policy sections are the profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<case catalog path>] [--plan = plan and gate only, run nothing] [decisions=<gate file> = resume with the requester's recorded answer]."
argument-hint: "<ISSUE-KEY> qa=<default|medium|high|max> env=<profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<path>] [--plan] [decisions=<gate file>]"
---

# qa-issue — QA one deployed issue, record it on the tracker, write JSON

One issue per call. The procedure is generic; every environment value (hosts, accounts, states, browser commands) comes from the profile.

## Invocation

```
$local:qa-issue <KEY> qa=<default|medium|high|max> env=<profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<path>] [--plan] [decisions=<gate file>]
```

- In SDK sessions the name is `zworkflow:qa-issue`. Example: `$local:qa-issue PROJ-123 qa=max env=acme-env:staging-qa`.
- `env=` names the environment skill. The profile = its `## Environment` and `## Policy` sections. Read its SKILL.md if they are not in context; never run its procedure.
- `transition=done` is granted only by the caller (`deploy-qa` passes it with `mergeShas`, `excludeBases`, `excludeHeads`, `runDir`). Without it, never move the issue to done.
- The caller owns `lockDir`. Never take or release the lock here.
- `--plan` runs steps 1–3 and the gate's planning half only, then returns (see Precondition gate). `decisions=<gate file>` resumes from a gate the requester answered.

## GitHub calls

Read GitHub through its REST API with curl; this works inside a sandboxed session, where the `gh` CLI's own network calls can fail (TLS verification), so do not use them. `gh auth token` only reads the stored token and works there. A **GitHub call** is:

```bash
curl -fsSL --connect-timeout 10 --max-time 30 -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" "https://api.github.com/<path>"
```

Write the whole form in every shell call, both timeouts included (shell state does not carry over), and read fields with `jq`. A non-zero exit is a failed call. Paging: add `per_page=100&page=N` and request N = 1, 2, … until a page holds fewer than 100 items (or follow the `rel="next"` URL of the `Link` response header, dumped with `-D <file>`, until there is none). A call that failed or timed out, or paging that stopped early, leaves the list incomplete — never read it as empty or complete.

## Profile fields

- Every run: `keyPattern`; `deploy` (per repo: how to read the running version and the running commit); `tracker` (site, state IDs for qa / done / in-progress, comment conventions); `qaEnv` (health URL(s), API bases, front-end URLs, test-account references, browser primitives `open` / `eval` / `screenshot`, screenshots directory); `lockDir` when no `runDir=` is passed. Optional: `severity`.
- Optional, read by the Precondition gate: `qaEnv.accounts` (role → account reference; any listed account may be used by any case), `qaEnv.writes` (`allowed` with the test accounts, or `forbidden`), `qaEnv.seed` (bounded setup actions QA may run, each with its cleanup), `qaEnv.logs` (how to read server errors for a time window). An absent optional field is never an error: the preconditions that need it are `missing`. The profile revision is the SHA-256 of the profile skill's SKILL.md.
- With `transition=done`, also: `doneConditions`, `repos`, the tracker's transition to done.
- Any of these absent, a browser primitive that fails to run, no tracker access, a missing account reference, or no masker → verdict `blocked`, reason `missing: <fields>`, no transition. Comment only if the tracker is usable.

## Procedure

1. `<KEY>` must fully match `keyPattern`; otherwise verdict `blocked`, reason `key-mismatch`. Read the issue: state, assignee, description, linked PRs.
2. Deploy check: read the running version → `env.versionStart`. With `mergeShas`, for each `<repo>:<mergeSha>` read that repo's running commit per its `deploy` entry and require a GitHub call to `repos/<repo>/compare/<mergeSha>...<runningSha>` piped to `jq -r .status` ∈ `ahead|identical`. Health unreachable, version or commit unreadable, or any other status → verdict `blocked`, reason `not-deployed`.
3. Build cases for the QA level: `catalog=` first; otherwise derive them from the issue text and the PR diffs. At `high` and `max`, fill the Coverage matrix (below) before anything else happens. Zero cases → verdict `blocked`, reason `no cases`.
4. At `high` and `max`: Precondition gate (below); `default` and `medium` skip it. With `--plan`, stop after it and return. A gap the requester has not answered ends the call here: no case runs.
5. Run the cases one at a time and collect evidence (see Evidence). With `decisions=`, run only the cases the gate's `decide` returned in `runCases`; record each of its `blockedCases` as `status: "blocked"` with `precondition: "<id>"` and its reason as `actual`.
6. Generation check (below), after the cases.
7. Aggregate the verdict (fail-closed):
   - any reproduced P0/P1 failure → `deploy_fail`, regardless of other cases;
   - else every case `pass` with evidence → `pass`;
   - else every case `blocked` → `blocked`;
   - else (any `blocked`/`partial` case, any P2/P3 failure) → `partial`.
   Fail-closed-by-design behaviour, missing test data and login gates are `blocked`/`partial`, never `deploy_fail`. Waived cases stay in every count and are never pass; the verdict's `reason` then starts `precondition-waived:<ids> by <who>`. A key the requester skipped → verdict `blocked`, reason `precondition-skipped by <who>`, no case run.
8. Reconcile the tracker (below).
9. Write the results (below) and return.

## Coverage matrix

At `high` and `max`, plan the cases against these dimensions before running anything. Each dimension gets case IDs or `N/A: <change-impact reason>` — a reason tied to the requirement, the architecture or the change, never just "not in the diff". A cell left blank, or an N/A without a reason, makes the plan invalid: verdict `blocked`, reason `matrix-incomplete:<dim>`. `acceptance`, `writes` and `negative` are never N/A when the change touches a write endpoint. The matrix decides the case count; it is risk-based, not a Cartesian product.

1. `acceptance` — every acceptance criterion and every behaviour the issue describes maps to at least one case. Each case fixes its oracle before it runs: the expected result, the `assertion` that decides pass, and the evidence kind (API body, screenshot, stored state).
2. `roles` — every role or account type the change touches, plus a second account wherever one account's data must stay invisible to another. A case runs under a listed account from `qaEnv.accounts`; it is never blocked because a sub-runner or lane was not allowed to use it — reroute it to one that is.
3. `writes` — the real write path end to end (create, update, bet, save, deposit, settle), then read back the stored state through the API or a second screen. For money: the balance or ledger before and after. Every fixture QA creates has a cleanup, and the cleanup is checked.
4. `crossSurface` — the effect lands where users see it: an admin change on the user surface, an API write in the stored state, a notification or webhook that should fire.
5. `dataStates` — empty, one, many and the page boundary, null or missing fields, limits.
6. `negative` — validation errors, permission denial, double submit, races, network failure and retry.
7. `persistence` — reload, log out and in, another tab, back and deep links.
8. `deviceLocale` — when the change touches layout, text or interactive UI: desktop and mobile (tablet when breakpoints change), every shipped locale for changed text, keyboard focus and labels for changed controls.
9. `time` — when behaviour depends on time (expiry, schedule, timezone). Controlling time — a short-TTL setting, near-expiry data — is a precondition, not a reason to skip.
10. `regression` — at most 3 smoke cases on flows next to the change (same screen, same endpoint).
11. `observability` — client console errors and failed requests during each flow (read through `eval`); a server error-log scan for the QA window through `qaEnv.logs` when the change touches error handling or a write endpoint.

Mocking is allowed only to produce a state that cannot be produced for real (a network failure, a rare server answer). List the mocked routes in `evidence.mocked`; a mocked case never proves server behaviour, so a requirement about the server needs an unmocked case too. A statistical case states its sample size and `tolerance` before it runs, and passes only inside it.

## Precondition gate

Runs after the cases are planned, before any case runs and before any tracker write. Every probe here is read-only.

**Plan.** For every planned case, list what it needs, each need being one precondition with a `kind`: `account` (a role or a second account), `test-data` (a record in a given state), `write-permission`, `env-config` (a flag or setting on), `external-system` (a partner system or job), `time-control`, `device-locale`, `observability` (logs). Probe each one and give it a status:
- `met` — it is there now (the account exists, the data is there, writes are allowed).
- `provisionable` — the profile lists a way: another account in `qaEnv.accounts` (reroute), a setup action in `qaEnv.seed` with its cleanup. Run that setup, then probe again; a setup that fails makes it `missing`. Nothing is improvised: a need the profile does not list is `missing`.
- `missing` — neither.

Write the plan to `<runDir>/gate-<KEY>.json` — `key`, `env` (`profile`, `profileRevision`), `inputs` (`deployedShas`, `issue` with `summary`, `description`, `acceptance`, `mergedPrs`), `plan` (`touchesWrite`, `coverage`, `cases` with `id`, `type`, `severity`, `desc`, `assertion`, `preconditions` — always listed, `[]` only when the case truly needs nothing), `preconditions` (`id`, `kind`, `need`, `cases`, `status`) — and seal it: `node "$CLAUDE_PLUGIN_ROOT/skills/qa-issue/scripts/gate.mjs" seal <runDir>/gate-<KEY>.json`. Exit 4 = the matrix or the mapping is invalid (it names `matrix-incomplete:<dim>` or the bad item): fix the plan; never run around it. `$CLAUDE_PLUGIN_ROOT` is two directories above this skill's base directory; write the absolute path.

`--plan` stops here: it runs steps 1–3, writes and seals `<runDir>/gate-<KEY>.json`, runs no case and writes no tracker comment, and returns `qa-issue <KEY>: plan gate=<abs path> missing=<ids or none>`. `deploy-qa` uses it to plan every key before it asks anything.

**Ask once.** Standalone (no `decisions=`): merge the one key — `node "…/gate.mjs" merge --out <runDir>/gate-run-<KEY>-<YYYYMMDDTHHMMSSZ>.json <runDir>/gate-<KEY>.json`. `ask: false` → run. `ask: true` → post the gap table to the calling thread — per missing precondition: what is missing, which cases it blocks with their severity, and what the requester could provide — then ask the requester one question with the session's question tool (`local:UIAskUserQuestion`), with three choices per key: provide it (QA waits until it exists), proceed without it (those cases end `blocked`, never pass, and the report leads with them), or skip the key. Return `qa-issue <KEY>: verdict=blocked … reason=waiting for precondition confirmation gate=<run gate path>` and stop. No case runs and no tracker write happens before the answer. No answer is waiting, never consent. If the session has no question tool (a cron session), the posted gap table is the question and the requester's reply in the thread is the answer.

**Record the answer.** When the requester answers, record it: `node "…/gate.mjs" answer --gate <run gate> --key <KEY|all> --decision provided|waived|skipped --by <who answered> --ref <message link or ts> [--ids <precondition ids>]`. No wildcard: a decision covers the gaps shown in that gate, never future ones. A waiver never grants a write or overrides a security rule; it only accepts that those cases are not tested. Then invoke again with `decisions=<run gate path>`.

**Resume (`decisions=`).** qa-issue loads the planned cases, coverage matrix and precondition→case mapping from the gate file verbatim and does not rebuild them. It re-reads only the inputs (deployed SHAs, profile revision, the issue's summary, description and acceptance criteria, the merged PRs) and re-probes each precondition's status, writes them to a current file `{env, inputs, statuses}`, and runs `node "…/gate.mjs" decide --gate <run gate> --key <KEY> --current <current file>`:
- exit 0, `run` → run `runCases`; record `blockedCases` as blocked (step 5).
- exit 0, `skip` → no case runs; verdict `blocked`, reason as given.
- exit 3, `ask` → no case runs; raise the gate again with a new plan and a new gate file (`merge --carry <old run gate>` keeps answers only for keys whose fingerprint did not change).

The fingerprint covers the frozen plan (case IDs, assertions, severities, coverage, the precondition→case mapping and each precondition's `kind` and `need`) and the inputs above. Probe results, decisions, the issue's `updated` time, its status and comments are never hashed: the workflow's own tracker writes never invalidate an answer, and a precondition that flips from `missing` to `met` after the requester provided it is the expected resume. A precondition answered `provided` but still `missing` on the re-probe asks again; only `waived` and `skipped` end a gap that stays missing. A waived precondition that is `met` on the re-probe runs its cases for real. A gate file is never overwritten; a changed plan is a new gate with a new ID.

## Generation check

Read the running version after the cases and again immediately before any transition. If it differs from `versionStart`, the run is superseded: set `versionStart` to the new version, re-run step 2 for it; with a gate, run `decide` again with the new inputs — an `ask` ends the call `blocked`, reason `waiting for precondition confirmation`, before any case re-runs; re-run the cases once, re-aggregate the verdict (step 7) and decide the transition again from the new results, checking again at both points. A second change in the same call → verdict `blocked`, reason `superseded: <v1>→<v2>→<v3>`, no transition. At most one retry per call. `env.versionEnd` = the last version read.

## Tracker reconcile

Order: decide → transition → re-read → comment. QA is complete only when the comment exists.

1. **Decide** the target:
   - `pass` + `transition=done` → done, only if every `doneConditions` entry holds now. Any unmet condition → no transition; the verdict stays `pass`, `statusTransition.performed=false`, `reason` = the first unmet condition (the caller treats this as unfinished).
   - `pass` without the flag → none, `performed=false`.
   - `deploy_fail` → in-progress only when `transition=done` was passed and the issue is in the qa state; otherwise none.
   - `blocked` / `partial` → none; keep the state.
2. **Transition**: run the generation check first. From the transitions the issue offers now, pick the one whose target state ID equals the profile's target state. Not offered → no transition, reason `no-transition`. Its ID differs from the profile's transition ID → no transition, reason `transition-mismatch`. One transition per call; never chain.
3. **Re-read** the issue: `verified` = the new state equals the target.
4. **Comment**, following the profile's conventions: verdict, each case with status, severity and evidence refs, `versionStart`/`versionEnd`, `mergeShas`, the verified `statusTransition`. On `deploy_fail`, add the reproduction and mention the assignee; also use the profile's direct-message method if it defines one → `dmSent`.

Comment self-check: read the comment back. Missing → re-post that same comment once; this retry never decides or transitions again. Still not confirmed → `trackerComment: null`, reason `reconcile-failed`; verdict and `statusTransition` stay as they are.

### doneConditions

Enforce exactly the conditions the profile lists. A condition you cannot evaluate counts as unmet. Standard ones:

- **state** — current state ID equals the profile's qa state.
- **depth** — `qaLevel` is `max`.
- **no open PR** — for each repo in `repos`, list every open PR with GitHub calls to `repos/<repo>/pulls?state=open&per_page=100&page=N`, N = 1, 2, … until a page holds fewer than 100 PRs (fields `number`, `title`, `head.ref`, `base.ref`). A list you cannot prove complete → unmet. A PR counts when its title or head branch contains this exact key (`keyPattern` match, never substring), minus excluded PRs (the same rule as admission): base equals an `excludeBases` entry (exact match), or head matches an `excludeHeads` entry — an entry ending in `/` is a prefix, any other entry is an exact match. Absent → exclude nothing. Never use the search API (`search/…`).
- **contained** — step 2's per-repo compare holds for every `mergeSha`, re-read now. Running commit unreadable or no `mergeShas` → unmet.

## Browser adapter

Use only the profile's three primitives: `open(url)`, `eval(js)`, `screenshot(path)`. Never drive a browser library directly.

- PASS evidence comes only from `eval` results and `screenshot` files. A natural-language mode of the adapter is for exploration; its output never counts as PASS evidence.
- Screenshots go to `<screenshotsDir>/<KEY>-<caseId>.png` — never `/tmp` or a session sandbox path. After each capture, read the file to confirm it exists and is not empty.
- API values behind cookies or CSRF: `open` a page on that origin, then `eval` a same-origin `fetch(url, {credentials: 'include'})` that returns `{status, body: await r.text()}`. If the profile names a CSRF cookie and header, copy the token from that cookie into that header. A direct HTTP call rejected with 403 is not a product failure.
- Endpoints: read them from the front-end API client source (grep its calls) or the PR diff, and use the method that client uses. Never guess.
- Login: use the profile's account reference. Fill inputs with the native value setter plus an `input` event, submit, and wait for the post-login page.

## QA levels and severity

- `default`: 1–2 happy cases + the deploy check.
- `medium`: 2–3 happy + 1–3 edge.
- `high`: 3–4 happy + 4–6 edge, plus the Coverage matrix and the Precondition gate.
- `max`: the full Coverage matrix and the Precondition gate, covering every endpoint and screen the PR diffs change, with at least 3 happy + 7 edge cases as a backstop. The floor is never a reason to pad: a duplicate case does not add coverage.
- Severity: `profile.severity` if present; else P0 = data loss, security, or a core flow broken; P1 = a main feature broken; P2 = degraded with a workaround; P3 = cosmetic.

## Evidence (mandatory)

- **Backend** — per case: method, full URL, request body, status, and the full raw response JSON. Never summarise or truncate; for huge lists keep the first item plus the total count.
- **Front-end** — a real render screenshot taken through the adapter. Grepping the bundle alone never passes.
- Record the version and its provenance (health field, image tag, or the fallback source used).
- No evidence → no pass (`blocked`/`partial`). Never fabricate evidence.
- Keep evidence in both places: the JSON file and the tracker comment.
- **Masking** — the masker is `node "$CLAUDE_PLUGIN_ROOT/skills/qa-report/scripts/mask.mjs" < in > out` (JSON or text, same format out; exit 2 = bad input → do not write). (`$CLAUDE_PLUGIN_ROOT` = two directories above this skill's base directory; shells usually do not set it, so write the absolute path.) First run the structured result JSON through it as JSON. Build the tracker comment only from that masked JSON, then pipe the formatted comment text through it as well before posting. Never interpolate unmasked values into Markdown and never write an unmasked copy to disk. Masking is the only allowed edit to raw evidence.
- **Credentials** — account references only. Never put a credential value in a command line, `eval` source, `steps`, or a file name. Write the shell variable or file the account reference names (e.g. `"$QA_PASSWORD"`, `"$(cat <file>)"`) and let the shell expand it.

## Results

Write the full JSON, masked, to `<runDir>/<KEY>.json` (standalone default `runDir` = `<lockDir>/runs/manual-<YYYYMMDD-HHMMSS>/`). Return only the path and one line:
`qa-issue <KEY>: verdict=<verdict> transition=<to|none> performed=<bool> verified=<bool> reason=<reason> json=<abs path>`.
While the gate waits, the line is `qa-issue <KEY>: verdict=blocked transition=none performed=false verified=false reason=waiting for precondition confirmation gate=<abs path>`, and no `<KEY>.json` is written.
Never post the full JSON to the thread.

```json
{ "key":"PROJ-123","qaLevel":"max",
  "env":{"profile":"acme-env:staging-qa","versionStart":"...","versionEnd":"..."},
  "deployConfirm":{"version":"...","state":"live","provenance":"..."},
  "coverage":{"acceptance":["QA-1"],"time":"N/A: no time-dependent behaviour", "…":"every dimension"},
  "preconditions":[{"id":"P1","kind":"write-permission","need":"...","cases":["QA-3"],"status":"met|provisionable|missing",
    "decision":"provided|waived|skipped|pending","confirmedBy":"...","confirmedAt":"...","confirmRef":"..."}],
  "cases":[{"id":"QA-1","type":"happy|edge","desc":"...","severity":"P0|P1|P2|P3","status":"pass|fail|blocked|partial",
    "precondition":"<id, only when blocked by one>","assertion":"...",
    "auth":{"accountRef":"..."},"steps":["..."],"expected":"...","actual":"...",
    "evidence":{"reqResp":{"method":"POST","url":"https://app.example.com/api/...","reqBody":"...","status":200,"respRaw":"<full json>"},
      "shot":"/srv/qa-state/shots/PROJ-123-QA-1.png","mocked":["<route, only when mocked>"]}}],
  "verdict":"pass|deploy_fail|blocked|partial","reason":"...",
  "statusTransition":{"from":"<state ID>","to":"<state ID>","transitionId":"...","performed":false,"verified":false,"reason":"..."},
  "trackerComment":"<commentId>|null","dmSent":false }
```

- `statusTransition` is always present, in the JSON and in the comment. `from` / `to` are tracker state IDs (not names); `to` is the target even when `performed=false`, or `null` when there is none.
- `preconditions` lists every precondition the gate planned, with its last status and the requester's decision (`pending` while unanswered); `qa-report` leads with it. The tracker comment starts with the same list when any precondition was missing.
- `trackerComment` is the confirmed comment ID. If the comment could not be confirmed, it is `null` and `reason` is `reconcile-failed`. The caller treats that issue as open.

## Hard rules

1. QA only what is deployed; otherwise `blocked` / `not-deployed`.
2. No evidence → no pass. A case blocked by a missing precondition is never pass, waived or not.
3. At `high` and `max`: no case runs before the Precondition gate is clear or answered.
4. Done only with `transition=done` + every `doneConditions` entry + an unchanged version. Everything else is comment-only.
5. Record on the original tracker issue. Return the JSON path and the one-line summary.
6. No deploys, merges, reverts or lock handling.
