import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Contract for the post-deploy QA skills when they run inside the deploy
 * session itself, which may be sandboxed (writes only under the user's tmp
 * directory, network = dev-domain allowlist).
 *
 *  - In such a session the `gh` CLI's network calls fail TLS verification, and
 *    the tool policy denies `gh auth token` to everyone (devops-secret-guard).
 *    So every GitHub read goes through the devops-tools `gh_read` tool, which
 *    runs gh through a broker outside the sandbox and never hands out a token.
 *  - gh_read reports a failed gh as a normal result with a non-zero
 *    `exitCode`, so the skills define what counts as an answer.
 *  - The preflight answers `partial: <checks>` when only the adapter and/or
 *    lockDir checks fail, and the run then QA's in a defined reduced mode
 *    instead of not running at all.
 *  - Re-run arguments are a maintainer reference, never the requester's step.
 */

const SKILLS_DIR = resolve(__dirname, '..', '..');
const read = (skill: string) => readFileSync(resolve(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');

const GITHUB_READ =
  '{"account": "<account>", "args": ["api", "-X", "GET", "<path>", "-f", "<key>=<value>", "--jq", "<filter>"]}';

describe('post-deploy QA skills read GitHub through devops-tools gh_read', () => {
  for (const skill of ['deploy-qa', 'qa-issue', 'qa-report']) {
    it(`${skill} uses no gh network command and no token`, () => {
      const md = read(skill);
      for (const cmd of [
        'gh api repos/',
        'gh api --paginate',
        'gh pr list',
        'gh repo view',
        'gh run watch',
        'gh search',
        'api.github.com',
        'curl -',
        '$(gh auth token)',
      ]) {
        expect(md, `${skill}: ${cmd}`).not.toContain(cmd);
      }
      // `gh auth token` is denied by the tool policy: it may appear only in a "never" sentence.
      for (const line of md.split('\n').filter((l) => l.includes('gh auth token'))) {
        expect(line, `${skill}: ${line}`).toContain('never use `gh auth token`');
      }
    });
  }

  for (const skill of ['deploy-qa', 'qa-issue']) {
    it(`${skill} defines the GitHub read, what counts as an answer, and how to page`, () => {
      const md = read(skill);
      const section = md.slice(md.indexOf('## GitHub reads'), md.indexOf('\n## ', md.indexOf('## GitHub reads') + 1));
      expect(section).toContain('`mcp__devops-tools__gh_read`');
      expect(section).toContain(GITHUB_READ);
      expect(section).toContain('`-X GET` keeps the call a read and turns the `-f` pairs into the query string');
      // A branch name holds a `/`, which the gh_read classifier refuses inside a `?query`.
      expect(section).toContain('never after a `?` in the path, so a value may hold a `/`');
      expect(section).toContain('Never percent-encode anything');
      expect(section).toContain('one array element per word, with no shell quotes');
      // gh_read returns a failed gh as a result, not a tool error.
      expect(section).toContain(
        'An answer is a result whose `exitCode` is 0 and whose `truncated` and `timedOut` are false',
      );
      // The account: the profile's when named, else the single member-class account; else missing: github.
      expect(section).toContain("the profile's `github.account` when it names one");
      expect(section).toContain('`mcp__devops-tools__list` once and use the single account of class `member`');
      expect(section).toContain('`missing: github`');
      // Hosts without the broker: gh in Bash only outside a sandbox.
      expect(section).toContain('run `gh` in Bash with the same args when the session is not sandboxed');
      expect(section).toContain('`"-f", "per_page=100", "-f", "page=<N>"`');
      // A failed read or paging that did not reach the end is incomplete, never empty.
      expect(section).toContain('never read it as empty or complete');
      // compare only with full SHAs (the classifier allows exactly compare/<sha>...<sha>).
      expect(section).toContain('`compare` takes full 40-character SHAs only');
      // No query string is written into a path anywhere in the skill.
      expect(md).not.toMatch(/`repos\/[^`\s]*\?[^`\s]*`/);
    });
  }

  // env-access WU5 (#1213): the environment's own reader comes first; the broker stays only until #1214.
  for (const skill of ['deploy-qa', 'qa-issue']) {
    it(`${skill} reads through the environment's server-tools gh_read when the profile names github.server`, () => {
      const md = read(skill);
      const section = md.slice(md.indexOf('## GitHub reads'), md.indexOf('\n## ', md.indexOf('## GitHub reads') + 1));
      // review-of-legends R5 (tests): both readers are named, so the order check cannot pass on a missing one.
      expect(section).toContain('`mcp__server-tools__gh_read`');
      expect(section).toContain('`mcp__devops-tools__gh_read`');
      expect(section.indexOf('`mcp__server-tools__gh_read`')).toBeLessThan(
        section.indexOf('`mcp__devops-tools__gh_read`'),
      );
      expect(section).toContain('When the profile names `github.server`');
      expect(section).toContain('`{"server": "<github.server>", "path": "<path>", "query": {"<key>": "<value>"}}`');
      // review-of-legends R5: the server keeps only the filter's fields, before the output cap.
      expect(section).toContain("put the fields the read's `--jq` filter uses in `fields`");
      expect(section).toContain('`"fields": ["total_commits", "commits[].sha", "commits[].parents[].sha"]`');
      expect(section).toContain('A truncated answer is asked again, at most twice');
      expect(section).toContain('a moved answer (3xx, never followed)');
      // trinity R5 (fable): a read with no answer is asked once more.
      expect(section).toContain('A read that got no answer (a timeout or a lost connection) is asked once more.');
      expect(section).toContain('An answer there is a result whose `truncated` is false');
      expect(section).toContain('A repository or path it refuses is `missing: github`');
      // review-of-legends R6 / trinity R6 (astra): a commit by SHA is read only when it is on the read refs.
      expect(section).toContain("is read only when it is on one of the environment's `github.readRefs`");
      expect(section).toContain("read an open PR's changes by its number (`pulls/<n>/files`, `pulls/<n>/commits`)");
      // trinity R1 (astra): a smaller page size restarts the listing and ends it at that size, not at 100.
      expect(section).toContain('restarting that listing at page 1');
      expect(section).toContain('a page holding fewer items than that `per_page` — not 100 — ends the listing');
      expect(section).toContain(
        'Without `github.server`, read through the broker as below until it is removed (#1214)',
      );
      expect(md).toContain('`github.server`');
    });
  }

  it('qa-issue logs in through server-tools login when the profile maps the role, never typing the token', () => {
    const md = read('qa-issue');
    expect(md).toContain('`qaEnv.logins.<role>` = `{"server": …, "account": …}`');
    expect(md).toContain('get the session with `mcp__server-tools__login`');
    // review-of-legends R5/R6: the session file is the owner's alone before the session is written into it.
    // trinity R6 (fable): the Write tool cannot overwrite a file it has not read, so the directory is made private.
    expect(md).toContain(
      "inside a directory that is the owner's alone before the session is in it (create `<run directory>/session` with `install -d -m 700`",
    );
    // review-of-legends R6: a browser case gets the session, logs in through the form, or is blocked — never logged out.
    expect(md).toContain(
      "a cookie the profile's browser primitive loads from the file before the role's first browser case",
    );
    expect(md).toContain('are reported blocked (`no browser session`); a case never runs logged out');
    expect(md).toContain('Never type the token into a command line, `eval` source, `steps`, a report');
    expect(md).toContain('Optional: `qaEnv.logins`');
  });

  it('deploy-qa keeps only merged PRs from the closed listing', () => {
    expect(read('deploy-qa')).toContain(
      '`repos/<owner/repo>/pulls` with `"-f", "state=closed", "-f", "base=<integrationBranch>"`, keeping only PRs with `merged_at` set',
    );
  });

  it('deploy-qa preflight reads the repo through gh_read and names a failure `github`', () => {
    const md = read('deploy-qa');
    expect(md).toContain(
      'a GitHub read of `repos/<owner/repo>` (filter `.full_name`) that answers with that repo, for every repo',
    );
    expect(md).toContain('the GitHub checks are named `github`');
    // github.account is optional: its absence is never a missing: answer by itself.
    expect(md).toContain('Optional: `github.account`');
  });
});

describe('deploy-qa preflight and reduced mode', () => {
  const md = read('deploy-qa');

  it('advertises the partial answer in its Args and preflight', () => {
    expect(md).toContain(
      '`--preflight`: readiness check, see below. No writes. Replies with one of applies / partial: <checks> / not-applicable / missing: <fields>.',
    );
    expect(md).toMatch(/Only adapter, screenshots-directory, and\/or `lockDir` checks fail → `partial: <checks>`/);
    // lockDir and the screenshots directory may not exist yet: creating them is the test.
    expect(md).toContain(
      '`lockDir` is a writable directory, or does not exist yet and its parent allows creating it (test with `mkdir -p`, then create and remove one probe file in it — a sandbox can refuse the write even when the permissions allow it)',
    );
    expect(md).toMatch(/screenshots directory \(`qaEnv\.screenshotsDir`\) is writable the same way/);
    expect(md).toMatch(/Any GitHub, tracker, or bundled-file check fails → `missing: <checks>`/);
  });

  it('answers --confirm with step 1 only, in one line, writing nothing', () => {
    expect(md).toContain('[--confirm]');
    const args = md.slice(md.indexOf('## Args'), md.indexOf('## Profile'));
    expect(args).toContain('`--confirm`: run the deploy confirmation of step 1 only');
    expect(args).toContain('write nothing');
    expect(args).toContain('`confirmed`, `unconfirmed: <reason>`, or `failed: <run> concluded <conclusion>`');
    // A full run still re-checks; a confirmed deploy normally passes without waiting if the evidence still holds.
    const step1 = md.slice(md.indexOf('1. **Confirm the deploy**'), md.indexOf('2. **Commits.**'));
    expect(step1).toContain(
      'A full run re-checks here; a deploy that `--confirm` already confirmed normally passes without waiting, if the current evidence still shows it deployed.',
    );
  });

  it('owns the deploy confirmation for its repo, within a fixed budget, with no event filter', () => {
    const step1 = md.slice(md.indexOf('1. **Confirm the deploy**'), md.indexOf('2. **Commits.**'));
    expect(step1).toContain('the deploy workflow does not confirm a repo with QA itself');
    expect(md).not.toContain('event=push');
    expect(step1).toContain(
      'actions/workflows/<CD workflow>/runs` with `"-f", "head_sha=<after>", "-f", "branch=<target>"` (paged)',
    );
    // A run not registered yet is pending, never "no CD".
    expect(step1).toContain(
      'An empty listing within the budget means the run is not registered yet: pending, never "no CD"',
    );
    expect(step1).toContain('`deploy failed, QA not run: <run> concluded <conclusion>`');
    expect(step1).toContain('When `deploy` names a CD workflow for `repo` and `target`');
    expect(step1).toContain('When `deploy` declares no CD workflow');
    expect(step1).toContain('every 30 s for at most 30 min');
    expect(step1).toContain('`deployed, QA incomplete: deploy not confirmed in time`');
  });

  it('gives the no-lock run a report input qa-report accepts', () => {
    const section = md.slice(md.indexOf('## Reduced mode'), md.indexOf('## Excluded PRs'));
    expect(section).toContain('`issues: []`');
    expect(section).toMatch(/`nonQa`[^\n]*`\{key, status: "not-run", reason: "QA lock unavailable"\}`/);
    expect(section).toContain('no `jq -s` over `R/<KEY>.json`');
  });

  it('defines what a reduced run does', () => {
    const section = md.slice(md.indexOf('## Reduced mode'), md.indexOf('## Excluded PRs'));
    expect(section).toContain('take no lock and QA no issue');
    expect(section).toContain('`deployed, QA incomplete: QA lock unavailable`');
    expect(section).toContain('`qa=high`');
    // Reduced mode never grants the done transition.
    expect(section).toContain('without `transition=done`');
    expect(section).not.toMatch(/qa=high[^\n]*transition=done mergeShas/);
    expect(section).toContain('never pass it while the browser adapter is missing');
    expect(section).toContain('reason `<adapter> unavailable`');
  });

  it('never hands the re-run to the requester', () => {
    expect(md).toContain('on one reference line for maintainers');
    expect(md).toContain('Never phrase the re-run as something the requester should do.');
    expect(md).not.toContain('suggest a re-run');
  });

  it('publishes the HTML report alone — never a PNG of it (one report, one artifact; SSOT 2026-11-09)', () => {
    expect(md).toContain('Never a PNG of the report');
    expect(md).not.toMatch(/HTML and PNG|HTML \+ PNG|PNG not rendered/);
    const report = read('qa-report');
    expect(report).not.toMatch(/Render the PNG|png=<abs>|png=none|PNG preview\./);
    expect(report).toContain('no PNG preview');
    expect(report).toContain('the HTML alone, never a PNG of it');
  });

  it('publishes to the calling thread, the summary channel only when the profile names one', () => {
    expect(md).toContain('Then the summary channel, only when `report` names one.');
    expect(md).toMatch(/slack-mcp `send_file`\) is a valid `report` method/);
  });
});

/**
 * A run that cannot QA (the lock stayed busy past its wait, or `lockDir` is not
 * writable) used to end touching nothing, so its keys carried no label and the
 * next deploy's range never included them: they were never QA'd. Such a run now
 * reads steps 1–5 and carries every key a full run's step 8 would leave open,
 * add-only. The lock holder's step 8 owns removal, and keeps the label while any
 * carry comment is outstanding: no later pass or fail result names all its merges.
 */
describe('deploy-qa carries every open key when QA cannot run', () => {
  const md = read('deploy-qa');
  const lock = md.slice(md.indexOf('## Lock'), md.indexOf('## Outcomes'));
  const busy = lock.slice(lock.indexOf('- **Busy**'), lock.indexOf('- **Stale**'));
  const reduced = md.slice(md.indexOf('## Reduced mode'), md.indexOf('## Excluded PRs'));
  const lockDirBranch = reduced.slice(
    reduced.indexOf('- **`lockDir` not writable**'),
    reduced.indexOf('- **An adapter missing'),
  );
  const steps = md.slice(md.indexOf('## Steps'), md.indexOf('## Final report'));
  const step8 = steps.slice(steps.indexOf('8. **Carry-over.**'), steps.indexOf('9. **Report.**'));
  const fullStep8 = step8.slice(0, step8.indexOf('- **Without a lock**'));
  const noLock = step8.slice(step8.indexOf('- **Without a lock**'));

  it('busy: still waits, then reads steps 1–5 without QA', () => {
    expect(busy).toContain('re-checking every 5 min for up to 60 min');
    expect(busy).toContain('steps 1–5 read-only');
    expect(busy).toContain('no `qa-issue` call');
    expect(busy).toContain('no tracker transition');
    expect(busy).toMatch(/steps 5\.5–7 do not run/);
  });

  it('busy: carries through step 8 without a lock, reason lock busy', () => {
    expect(busy).toContain('step 8 as a run without a lock, reason `lock busy`');
  });

  it('busy: reports target keys as not-run and still ends lock busy with the re-run args', () => {
    expect(busy).toMatch(/not-run[^\n]*reason `lock busy`/);
    expect(busy).toContain('`deployed, QA incomplete: lock busy`');
    expect(busy).toContain('re-run args');
  });

  it('lockDir not writable: carries too, still with no QA, no transition, no heartbeat', () => {
    expect(lockDirBranch).not.toContain('no carry-over write');
    expect(lockDirBranch).toContain('no `qa-issue` call, no tracker transition, no heartbeat');
    expect(lockDirBranch).toContain('step 8 as a run without a lock, reason `QA lock unavailable`');
    expect(lockDirBranch).toContain('tracker writes need no lock directory');
  });

  it('a run without a lock carries every key step 8 would leave open', () => {
    expect(step8).toContain('- **Without a lock** (Reduced mode for `lockDir`, or a lock that stayed busy)');
    expect(noLock).toContain('each admitted target key');
    expect(noLock).toContain('each key admission deferred');
    expect(noLock).toContain('blocked `PR list incomplete`');
    expect(noLock).toContain('`carryLabel`');
    expect(noLock).toContain('the carry comment above');
    // Hard rules: touch only a range whose deploy step 1 confirmed.
    expect(noLock).toContain('only after step 1 confirmed the deploy');
  });

  it('a run without a lock comments whenever its mergeShas are new, and before it labels', () => {
    // The holder's check reads every carry comment's mergeShas, so a new merge always gets a comment.
    expect(noLock).toContain('no new comment only when both its reason and its `mergeShas`');
    // Comment first: the holder either sees it and keeps the label, or removed the label before it is added.
    expect(noLock).toMatch(/post the comment before adding the label/i);
  });

  it('a run without a lock never removes a carry label', () => {
    const removes = noLock.match(/\S+ remove\b/gi) ?? [];
    expect(removes.length).toBeGreaterThan(0);
    for (const r of removes) expect(r).toMatch(/^never remove$/i);
    expect(noLock).toContain('Never remove `carryLabel`');
    expect(noLock).toContain("removal stays with the lock holder's step 8");
  });

  // The guard sentence: from "Pass and fail:" to the report-only rule.
  const guard = fullStep8.slice(fullStep8.indexOf('Pass and fail:'), fullStep8.indexOf('Report-only:'));

  it('a carry comment stays outstanding until a later result names every one of its merges', () => {
    expect(guard).toContain('**outstanding**');
    expect(guard).toMatch(
      /no pass or fail result comment posted after it \(this run's own result included\) names every one of its mergeShas as tested/,
    );
    // Coverage, not time: no boundary that an earlier, narrower result could set.
    expect(guard).not.toContain('startTime');
    expect(guard).not.toContain('newest carry comment');
    expect(guard).not.toContain('latest pass or fail result comment');
    expect(guard).not.toContain('never the boundary');
  });

  it('this run counts as later than every carry comment it reads, so an earlier pass never pins the label', () => {
    expect(guard).toContain('`mergeShas` its run passed to `qa-issue`');
    expect(guard).toContain('for an already passed key, the pass comment that names its mergeShas');
    expect(guard).toContain('counts as posted after every carry comment this run reads');
  });

  it('the holder keeps the label while any carry comment is outstanding, otherwise removes it', () => {
    expect(guard).toContain('Keep `carryLabel` while any carry comment on the key is outstanding');
    expect(guard).toContain('`<KEY>: carry label kept, merge <owner/repo:sha7>');
    expect(guard).toMatch(/Otherwise remove it/);
  });

  it('after removing, the holder checks every carry comment newer than its first read', () => {
    // Two no-lock runs can post B then A between the read and the removal; the newest alone (A) hides B.
    expect(guard).toContain('every carry comment newer than that first read');
    expect(guard).toMatch(
      /every carry comment newer than that first read[^\n]*if one is outstanding, add the label back[^\n]*same summary line/,
    );
  });

  it('a run without a lock has nothing to resume and its repeated carry adds nothing', () => {
    const cont = md.slice(md.indexOf('## Continuation'), md.indexOf('## Hard rules'));
    expect(cont).toContain('or a lock that stayed busy');
    expect(cont).toContain('a repeated carry adds nothing');
  });
});

/**
 * Precondition gate across the whole run (2026-10-30 stage0 qa=max: 49 of 69
 * non-pass cases were preconditions found only while running). deploy-qa plans
 * every key first, asks the requester one question, and runs nothing before the
 * answer — holding no lock while it waits.
 */
describe('deploy-qa precondition gate (step 5.5)', () => {
  const md = read('deploy-qa');
  const steps = md.slice(md.indexOf('## Steps'), md.indexOf('## Final report'));
  const gate = steps.slice(steps.indexOf('5.5. **Precondition gate.**'), steps.indexOf('6. **Move to QA.**'));

  it('sits between admission and the first tracker write', () => {
    expect(steps.indexOf('5. **Admission.**')).toBeGreaterThan(-1);
    expect(steps.indexOf('5.5. **Precondition gate.**')).toBeGreaterThan(steps.indexOf('5. **Admission.**'));
    expect(steps.indexOf('6. **Move to QA.**')).toBeGreaterThan(steps.indexOf('5.5. **Precondition gate.**'));
  });

  it('plans every target key with qa-issue --plan and merges one run gate', () => {
    expect(gate).toMatch(/`\$local:qa-issue <KEY> qa=max env=<profile skill> --plan[^`]*`/);
    expect(gate).toContain('`<lockDir>/gates/<owner/repo with / → ->-<after7>-<startTime>.json`');
    expect(gate).toContain('gate.mjs" merge');
    expect(gate).toContain('one question for the whole run');
  });

  it('releases the lock before asking and ends waiting, not failed', () => {
    expect(gate).toContain('release the lock only if it is mine, then ask');
    expect(gate).toContain('`deployed, QA incomplete: waiting for precondition confirmation`');
    expect(gate).toContain('No case runs and no tracker write happens before the answer');
    expect(gate).toContain('creates no scheduler, cron job, or listener');
  });

  it('resumes only with decisions= and re-asks for anything unanswered or changed', () => {
    const args = md.slice(md.indexOf('## Args'), md.indexOf('## Profile'));
    expect(args).toContain('`decisions=<gate file>`');
    expect(gate).toContain('gate.mjs" decide');
    expect(gate).toContain('--carry');
    expect(md).toMatch(
      /`\$local:qa-issue <KEY> qa=max env=<profile skill> transition=done mergeShas=[^`]*decisions=<gate file>[^`]*`/,
    );
  });

  it('can be resumed directly when the environment wrapper does not forward decisions= (#591)', () => {
    const args = md.slice(md.indexOf('## Args'), md.indexOf('## Profile'));
    expect(args).toMatch(
      /does not accept `decisions=`[^\n]*invoke this skill directly[^\n]*`env=<the profile skill the gate file names>`/,
    );
    // The direct call never skips the env-skill admin gate, and never widens the run's scope.
    expect(args).toMatch(/does not accept `decisions=`[^\n]*`--preflight`[^\n]*`applies` or `partial: …`/);
    expect(args).toMatch(/does not accept `decisions=`[^\n]*`keys=`/);
  });

  it('maps a skipped key to deferred and lists the gate first in the report input', () => {
    expect(md).toContain('`deferred`, reason `precondition-skipped by <who>`');
    expect(steps).toContain('`preconditions`');
  });

  it('preflight checks the bundled gate script', () => {
    expect(md).toContain('`…/qa-issue/scripts/gate.mjs`');
  });
});

/**
 * `$autoz` deploys are sent by an automation, so nobody answers the step 5.5
 * question: 28 gates sat pending for days with zero QA cases run (2026-11-03).
 * The owner's call: a `$autoz` deploy request counts as "proceed without" —
 * every open precondition is waived inside the same run, no question is posted,
 * and the run never ends waiting. QA itself is not skipped or reduced.
 */
describe('deploy-qa $autoz waiver (waive=autoz)', () => {
  const md = read('deploy-qa');
  const args = md.slice(md.indexOf('## Args'), md.indexOf('## Profile'));
  const steps = md.slice(md.indexOf('## Steps'), md.indexOf('## Final report'));
  const gate = steps.slice(steps.indexOf('5.5. **Precondition gate.**'), steps.indexOf('6. **Move to QA.**'));
  const step7 = steps.slice(steps.indexOf('7. **QA, one issue at a time**'), steps.indexOf('8. **Carry-over.**'));
  const final = md.slice(md.indexOf('## Final report'), md.indexOf('## Continuation'));

  it('advertises waive=autoz in its argument hint and Args (the description says only when)', () => {
    const description = md.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toMatch(/^Use when /);
    expect(description).not.toContain('waive=');
    expect(md).toMatch(/^argument-hint: "[^"]*\[waive=autoz\][^"]*"$/m);
    expect(args).toContain('`waive=autoz`');
    // The request is the requester's answer; QA is never skipped or reduced by it.
    expect(args).toMatch(/`waive=autoz`[^\n]*carries `\$autoz`[^\n]*requester's answer/);
    expect(args).toMatch(/`waive=autoz`[^\n]*never skips or reduces QA/);
  });

  it('never depends on the environment wrapper forwarding waive= (the #608 bypass, reused)', () => {
    const line = args.split('\n').find((l) => l.startsWith('- `waive=autoz`')) ?? '';
    expect(line).toContain('passes it through unchanged');
    // Same argument list as deploy.prompt item 6 (prompt-builder.test.ts pins it there): the scope never widens.
    expect(line).toContain(
      'invoke this skill directly with the same `repo`, `target`, `before`, `after` and `keys=` (if the run had one), `env=',
    );
    expect(line).toMatch(/does not accept `waive=`[^\n]*`--preflight`[^\n]*`applies` or `partial: …`/);
    expect(line).toMatch(
      /does not accept `waive=`[^\n]*invoke this skill directly[^\n]*`env=[^`]*`[^\n]*`waive=autoz`/,
    );
  });

  it('waives every open precondition inside the same run, keeps the lock and goes on to step 6', () => {
    expect(gate).toContain('`waive=autoz`');
    // The ask bullet names its exception first, so a top-down reader never asks before reading it.
    expect(gate).toContain(
      '- `ask: true` → (without `waive=autoz`; with it, the next bullet applies) post the gap table',
    );
    expect(gate.indexOf('- **`waive=autoz`**')).toBeGreaterThan(gate.indexOf('- `ask: true` →'));
    expect(gate).toContain(
      '`node "…/gate.mjs" answer --gate <G> --key all --decision waived --by <the requester> --ref <the deploy request\'s message ts>`',
    );
    expect(gate).toContain('keep the lock');
    // decide needs {env, inputs, statuses}: the key's plan in G, probed in this run, supplies all three.
    // The same program is run against a real gate in qa-issue-gate.test.ts.
    expect(gate).toContain(
      "`jq --arg k <KEY> '.keys[$k] | {env, inputs, statuses: ([.preconditions[] | {(.id): .status}] | add // {})}' <G> > R/current-<KEY>.json`",
    );
    expect(gate).toContain('`node "…/gate.mjs" decide --gate <G> --key <KEY> --current R/current-<KEY>.json`');
    expect(gate).toMatch(/`run` → step 6 with `decisions=<G>`/);
    expect(gate).toContain('Never post the question with `waive=autoz`');
    // The marker is prose only — a literal `$autoz` inside a shell argument expands to nothing.
    for (const l of gate.split('\n').filter((x) => x.includes('gate.mjs'))) {
      for (const cmd of l.match(/`node [^`]*`/g) ?? []) expect(cmd).not.toContain('$autoz');
    }
    expect(gate).toContain('`waived by $autoz`');
  });

  it('leaves the ask path without the waiver exactly as it was', () => {
    expect(gate).toContain(
      "Then release the lock only if it is mine, then ask the requester with the session's question tool (`local:UIAskUserQuestion`, one choice group: per key provide it / proceed without it / skip the key). End `deployed, QA incomplete: waiting for precondition confirmation`, with the reference line plus `decisions=<G>`.",
    );
    expect(args).toContain('A reply from anyone other than the requester is not an answer.');
  });

  it('a gate raised again in step 7 is waived too, at most once, and the run never ends waiting', () => {
    expect(step7).toMatch(/With `waive=autoz`[^\n]*once more[^\n]*`not-run`, reason `inputs changed during QA`/);
    expect(final).toMatch(
      /`waive=autoz`[^\n]*never ends `deployed, QA incomplete: waiting for precondition confirmation`/,
    );
    expect(final).toContain('`waived by $autoz`');
  });
});

/**
 * `compare` gets through gh_read only when the broker's installed classifier allows it (#998), and the broker is
 * installed apart from this plugin: a host whose broker predates that rule refuses every compare `policy-denied`
 * (2026-11-06). #1015 then computed the answer with git in a scratch clone, which never runs in a sandboxed deploy
 * session: `git init` cannot write `.git/hooks` or `.git/config` there, and `github.com` is not on the sandbox's
 * domain list. A real deploy session (2026-11-09) walked the commits list through gh_read instead, and that list is
 * now the one documented fallback.
 */
const LIST_READ =
  '`repos/<owner/repo>/commits` with `"-f", "sha=<sha>", "-f", "per_page=100", "-f", "page=<N>"` and the filter `[.[] | {sha, parents: [.parents[].sha]}]`';

describe('deploy-qa computes a refused compare from the commits list', () => {
  const md = read('deploy-qa');
  const github = md.slice(md.indexOf('## GitHub reads'), md.indexOf('## Args'));
  const steps = md.slice(md.indexOf('## Steps'), md.indexOf('## Final report'));
  const step1 = steps.slice(steps.indexOf('1. **Confirm the deploy**'), steps.indexOf('2. **Commits.**'));
  const step2 = steps.slice(steps.indexOf('2. **Commits.**'), steps.indexOf('3. **PRs.**'));
  const step5 = steps.slice(steps.indexOf('5. **Admission.**'), steps.indexOf('5.5. **Precondition gate.**'));

  it('keeps gh_read first and falls back to the commits list when the compare read is refused or fails', () => {
    expect(github).toContain('Read `compare` with `gh_read` first.');
    expect(github).toMatch(/not an answer[^\n]*`policy-denied`[^\n]*answer from the commits list instead/);
    // The classifier rules above stay as they were.
    expect(github).toContain('`compare` takes full 40-character SHAs only');
    expect(github).toContain(LIST_READ);
  });

  it('bounds the walk and never reads a missing answer as a pass or as "not contained"', () => {
    expect(github).toContain(
      "at most 10 pages of a list (the Range reads one more of `<before>`'s), a page with fewer than 100 commits ends the list, and a page that is not an answer ends the walk with no answer",
    );
    expect(github).toContain("`<base>`'s full SHA appears → contained; not found within 10 pages → no answer");
    expect(github).toContain('No answer is never a pass and never "not contained": the check stays unmet');
  });

  it('strictly ahead excludes the same commit', () => {
    expect(github).toContain('**Strictly ahead** (compare `ahead`): contained and `<base>` ≠ `<head>`.');
  });

  it('a range is complete when it is closed under parents, not when <before> is found', () => {
    expect(github).toContain(
      'read pages 1…n of the list from `<after>` and 1…n+1 of the list from `<before>` (or to its end), n = 1, 2, …, 10',
    );
    expect(github).toContain(
      'The range is complete when every parent of every range commit is in the range or in `B`; until then raise n, and past n = 10 there is no answer',
    );
    expect(github).toContain('A commit with one parent has one SHA in `parents`.');
    // Under skew the range may over-include; only admission's per-key re-checks make that safe.
    expect(github).toContain(
      "Under commit-date skew the range can also hold a commit `<before>` already had: that is safe only because admission (step 5) re-checks each key's tracker state and the containment of its own mergeShas in `runningSha`, and the range alone never shows that anything is deployed.",
    );
  });

  it('names the answer source in the report notes', () => {
    expect(github).toContain("Add `compare via commits list: broker refused compare` to the report's `meta.notes`");
  });

  it('steps 1, 2 and 5 take the list answer, the two SHAs in compare order', () => {
    expect(step1).toContain(
      'answers `ahead` or `identical` — via the commits list, `after` contained in `runningSha` (`after` is `runningSha` or one of its ancestors)',
    );
    expect(step1).toContain(
      '(compare status `ahead`; via the commits list, strictly ahead: `before` contained in `after` and `before` ≠ `after`)',
    );
    expect(step2).toContain('never mix compare pages with list pages');
    expect(step2).toContain(
      "the list's Range `<before>..<after>` stands in for compare's range (a complete candidate set that may also hold older commits, see Range); keep its commits with one SHA in `parents`",
    );
    expect(step2).toContain('A range with no answer ends `deployed, QA incomplete: range listing incomplete` too.');
    expect(step5).toContain('`repos/<owner/repo>/compare/<mergeSha>...<runningSha>`');
    expect(step5).toContain('via the commits list, `mergeSha` contained in `runningSha`');
  });
});

describe('no git recipe remains in the QA skills', () => {
  for (const skill of ['deploy-qa', 'qa-issue']) {
    it(skill, () => {
      const md = read(skill);
      expect(md).not.toMatch(
        /git init|merge-base|rev-list|--filter=blob:none|GIT_TERMINAL_PROMPT|credential\.interactive/,
      );
      expect(md).not.toContain('compare via git');
      expect(md).not.toMatch(/`(?:[A-Z_]+=\S*\s+)*git\s/);
    });
  }
});

/**
 * The Range rule run against real histories. GitHub's commits list comes in `git log`'s default order, newest
 * commit date first (this repo's list matched `git log` on 2026-11-09). A small page size stands in for pages of 100.
 */
describe('the documented range rule against a real history', () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const roots: string[] = [];

  interface Listed {
    sha: string;
    parents: string[];
  }
  /** One page of the commits list, or `failed` for a read that is not an answer. */
  type Pager = (from: string, page: number) => Listed[] | 'failed';

  /** A new repository; `at` pins a commit's dates, so a test can order the list or skew it. */
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-qa-range-'));
    roots.push(root);
    const sha: Record<string, string> = {};
    const git = (args: string[], at?: number) =>
      execFileSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: at === undefined ? env : { ...env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` },
      }).trim();
    git(['init', '-q', '-b', 'main']);
    const commit = (name: string, at: number) => {
      writeFileSync(join(root, `${name}.txt`), name);
      git(['add', `${name}.txt`]);
      git(['commit', '-q', '-m', name], 1_700_000_000 + at);
      sha[name] = git(['rev-parse', 'HEAD']);
    };
    const merge = (name: string, branch: string, at: number, extra: string[] = []) => {
      git(['merge', '-q', '--no-ff', ...extra, '-m', name, branch], 1_700_000_000 + at);
      sha[name] = git(['rev-parse', 'HEAD']);
    };
    /** The commits list from `from`, `size` commits per page, in GitHub's order. */
    const pager =
      (size: number): Pager =>
      (from, page) =>
        git(['log', '--format=%H %P', from])
          .split('\n')
          .slice((page - 1) * size, page * size)
          .map((line) => {
            const [s, ...parents] = line.split(' ').filter(Boolean);
            return { sha: s, parents };
          });
    /**
     * The one-parent commits `after` has and `before` lacks, from both full lists. Not `git rev-list before..after`:
     * that walk stops by commit date, and under the skew below it lists S too.
     */
    const truth = (before: string, after: string) => {
      const all = (from: string) => pager(Number.MAX_SAFE_INTEGER)(from, 1) as Listed[];
      const had = new Set(all(before).map((c) => c.sha));
      return all(after)
        .filter((c) => !had.has(c.sha) && c.parents.length === 1)
        .map((c) => c.sha)
        .sort();
    };
    return { sha, git, commit, merge, pager, truth };
  };

  /**
   * The doc's Range: pages 1…n from `after` and 1…n+1 from `before`, n = 1…10; a short page ends a list, a failed page
   * ends the walk. Complete once every parent of every range commit is in the range or in B. null = no answer.
   */
  const range = (pager: Pager, size: number, before: string, after: string): string[] | null => {
    const read = (from: string, pages: number): Listed[] | null => {
      const listed: Listed[] = [];
      for (let page = 1; page <= pages; page++) {
        const got = pager(from, page);
        if (got === 'failed') return null;
        listed.push(...got);
        if (got.length < size) break;
      }
      return listed;
    };
    for (let n = 1; n <= 10; n++) {
      const fromAfter = read(after, n);
      const fromBefore = read(before, n + 1);
      if (fromAfter === null || fromBefore === null) return null;
      const b = new Set(fromBefore.map((c) => c.sha));
      const r = fromAfter.filter((c) => !b.has(c.sha));
      const inRange = new Set(r.map((c) => c.sha));
      if (r.every((c) => c.parents.every((p) => inRange.has(p) || b.has(p)))) {
        return r
          .filter((c) => c.parents.length === 1)
          .map((c) => c.sha)
          .sort();
      }
    }
    return null;
  };

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /**
   * S1 and S2 branch off B before main moves on to F (`before`), and M (`after`) merges them; U is an unrelated root
   * that M2 merges later. With 3-commit pages `before` is on the first page of M's list and S1, S2 are not.
   */
  describe('a merged branch older than before, and a merged root', () => {
    const h = fixture();
    const { sha } = h;
    beforeAll(() => {
      h.commit('A', 1);
      h.commit('B', 2);
      h.git(['checkout', '-q', '-b', 'side']);
      h.commit('S1', 3);
      h.commit('S2', 4);
      h.git(['checkout', '-q', 'main']);
      h.commit('C', 5);
      h.commit('D', 6);
      h.commit('E', 7);
      h.commit('F', 8);
      h.merge('M', 'side', 9);
      h.git(['checkout', '-q', '--orphan', 'unrelated']);
      h.git(['rm', '-rq', '--cached', '.']);
      h.commit('U', 10);
      h.git(['checkout', '-q', '-f', 'main']);
      h.merge('M2', 'unrelated', 11, ['--allow-unrelated-histories']);
    });

    it("finds compare's one-parent commits, which sit below `before` in the list", () => {
      expect(h.truth(sha.F, sha.M)).toEqual([sha.S1, sha.S2].sort());
      const firstPage = h.pager(3)(sha.M, 1) as Listed[];
      expect(firstPage.map((c) => c.sha)).toContain(sha.F);
      // Stopping at the page that holds `before` (one more page from `before`) keeps only the merge: nothing.
      const b = new Set((h.pager(3)(sha.F, 1) as Listed[]).concat(h.pager(3)(sha.F, 2) as Listed[]).map((c) => c.sha));
      expect(firstPage.filter((c) => !b.has(c.sha) && c.parents.length === 1)).toEqual([]);
      expect(range(h.pager(3), 3, sha.F, sha.M)).toEqual(h.truth(sha.F, sha.M));
      expect(range(h.pager(1), 1, sha.F, sha.M)).toEqual(h.truth(sha.F, sha.M));
    });

    it('a parentless root merged into the range is listed but dropped by the one-parent filter', () => {
      const firstPage = h.pager(3)(sha.M2, 1) as Listed[];
      expect(firstPage).toContainEqual({ sha: sha.U, parents: [] });
      expect(range(h.pager(3), 3, sha.F, sha.M2)).toEqual(h.truth(sha.F, sha.M2));
      expect(range(h.pager(3), 3, sha.F, sha.M2)).not.toContain(sha.U);
    });

    it('a failed page of either list is no answer, never a shorter range', () => {
      const failing =
        (from: string, page: number): Pager =>
        (f, p) =>
          f === from && p === page ? 'failed' : h.pager(1)(f, p);
      // With 1-commit pages the walk needs page 2 of M's list and page 3 of F's.
      expect(range(failing(sha.M, 2), 1, sha.F, sha.M)).toBeNull();
      expect(range(failing(sha.F, 3), 1, sha.F, sha.M)).toBeNull();
    });
  });

  /**
   * Clock skew (review of this change, 2026-11-09): R and S are dated after the commits built on them. `before` = C7
   * reaches S through C1…C7; X branches off S and M (`after`) merges it. M's list shows S and R on its second page,
   * while the three pages read from C7's list stop at C2. S lands in the range and the parents check passes, so the
   * range holds S, a commit `before` already had. That only adds a key to check: admission re-checks each key's tracker
   * state and its own mergeShas against `runningSha`, and the range never confirms a deploy by itself.
   */
  describe('commit-date skew', () => {
    const h = fixture();
    const { sha } = h;
    beforeAll(() => {
      h.commit('R', 100);
      h.commit('S', 99);
      for (let i = 1; i <= 7; i++) h.commit(`C${i}`, i);
      h.git(['checkout', '-q', '-b', 'side', sha.S]);
      h.commit('X', 50);
      h.git(['checkout', '-q', 'main']);
      h.merge('M', 'side', 200);
    });

    it('the range can hold a commit `before` already had, and never misses one compare lists', () => {
      expect(h.truth(sha.C7, sha.M)).toEqual([sha.X]);
      expect((h.pager(2)(sha.M, 2) as Listed[]).map((c) => c.sha)).toEqual([sha.S, sha.R]);
      const got = range(h.pager(2), 2, sha.C7, sha.M);
      expect(got).toEqual([sha.S, sha.X].sort());
      // S is `before`'s ancestor: git exits 0.
      expect(() => h.git(['merge-base', '--is-ancestor', sha.S, sha.C7])).not.toThrow();
      for (const c of h.truth(sha.C7, sha.M)) expect(got).toContain(c);
    });
  });

  it('a range the parents check cannot close within 10 pages is no answer', () => {
    // A branch of 12 one-parent commits on top of `before` (b); the list from b is b alone.
    const chain = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const lists: Record<string, Listed[]> = {
      a0: [...chain.map((s, i) => ({ sha: s, parents: [chain[i + 1] ?? 'b'] })), { sha: 'b', parents: [] }],
      b: [{ sha: 'b', parents: [] }],
    };
    const synthetic =
      (size: number): Pager =>
      (from, page) =>
        lists[from].slice((page - 1) * size, page * size);
    expect(range(synthetic(1), 1, 'b', 'a0')).toBeNull();
    // The same list in 2-commit pages closes at n = 6.
    expect(range(synthetic(2), 2, 'b', 'a0')).toEqual([...chain].sort());
  });
});

describe('deploy-qa checks an MCP-tool adapter by the profile liveness call', () => {
  const md = read('deploy-qa');
  it('preflight names both adapter kinds and opens no page', () => {
    expect(md).toContain(
      "each adapter: `command -v` for an executable, or for an MCP tool the profile's liveness call (tool listed and answering; do not open a page)",
    );
  });
  it('reduced mode covers an MCP tool that is absent or not answering', () => {
    expect(md).toContain('**An adapter missing (executable absent, or MCP tool absent or not answering)');
    expect(md).not.toContain('An adapter executable missing');
  });
});
