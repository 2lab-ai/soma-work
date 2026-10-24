---
name: qa-issue
description: "Use when one tracker issue that is already deployed to a QA environment needs QA at a chosen depth, recorded on the issue — called per issue by local:deploy-qa, or standalone. Args — <ISSUE-KEY> qa=default|medium|high|max env=<environment skill whose Environment and Policy sections are the profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<case catalog path>]."
argument-hint: "<ISSUE-KEY> qa=<default|medium|high|max> env=<profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<path>]"
---

# qa-issue — QA one deployed issue, record it on the tracker, write JSON

One issue per call. The procedure is generic; every environment value (hosts, accounts, states, browser commands) comes from the profile.

## Invocation

```
$local:qa-issue <KEY> qa=<default|medium|high|max> env=<profile> [transition=done mergeShas=<repo:sha,…> excludeBases=<list> excludeHeads=<list>] [runDir=<dir>] [catalog=<path>]
```

- In SDK sessions the name is `zworkflow:qa-issue`. Example: `$local:qa-issue PROJ-123 qa=max env=acme-env:staging-qa`.
- `env=` names the environment skill. The profile = its `## Environment` and `## Policy` sections. Read its SKILL.md if they are not in context; never run its procedure.
- `transition=done` is granted only by the caller (`deploy-qa` passes it with `mergeShas`, `excludeBases`, `excludeHeads`, `runDir`). Without it, never move the issue to done.
- The caller owns `lockDir`. Never take or release the lock here.

## Profile fields

- Every run: `keyPattern`; `deploy` (per repo: how to read the running version and the running commit); `tracker` (site, state IDs for qa / done / in-progress, comment conventions); `qaEnv` (health URL(s), API bases, front-end URLs, test-account references, browser primitives `open` / `eval` / `screenshot`, screenshots directory); `lockDir` when no `runDir=` is passed. Optional: `severity`.
- With `transition=done`, also: `doneConditions`, `repos`, the tracker's transition to done.
- Any of these absent, a browser primitive that fails to run, no tracker access, a missing account reference, or no masker → verdict `blocked`, reason `missing: <fields>`, no transition. Comment only if the tracker is usable.

## Procedure

1. `<KEY>` must fully match `keyPattern`; otherwise verdict `blocked`, reason `key-mismatch`. Read the issue: state, assignee, description, linked PRs.
2. Deploy check: read the running version → `env.versionStart`. With `mergeShas`, for each `<repo>:<mergeSha>` read that repo's running commit per its `deploy` entry and require `gh api repos/<repo>/compare/<mergeSha>...<runningSha> --jq .status` ∈ `ahead|identical`. Health unreachable, version or commit unreadable, or any other status → verdict `blocked`, reason `not-deployed`.
3. Build cases for the QA level: `catalog=` first; otherwise derive them from the issue text and the PR diffs. Zero cases → verdict `blocked`, reason `no cases`.
4. Run the cases one at a time and collect evidence (see Evidence).
5. Generation check (below), after the cases.
6. Aggregate the verdict (fail-closed):
   - any reproduced P0/P1 failure → `deploy_fail`, regardless of other cases;
   - else every case `pass` with evidence → `pass`;
   - else (any `blocked`/`partial` case, any P2/P3 failure) → `partial`.
   Fail-closed-by-design behaviour, missing test data and login gates are `blocked`/`partial`, never `deploy_fail`.
7. Reconcile the tracker (below).
8. Write the results (below) and return.

## Generation check

Read the running version after the cases and again immediately before any transition. If it differs from `versionStart`, the run is superseded: set `versionStart` to the new version, re-run step 2 for it, re-run the cases once, re-aggregate the verdict (step 6) and decide the transition again from the new results, checking again at both points. A second change in the same call → verdict `blocked`, reason `superseded: <v1>→<v2>→<v3>`, no transition. At most one retry per call. `env.versionEnd` = the last version read.

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
- **no open PR** — for each repo in `repos`, list every open PR: `gh pr list -R <repo> --state open --limit 1000 --json number,title,headRefName,baseRefName`. If the count reaches the limit, page through `gh api --paginate "repos/<repo>/pulls?state=open&per_page=100"`. A list you cannot prove complete → unmet. A PR counts when its title or head branch contains this exact key (`keyPattern` match, never substring), minus excluded PRs (the same rule as admission): base equals an `excludeBases` entry (exact match), or head matches an `excludeHeads` entry — an entry ending in `/` is a prefix, any other entry is an exact match. Absent → exclude nothing. Never use `gh search`.
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
- `high`: 3–4 happy + 4–6 edge.
- `max`: 3–5 happy + 7–10 edge, covering every endpoint and screen the PR diffs change.
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
Never post the full JSON to the thread.

```json
{ "key":"PROJ-123","qaLevel":"max",
  "env":{"profile":"acme-env:staging-qa","versionStart":"...","versionEnd":"..."},
  "deployConfirm":{"version":"...","state":"live","provenance":"..."},
  "cases":[{"id":"QA-1","type":"happy|edge","desc":"...","severity":"P0|P1|P2|P3","status":"pass|fail|blocked|partial",
    "auth":{"accountRef":"..."},"steps":["..."],"expected":"...","actual":"...",
    "evidence":{"reqResp":{"method":"POST","url":"https://app.example.com/api/...","reqBody":"...","status":200,"respRaw":"<full json>"},
      "shot":"/srv/qa-state/shots/PROJ-123-QA-1.png"}}],
  "verdict":"pass|deploy_fail|blocked|partial","reason":"...",
  "statusTransition":{"from":"<state ID>","to":"<state ID>","transitionId":"...","performed":false,"verified":false,"reason":"..."},
  "trackerComment":"<commentId>|null","dmSent":false }
```

- `statusTransition` is always present, in the JSON and in the comment. `from` / `to` are tracker state IDs (not names); `to` is the target even when `performed=false`, or `null` when there is none.
- `trackerComment` is the confirmed comment ID. If the comment could not be confirmed, it is `null` and `reason` is `reconcile-failed`. The caller treats that issue as open.

## Hard rules

1. QA only what is deployed; otherwise `blocked` / `not-deployed`.
2. No evidence → no pass.
3. Done only with `transition=done` + every `doneConditions` entry + an unchanged version. Everything else is comment-only.
4. Record on the original tracker issue. Return the JSON path and the one-line summary.
5. No deploys, merges, reverts or lock handling.
