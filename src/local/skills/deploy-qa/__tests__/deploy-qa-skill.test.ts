import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('advertises the partial answer in its description and preflight', () => {
    const description = md.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('applies / partial: <checks> / not-applicable / missing: <fields>');
    expect(md).toMatch(/Only adapter, screenshots-directory, and\/or `lockDir` checks fail → `partial: <checks>`/);
    // lockDir and the screenshots directory may not exist yet: creating them is the test.
    expect(md).toContain(
      '`lockDir` is a writable directory, or does not exist yet and its parent allows creating it (test with `mkdir -p`, then create and remove one probe file in it — a sandbox can refuse the write even when the permissions allow it)',
    );
    expect(md).toMatch(/screenshots directory \(`qaEnv\.screenshotsDir`\) is writable the same way/);
    expect(md).toMatch(/Any GitHub, tracker, or bundled-file check fails → `missing: <checks>`/);
  });

  it('answers --confirm with step 1 only, in one line, writing nothing', () => {
    const description = md.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain(
      '--confirm = deploy confirmation only, replies confirmed / unconfirmed: <reason> / failed: <run> concluded <conclusion>',
    );
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

  it('never fails the report because the PNG did not render', () => {
    expect(md).toContain('`PNG not rendered: <reason>`');
    expect(md).toContain('the PNG never fails the report');
    const report = read('qa-report');
    expect(report).toContain('png=none png-error=<one-line reason>');
    expect(report).toContain('A PNG that cannot be rendered never fails the report');
  });

  it('publishes to the calling thread, the summary channel only when the profile names one', () => {
    expect(md).toContain('Then the summary channel, only when `report` names one.');
    expect(md).toMatch(/slack-mcp `send_file` \/ `send_media`\) is a valid `report` method/);
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
    reduced.indexOf('- **An adapter executable missing'),
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

  it('advertises waive=autoz in its description, argument hint and Args', () => {
    const description = md.match(/^description: "(.*)"$/m)?.[1] ?? '';
    expect(description).toContain('waive=autoz');
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
 * `compare` gets through gh_read only when the broker's installed classifier allows it (#998), and
 * the broker is installed apart from this plugin: an admin re-runs its installer, a deploy never
 * updates it. A host whose broker predates that rule refuses every compare `policy-denied`, so QA
 * could not confirm the deploy, list the range, or check that a merge is running (2026-11-06). A
 * compare read that is not an answer is now computed with git in a scratch clone. The direction is
 * the part a reader gets wrong: GitHub's `compare/<base>...<head>` answers `ahead` when `<base>` is
 * an ancestor of `<head>`, which is `git merge-base --is-ancestor <base> <head>`.
 */
const GIT = 'GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= git -c core.askPass= -c credential.interactive=never';

describe('deploy-qa computes a refused compare with git', () => {
  const md = read('deploy-qa');
  const github = md.slice(md.indexOf('## GitHub reads'), md.indexOf('## Args'));
  const steps = md.slice(md.indexOf('## Steps'), md.indexOf('## Final report'));
  const step1 = steps.slice(steps.indexOf('1. **Confirm the deploy**'), steps.indexOf('2. **Commits.**'));
  const step2 = steps.slice(steps.indexOf('2. **Commits.**'), steps.indexOf('3. **PRs.**'));
  const step5 = steps.slice(steps.indexOf('5. **Admission.**'), steps.indexOf('5.5. **Precondition gate.**'));

  it('keeps gh_read first and computes the answer with git when the compare read is refused or fails', () => {
    expect(github).toContain('Read `compare` with `gh_read` first.');
    expect(github).toMatch(/not an answer[^\n]*`policy-denied`[^\n]*compute the same answer with git/);
    // The classifier rules above stay as they were.
    expect(github).toContain('`compare` takes full 40-character SHAs only');
  });

  it('fetches only the SHAs the check names, over https, blob-less, never shallow, never with a token', () => {
    expect(github).toContain(`\`${GIT} init -q <dir>\``);
    expect(github).toContain(`\`${GIT} -C <dir> remote add origin https://github.com/<owner/repo>.git\``);
    expect(github).toContain(`\`${GIT} -C <dir> fetch --filter=blob:none origin <full SHAs>\``);
    expect(github).toContain('never `--depth`');
    expect(github).toContain('never put a token in the URL');
    expect(github).toContain(
      'Run the init and remote-add commands once per `<dir>`; a `<dir>` that already has the remote needs only the fetch.',
    );
  });

  it('never waits on a login: no terminal prompt, no askpass, helpers told not to ask, each call bounded', () => {
    expect(github).toContain(
      `Every git command here starts with \`${GIT}\`: git then never asks for a login on the terminal or through an askpass program and tells credential helpers not to ask, while the session's non-interactive credential helper still supplies it.`,
    );
    expect(github).toContain(
      "Run each git command in its own Bash call with an explicit timeout (the tool's `timeout`, e.g. 120000 ms), since a helper that ignores `credential.interactive` can still wait; a call that timed out or was killed is not an answer, the same as exit 128.",
    );
  });

  it('states the direction once: ahead or identical is merge-base --is-ancestor <base> <head>', () => {
    expect(github).toMatch(
      /`compare\/<base>\.\.\.<head>` status `ahead` means `<base>` is an ancestor of `<head>`, `identical` that they are the same commit/,
    );
    expect(github).toContain(`\`${GIT} -C <dir> merge-base --is-ancestor <base> <head>\` exits 0`);
  });

  it('exit 1 is an answer only from merge-base; a failed fetch, a kill or a timeout is not', () => {
    expect(github).toContain('exit 1 is an answer too (`behind` or `diverged`), but only from merge-base.');
    expect(github).toMatch(
      /A git failure — a fetch that exits non-zero \(1 included\), an unknown SHA \(exit 128\), a call that timed out or was killed, any other exit — is not an answer, the same as a failed read/,
    );
    expect(github).toContain('a check whose fetch failed has no answer, whatever a later merge-base or rev-list says.');
  });

  it('the git directory is scratch, so --confirm and --plan-only may create it', () => {
    expect(github).toContain('it is scratch, not a run write, so `--confirm` and `--plan-only` may create it');
  });

  it('names the answer source in the report notes', () => {
    expect(github).toContain("Add `compare via git: broker refused compare` to the report's `meta.notes`");
  });

  it('step 1: after is contained in runningSha, and before is strictly behind after', () => {
    expect(step1).toContain(
      `answers \`ahead\` or \`identical\` — via git, \`${GIT} -C <dir> merge-base --is-ancestor <after> <runningSha>\` exits 0`,
    );
    // `ahead` alone excludes the same commit: git's is-ancestor counts a commit as its own ancestor.
    expect(step1).toContain(
      `(compare status \`ahead\`; via git, \`${GIT} -C <dir> merge-base --is-ancestor <before> <after>\` exits 0 and \`before\` ≠ \`after\`)`,
    );
  });

  it('step 2: the whole range from one source, the one-parent commits, complete when rev-list exits 0', () => {
    expect(step2).toContain(`\`${GIT} -C <dir> rev-list --reverse --min-parents=1 --max-parents=1 <before>..<after>\``);
    expect(step2).toContain('never mix pages with git output');
    expect(step2).toContain('complete when it exits 0');
    // `--no-merges` alone keeps a parentless commit, which the one-parent rule drops.
    expect(step2).not.toMatch(/`[^`]*git[^`]*--no-merges[^`]*`/);
  });

  it("step 5: each related-repo mergeSha is contained in that repo's runningSha", () => {
    expect(step5).toContain('`repos/<owner/repo>/compare/<mergeSha>...<runningSha>`');
    expect(step5).toContain(`via git, \`${GIT} -C <dir> merge-base --is-ancestor <mergeSha> <runningSha>\` exits 0`);
  });
});

describe('each compare and its git command name the two SHAs in the same order', () => {
  for (const skill of ['deploy-qa', 'qa-issue']) {
    it(skill, () => {
      const md = read(skill);
      const lines = md.split('\n').filter((l) => /compare\/<[^<>]+>\.\.\.<[^<>]+>/.test(l) && /-C <dir>/.test(l));
      expect(lines.length, skill).toBeGreaterThanOrEqual(skill === 'deploy-qa' ? 4 : 2);
      for (const l of lines) {
        for (const [, base, head] of l.matchAll(/compare\/<([^<>]+)>\.\.\.<([^<>]+)>/g)) {
          const forward = `--is-ancestor <${base}> <${head}>`;
          const range = `<${base}>..<${head}>`;
          expect(l.includes(forward) || l.includes(range), `${skill}: ${l}`).toBe(true);
          expect(l, `${skill}: ${l}`).not.toContain(`--is-ancestor <${head}> <${base}>`);
        }
      }
      // Every git command carries the whole no-login prefix: a prompt would hang the step-1 poll.
      const gitSpans = md.split('`').filter((x, i) => i % 2 === 1 && /^(?:[A-Z_]+=\S*\s+)*git\s/.test(x));
      expect(gitSpans.length, skill).toBeGreaterThanOrEqual(skill === 'deploy-qa' ? 9 : 6);
      for (const x of gitSpans) expect(x.startsWith(GIT), `${skill}: ${x}`).toBe(true);
      // The running commit is always the descendant; the deployed merge never precedes the range's start.
      expect(md).not.toContain('--is-ancestor <runningSha>');
      expect(md).not.toContain('--is-ancestor <after> <before>');
    });
  }
});

/**
 * The documented git commands, run as written against a history whose compare answers are known.
 * main A─B─C─M─M2─D; side S1 branches at B and merges at M; U is an unrelated root merged at M2.
 * compare/B...D = ahead, D...D = identical, D...B = behind, S1...C = diverged; compare/B...D lists
 * C, S1, M, U, M2, D, and the one-parent ones are C, S1, D (U has none: `--no-merges` would keep it).
 *
 * The doc's commands run in a hostile inherited environment: GIT_ASKPASS, SSH_ASKPASS and the
 * global `core.askPass` all name a program that records that it ran and then sleeps. Only the
 * doc's own assignments and `-c` options stand between git and that program.
 */
describe('the documented git commands give the compare answers', () => {
  // No user or hook git state leaks in (a GIT_DIR from a hook, a global signing or URL-rewrite rule,
  // a proxy for the local login server).
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('GIT_') && k !== 'SSH_ASKPASS' && !/^(?:https?|all|no)_proxy$/i.test(k),
    ),
  );
  const env = { ...clean, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const sha: Record<string, string> = {};
  const UNKNOWN = '0123456789abcdef0123456789abcdef01234567';
  let root = '';
  let origin = '';
  let dir = '';
  let askpass = '';
  /** The environment a session might hand the doc's commands: an askpass that would hang. */
  let inherited: Record<string, string | undefined> = {};

  const git = (cwd: string, args: string[], at?: number) =>
    execFileSync('git', ['-c', 'user.name=qa', '-c', 'user.email=qa@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      env: at === undefined ? env : { ...env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` },
    }).trim();
  const commit = (name: string, at: number) => {
    writeFileSync(join(origin, `${name}.txt`), name);
    git(origin, ['add', `${name}.txt`]);
    git(origin, ['commit', '-q', '-m', name], at);
    sha[name] = git(origin, ['rev-parse', 'HEAD']);
  };
  const merge = (name: string, branch: string, at: number, extra: string[] = []) => {
    git(origin, ['merge', '-q', '--no-ff', ...extra, '-m', name, branch], at);
    sha[name] = git(origin, ['rev-parse', 'HEAD']);
  };
  /** An executable shell script in the test directory. */
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  /** A global git config holding `lines`, for the inherited environment. */
  const globalConfig = (name: string, lines: string[]) => {
    const path = join(root, name);
    writeFileSync(path, `${lines.join('\n')}\n`);
    return path;
  };

  interface Command {
    args: string[];
    env: Record<string, string>;
  }
  const gitPart = (span: string) => span.replace(/^(?:[A-Z_]+=\S*\s+)+/, '').replace(/^git (?:-c \S+ )+/, 'git ');
  /**
   * The doc's inline-code command whose git part (after its assignments and `-c` options) starts
   * with `prefix`, placeholders filled: git's argv and the environment assignments before it.
   */
  const command = (text: string, prefix: string, fill: Record<string, string>, url = `file://${origin}`): Command => {
    const span = text.split('`').find((s) => gitPart(s).startsWith(prefix));
    expect(span, prefix).toBeDefined();
    const filled = (span ?? '')
      .replace(/https:\/\/github\.com\/<[^<>]+>\.git/, url)
      .replace(/<([^<>]+)>/g, (_, name: string) => {
        const value = fill[name] ?? (name === 'dir' ? dir : undefined);
        if (value === undefined) throw new Error(`unfilled <${name}> in ${span}`);
        return value;
      });
    const words = filled.split(' ');
    const assigned: Record<string, string> = {};
    while (words.length > 0 && /^[A-Z_]+=/.test(words[0])) {
      const [name, ...value] = (words.shift() ?? '').split('=');
      assigned[name] = value.join('=');
    }
    expect(assigned, span).toEqual({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' });
    expect(words.slice(0, 5), span).toEqual(['git', '-c', 'core.askPass=', '-c', 'credential.interactive=never']);
    return { args: words.slice(1), env: assigned };
  };
  const run = (cmd: Command) =>
    spawnSync('git', cmd.args, { encoding: 'utf8', env: { ...inherited, ...cmd.env }, timeout: 30_000 });

  interface Bounded {
    status: number | null;
    killed: boolean;
    ms: number;
    stderr: string;
  }
  /**
   * The doc's per-call bound: run the command in its own process group and kill the whole group
   * (git and any helper it started) when `boundMs` passes, as the Bash tool's timeout does.
   */
  const runBounded = (cmd: Command, boundMs: number, extra: Record<string, string> = {}) =>
    new Promise<Bounded>((done) => {
      const started = Date.now();
      const child = spawn('git', cmd.args, {
        env: { ...inherited, ...extra, ...cmd.env },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      let killed = false;
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      const killGroup = () => {
        try {
          process.kill(-(child.pid ?? 0), 'SIGKILL');
        } catch {
          // the group is already gone
        }
      };
      const timer = setTimeout(() => {
        killed = true;
        killGroup();
      }, boundMs);
      child.on('close', (status) => {
        clearTimeout(timer);
        killGroup();
        done({ status, killed, ms: Date.now() - started, stderr });
      });
    });
  /** The doc's reading of one git call: 0 = yes; 1 = no, from merge-base only; else no answer. */
  const answer = (r: { status: number | null; killed?: boolean }, fromMergeBase: boolean) => {
    if (r.killed || r.status === null) return 'no answer';
    if (r.status === 0) return 'yes';
    return r.status === 1 && fromMergeBase ? 'no' : 'no answer';
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'deploy-qa-compare-'));
    origin = join(root, 'origin');
    dir = join(root, 'compare-example-org-app');
    askpass = script('askpass.sh', 'touch "$0.ran"\nsleep 30\necho stolen');
    inherited = {
      ...clean,
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      GIT_CONFIG_GLOBAL: globalConfig('askpass.gitconfig', ['[core]', `\taskPass = ${askpass}`]),
      GIT_CONFIG_NOSYSTEM: '1',
    };
    execFileSync('git', ['init', '-q', '-b', 'main', origin], { env });
    commit('A', 1_700_000_001);
    commit('B', 1_700_000_002);
    git(origin, ['branch', 'side']);
    commit('C', 1_700_000_003);
    git(origin, ['checkout', '-q', 'side']);
    commit('S1', 1_700_000_004);
    git(origin, ['checkout', '-q', 'main']);
    merge('M', 'side', 1_700_000_005);
    git(origin, ['checkout', '-q', '--orphan', 'unrelated']);
    git(origin, ['rm', '-rq', '--cached', '.']);
    commit('U', 1_700_000_006);
    git(origin, ['checkout', '-q', '-f', 'main']);
    merge('M2', 'unrelated', 1_700_000_007, ['--allow-unrelated-histories']);
    commit('D', 1_700_000_008);
    // Serve blob-less fetches of any SHA, as GitHub does; then leave D unadvertised.
    git(origin, ['config', 'uploadpack.allowFilter', 'true']);
    git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(origin, ['branch', '-q', '-D', 'side', 'unrelated']);
    git(origin, ['reset', '-q', '--hard', sha.B]);

    const github = read('deploy-qa').slice(0, read('deploy-qa').indexOf('## Args'));
    for (const prefix of ['git init', 'git -C <dir> remote add', 'git -C <dir> fetch']) {
      const result = run(command(github, prefix, { 'full SHAs': `${sha.B} ${sha.D}` }));
      expect(result.status, `${prefix}: ${result.stderr}`).toBe(0);
    }
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('the fetch makes a blob-less, full-history clone holding both SHAs', () => {
    expect(git(dir, ['rev-parse', '--is-shallow-repository'])).toBe('false');
    expect(git(dir, ['config', 'remote.origin.partialclonefilter'])).toBe('blob:none');
    expect(git(dir, ['cat-file', '-t', sha.D])).toBe('commit');
  });

  it('a later check in the same directory needs only the fetch (step 1 polls, step 5 checks many merges)', () => {
    const md = read('deploy-qa');
    const github = md.slice(0, md.indexOf('## Args'));
    // Adding the remote a second time fails, which is why the doc runs it once per directory.
    expect(run(command(github, 'git -C <dir> remote add', {})).status).not.toBe(0);
    const again = run(command(github, 'git -C <dir> fetch', { 'full SHAs': `${sha.S1} ${sha.D}` }));
    expect(again.status, again.stderr).toBe(0);
    expect(git(dir, ['cat-file', '-t', sha.S1])).toBe('commit');
  });

  it("a refused fetch of an unavailable SHA is no answer, never merge-base's 'not contained'", () => {
    const md = read('deploy-qa');
    const github = md.slice(0, md.indexOf('## Args'));
    const fetch = run(command(github, 'git -C <dir> fetch', { 'full SHAs': `${UNKNOWN} ${sha.D}` }));
    expect(fetch.status, fetch.stderr).not.toBe(0);
    expect(answer(fetch, false)).toBe('no answer');
    // Even a fetch that exits 1 is no answer: exit 1 means "not contained" only from merge-base.
    expect(answer({ status: 1 }, false)).toBe('no answer');
    expect(answer({ status: 1 }, true)).toBe('no');
    expect(existsSync(`${askpass}.ran`)).toBe(false);
  });

  it('deploy-qa step 1: is-ancestor <after> <runningSha> is 0 for ahead and identical, 1 otherwise', () => {
    const md = read('deploy-qa');
    const step1 = md.slice(md.indexOf('1. **Confirm the deploy**'), md.indexOf('2. **Commits.**'));
    const status = (after: string, runningSha: string) =>
      run(command(step1, 'git -C <dir> merge-base --is-ancestor <after>', { after, runningSha })).status;
    expect(status(sha.B, sha.D)).toBe(0); // compare/B...D = ahead
    expect(status(sha.D, sha.D)).toBe(0); // identical
    expect(status(sha.D, sha.B)).toBe(1); // behind
    expect(status(sha.S1, sha.C)).toBe(1); // diverged
    expect(answer({ status: status(UNKNOWN, sha.D) }, true)).toBe('no answer');
  });

  it('deploy-qa step 1: is-ancestor <before> <after> holds for a range whose start precedes its end', () => {
    const md = read('deploy-qa');
    const step1 = md.slice(md.indexOf('1. **Confirm the deploy**'), md.indexOf('2. **Commits.**'));
    const status = (before: string, after: string) =>
      run(command(step1, 'git -C <dir> merge-base --is-ancestor <before>', { before, after })).status;
    expect(status(sha.B, sha.D)).toBe(0);
    expect(status(sha.D, sha.B)).toBe(1);
  });

  it("deploy-qa step 2: rev-list lists exactly compare's one-parent commits, oldest first", () => {
    const md = read('deploy-qa');
    const step2 = md.slice(md.indexOf('2. **Commits.**'), md.indexOf('3. **PRs.**'));
    const result = run(command(step2, 'git -C <dir> rev-list', { before: sha.B, after: sha.D }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([sha.C, sha.S1, sha.D]);
  });

  it('deploy-qa step 5 and qa-issue step 2: is-ancestor <mergeSha> <runningSha>', () => {
    const deployQa = read('deploy-qa');
    const step5 = deployQa.slice(
      deployQa.indexOf('5. **Admission.**'),
      deployQa.indexOf('5.5. **Precondition gate.**'),
    );
    const qaIssue = read('qa-issue');
    const step2 = qaIssue.slice(qaIssue.indexOf('2. Deploy check'), qaIssue.indexOf('3. Build cases'));
    for (const text of [step5, step2]) {
      const status = (mergeSha: string, runningSha: string) =>
        run(command(text, 'git -C <dir> merge-base --is-ancestor <mergeSha>', { mergeSha, runningSha })).status;
      expect(status(sha.S1, sha.D)).toBe(0); // the side merge is running
      expect(status(sha.D, sha.D)).toBe(0);
      expect(status(sha.D, sha.C)).toBe(1); // not deployed yet
    }
  });

  /**
   * A login server that always answers 401, so the documented fetch has to ask for credentials:
   * the path a private repo takes when the session's helper holds no valid login.
   */
  describe('the documented fetch against a server that asks for a login', () => {
    let server: Server;
    let url = '';
    const seen: string[] = [];
    const BOUND = 15_000;

    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push(req.headers.authorization ?? '');
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="qa"' });
        res.end();
      });
      await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/example-org/app.git`;
    });

    afterAll(async () => {
      await new Promise((closed) => server.close(closed));
    });

    /** The doc's init + remote add + fetch in a new directory, the fetch run under the bound. */
    const fetchWithLogin = async (name: string, helper: string, boundMs = BOUND, strip = false) => {
      const github = read('deploy-qa').slice(0, read('deploy-qa').indexOf('## Args'));
      const own = join(root, name);
      for (const prefix of ['git init', 'git -C <dir> remote add']) {
        const result = run(command(github, prefix, { dir: own }, url));
        expect(result.status, `${prefix}: ${result.stderr}`).toBe(0);
      }
      const config = globalConfig(`${name}.gitconfig`, [
        '[core]',
        `\taskPass = ${askpass}`,
        '[credential]',
        `\thelper = ${helper}`,
      ]);
      const fetch = command(github, 'git -C <dir> fetch', { dir: own, 'full SHAs': sha.D }, url);
      // `strip`: the same fetch without the doc's assignments and `-c` options, as a control.
      const cmd = strip ? { args: fetch.args.slice(4), env: {} } : fetch;
      return runBounded(cmd, boundMs, { GIT_CONFIG_GLOBAL: config });
    };

    it("control: without the doc's prefix the same environment runs the askpass and waits", async () => {
      const empty = script('control-helper.sh', 'cat >/dev/null');
      const askpassRan = existsSync(`${askpass}.ran`);
      const result = await fetchWithLogin('control', empty, 2_000, true);
      expect(result.killed).toBe(true);
      expect(existsSync(`${askpass}.ran`)).toBe(true);
      // Leave the marker as it was, so the other tests' "the askpass never ran" still reads it.
      if (!askpassRan) rmSync(`${askpass}.ran`);
    });

    it('an inherited askpass never runs: with no stored login the fetch fails at once, no answer', async () => {
      const empty = script('empty-helper.sh', 'touch "$0.ran"\ncat >/dev/null');
      const result = await fetchWithLogin('no-login', empty);
      expect(result.killed).toBe(false);
      expect(result.ms).toBeLessThan(BOUND / 3);
      expect(result.status, result.stderr).not.toBe(0);
      expect(answer(result, false)).toBe('no answer');
      expect(existsSync(`${empty}.ran`)).toBe(true); // the helper was still asked
      expect(existsSync(`${askpass}.ran`)).toBe(false); // the askpass never was
    });

    it("the session's non-interactive helper still supplies the login", async () => {
      const helper = script(
        'login-helper.sh',
        'cat >/dev/null\nif [ "$1" = get ]; then printf "username=qa\\npassword=helper-login\\n"; fi',
      );
      const before = seen.length;
      const result = await fetchWithLogin('helper-login', helper);
      expect(result.killed).toBe(false);
      expect(result.ms).toBeLessThan(BOUND / 3);
      expect(seen.slice(before)).toContain(`Basic ${Buffer.from('qa:helper-login').toString('base64')}`);
      expect(answer(result, false)).toBe('no answer'); // this server refuses every login
      expect(existsSync(`${askpass}.ran`)).toBe(false);
    });

    it('a helper that waits anyway is cut off by the per-call bound, and that is no answer', async () => {
      // No git option stops a helper that ignores credential.interactive without turning off the
      // helpers private repos need; the doc's per-call timeout does. 2 s stands in for its 120000 ms.
      const waits = script('waiting-helper.sh', 'sleep 30');
      const result = await fetchWithLogin('waiting-helper', waits, 2_000);
      expect(result.killed).toBe(true);
      expect(result.ms).toBeLessThan(BOUND / 3);
      expect(answer(result, false)).toBe('no answer');
      expect(existsSync(`${askpass}.ran`)).toBe(false);
    });
  });
});
