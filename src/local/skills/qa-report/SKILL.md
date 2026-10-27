---
name: qa-report
description: "Use when per-issue QA results (JSON from the `qa-issue` skill) must become the evidence report a reviewer can verify without asking: one self-contained interactive HTML (issue list ↔ per-case request/response and screenshots, all embedded) plus a PNG preview. Called by `deploy-qa` at its report step, or standalone. Args — <report-input.json> (required; qa-issue JSON array + per-key links + keys handled without QA); shots=<screenshots dir> (the profile's screenshots directory; required to embed screenshots); optional title=<text>."
argument-hint: <report-input.json> shots=<dir> [title=<text>]
---

# qa-report — evidence-first QA report

Turn QA results into one HTML file that lets a reviewer re-run every case from the right pane alone, plus a PNG preview. Evidence is embedded (base64 screenshots, raw responses), so the file still works when every server link is dead. The HTML is the artifact; the PNG previews the first non-pass key.

Files: [`template.html`](./template.html) holds the layout. The left pane has title, request, KPIs, one row per key, body mentions and excluded PRs; the right pane (sticky) shows the selected key's case blocks. [`scripts/build.mjs`](./scripts/build.mjs) fills the template, and [`scripts/mask.mjs`](./scripts/mask.mjs) is the shared secret masker. The PNG uses the `local:html` skill's renderer. Do not run its design pipeline (ui-ux, design, Lottie) — this is an evidence document and the template is its contract.

## Input

`<report-input.json>` — one object:

```json
{ "meta": { "title": "…", "ssot": "<requester's instruction, verbatim>", "repo": "acme/app", "target": "<branch>",
            "range": "<before7>..<after7>", "status": "QA complete | deployed, QA incomplete: <reason>",
            "versionStart": "…", "versionEnd": "…", "generatedAt": "<ISO time>",
            "notes": ["provenance rule used", "negative-proof notes"], "repoAbbr": { "acme/app": "app" } },
  "issues": [ "<qa-issue JSON, exactly as returned>" ],
  "links": { "PROJ-123": { "issue": "https://tracker.example.com/browse/PROJ-123",
                           "prs": [{ "repo": "acme/app", "number": 42, "url": "optional" }],
                           "commits": [{ "repo": "acme/app", "sha": "<merge commit>", "url": "optional" }] } },
  "nonQa": [{ "key": "PROJ-124", "status": "pass|deferred|not-run|report-only|blocked", "reason": "already passed | open PR | …" }],
  "outcomes": { "PROJ-123": { "outcome": "pass|fail|blocked|partial|deferred|not-run|report-only", "reason": "…" } },
  "bodyMentions": [{ "key": "PROJ-125", "pr": { "repo": "acme/app", "number": 43 } }],
  "excludedPrs": [{ "repo": "acme/app", "number": 44, "reason": "deploy head" }] }
```

- `issues[]` is read field by field from the `qa-issue` return schema: `verdict`, `reason`, `qaLevel`, `env.{profile,versionStart,versionEnd}`, `deployConfirm.{version,state,provenance}`, `statusTransition`, `trackerComment`, `dmSent`, and per case `id`, `type`, `desc`, `severity`, `status`, `auth.accountRef`, `steps`, `expected`, `actual`, `evidence.reqResp.{method,url,reqBody,status,respRaw}` (one call or an array of calls), and `evidence.shot` (a file path). Pass the JSON through unchanged and never edit a verdict or a case.
- Row status: `outcomes` is the caller's closeout (deploy-qa writes it for every key). When a key has an outcome, its row status, colour and every count use that outcome and its reason; the raw qa-issue `verdict` and `reason` are shown only as detail.
- Without an outcome (standalone), the status is derived from the qa-issue JSON:
  - `pass` with `statusTransition.to` set and `verified` not `true` → "pass (not moved)", shown as a warning and not counted as pass;
  - `deploy_fail` → fail;
  - `blocked` with a reason starting `superseded:` → superseded;
  - anything else as given; a `nonQa` entry shows its `status`.
- Every key the caller handled appears exactly once, in `issues` or in `nonQa`. The build refuses duplicate keys and outcomes for keys with no row.
- `links` is provenance the caller already holds; `qa-issue` does not return it. Render only what is given. A PR or commit without `url` links to `https://github.com/<owner/repo>/pull|commit/…`. Only `http(s)` links become anchors. An absent link shows "no … link". Never look one up or guess one here.
- Never invent fields. The call line shows each case's endpoint (method + URL), and each row shows its case tally plus `reason`. An empty `auth.accountRef`, `steps`, `expected`, or `actual` renders as `[—]` and counts in the "missing case fields" KPI.

## Steps

Each step is a separate shell call, and shell variables do not carry over between them: paste the paths step 1 prints. Bundled files are reached through `$CLAUDE_PLUGIN_ROOT/skills/<skill>/…`. `$CLAUDE_PLUGIN_ROOT` is two directories above this skill's base directory (`…/skills/qa-report` → `…`); shells usually do not set it, so write the absolute path.

**1. Build the HTML.** `shots` is the calling profile's screenshots directory (`qaEnv`); standalone, use the `shots=` argument:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/qa-report/scripts/build.mjs" --input <report-input.json> \
  --out "$(pwd)/qa-report-<slug>-<YYYYMMDD-HHMMSS>.html" --shots <screenshots dir> [--title "<text>"]
```

It prints one JSON line: `html`, `png` (the path to render to), `keys`, `pass`, `fail`, `other`, `missingFields`, `masked`, `shots`, `shotProblems`. A non-zero exit means bad input (the message says which). Fix the input; never hand-write the HTML instead.

**2. Render the PNG** with the `html` and `png` paths from step 1. In the same call, run the `local:html` Step 6 validation block with `PNG=<png from step 1>`. Allow one retry on a transient render error. A PNG that cannot be rendered never fails the report: if the retry also fails (the headless browser cannot start, the render exits non-zero, or the validation fails), keep the HTML, which stands alone, and return `png=none png-error=<one-line reason>` in step 3:

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/html/renderer/render.mjs" --input <html from step 1> --output <png from step 1> --width 1440 --height 1200 --full-page
```

**3. Return one line**, with every count copied from step 1's output (never counted by eye):
`qa-report: html=<abs> png=<abs> keys=<n> pass=<n> fail=<n> other=<n> missing-fields=<n> masked=<n> shot-problems=<n>`
(`png=none png-error=<one-line reason>` when step 2 could not render it; the caller then uploads the HTML alone and says the PNG was not rendered.)
When a skill called qa-report, stop here. Serving and posting (the calling thread, then the summary channel when the profile's `report` names one) belong to the caller and its profile's `report`, so qa-report never posts in that case and nothing is posted twice. A served link is not required: uploading the HTML and PNG to the thread with the session's Slack file tool (e.g. slack-mcp `send_file` / `send_media`) is an equal alternative. Standalone only: upload the PNG and then the HTML to the current thread as in `local:html` Step 8 (without a PNG, the HTML alone plus `PNG not rendered: <reason>`). Without Slack tools, print the paths.

## Shared masker

`node "$CLAUDE_PLUGIN_ROOT/skills/qa-report/scripts/mask.mjs" < in > out` reads JSON or plain text on stdin and writes the same format to stdout, with secrets replaced by `***`. The count goes to stderr, and the exit code is 2 when stdin is unreadable or not UTF-8. `qa-issue` runs every tracker comment and its returned JSON through it before writing them. `build.mjs` imports the same `mask()` function. It masks:

- the value of a sensitive key (authorization, cookie, csrf/xsrf, password, secret, token, api/access/private key, session id, credential, signature), whatever its type, including JSON serialized inside strings and JSON embedded in plain text (fenced, quoted, or comment-prefixed). When a fragment does not parse, the value after a quoted sensitive key is still masked (fail closed);
- `Authorization`, `Cookie`, `Set-Cookie` and token-like `X-…` header lines, plus Bearer/Basic credentials (only token-like values; prose such as "Basic authentication" is left alone);
- query and form parameters named `…token|key|secret|sig|passw…`;
- JWT-shaped strings.

Unmasked bytes stay exact, and masking twice changes nothing.

## Evidence rules (this skill owns them)

1. No evidence, no PASS. A `pass` case with neither a call nor a screenshot is flagged "pass without evidence". The report does not fix it: send it back to `qa-issue`.
2. Backend proof is the raw request plus the full response body of a real call. For a huge list, use the first item plus the total count, and the case says so. Bodies are re-indented for reading; their bytes are never re-parsed.
3. Front-end proof is a screenshot of the real render. A bundle or source grep never counts.
4. Every key links to its tracker issue. Every row and panel header shows its commit and PR links.
5. Each QA'd key shows the environment version at QA start and end, and a change is flagged.
6. Negative proof: when a case is blocked or partial because of empty data or a login gate, the empty response, 401, or gate screenshot is the evidence shown. It is never a PASS.
7. Never fabricate evidence, links, or fields. Missing stays visibly missing.
8. The report is self-contained. All evidence is embedded and the page loads nothing from any host.
9. Images: a screenshot is embedded only from inside the screenshots directory and only with PNG/JPEG/WebP magic bytes. Anything else shows its rejection reason instead.
10. Secrets: masked as above. That is the only change made to evidence text, and the KPI shows the count. Accounts appear as references only, never as credentials.

## Do not

- Do not write hosts, accounts, or channels into this skill or its files. They come from the caller's profile.
- Do not truncate or summarize response bodies beyond rule 2, and do not reorder the caller's keys.
- Do not drop keys that have no cases (deferred, not-run, report-only, already passed). Each one is a row with its reason.
