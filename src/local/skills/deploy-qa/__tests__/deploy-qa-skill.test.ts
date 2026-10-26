import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for the post-deploy QA skills when they run inside the deploy
 * session itself, which may be sandboxed (writes only under the user's tmp
 * directory, network = dev-domain allowlist).
 *
 *  - In such a session the `gh` CLI's network calls fail TLS verification,
 *    while curl to the GitHub REST API with `gh auth token` works. So every
 *    GitHub read goes through the one "GitHub call" curl form.
 *  - The preflight answers `partial: <checks>` when only the adapter and/or
 *    lockDir checks fail, and the run then QA's in a defined reduced mode
 *    instead of not running at all.
 *  - Re-run arguments are a maintainer reference, never the requester's step.
 */

const SKILLS_DIR = resolve(__dirname, '..', '..');
const read = (skill: string) => readFileSync(resolve(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');

const GITHUB_CALL =
  'curl -fsSL --connect-timeout 10 --max-time 30 -H "Authorization: Bearer $(gh auth token)" -H "Accept: application/vnd.github+json" "https://api.github.com/<path>"';

describe('post-deploy QA skills read GitHub without gh network calls', () => {
  for (const skill of ['deploy-qa', 'qa-issue', 'qa-report']) {
    it(`${skill} uses no gh network command`, () => {
      const md = read(skill);
      for (const cmd of [
        'gh api repos/',
        'gh api --paginate',
        'gh pr list',
        'gh repo view',
        'gh run watch',
        'gh search',
      ]) {
        expect(md, `${skill}: ${cmd}`).not.toContain(cmd);
      }
    });
  }

  for (const skill of ['deploy-qa', 'qa-issue']) {
    it(`${skill} defines the GitHub call form and how to page`, () => {
      const md = read(skill);
      expect(md).toContain(GITHUB_CALL);
      expect(md).toContain('shell state does not carry over');
      expect(md).toContain('per_page=100&page=N');
      // An HTTP error or paging that did not reach the end is incomplete, never empty.
      expect(md).toContain('never read it as empty or complete');
      // Every curl is bounded.
      for (const l of md.split('\n').filter((x) => x.includes('curl -'))) {
        expect(l).toContain('--connect-timeout 10 --max-time 30');
      }
    });
  }

  it('deploy-qa keeps only merged PRs from the closed listing', () => {
    expect(read('deploy-qa')).toMatch(
      /pulls\?state=closed&base=<integrationBranch>`, keeping only PRs with `merged_at` set/,
    );
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
    expect(step1).toContain('A full run re-checks here; a deploy that `--confirm` already confirmed normally passes without waiting, if the current evidence still shows it deployed.');
  });

  it('owns the deploy confirmation for its repo, within a fixed budget, with no event filter', () => {
    const step1 = md.slice(md.indexOf('1. **Confirm the deploy**'), md.indexOf('2. **Commits.**'));
    expect(step1).toContain('the deploy workflow does not confirm a repo with QA itself');
    expect(md).not.toContain('event=push');
    expect(step1).toContain('actions/workflows/<CD workflow>/runs?head_sha=<after>&branch=<target>` (paged)');
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
