import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
