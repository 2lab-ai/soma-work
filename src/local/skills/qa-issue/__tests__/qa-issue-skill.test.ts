import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract for qa-issue at depth `max`: it covers what a human QA covers
 * (§Coverage matrix) and it asks before it runs when a precondition is missing
 * (§Precondition gate). Personal environment skills point at these two anchors,
 * so renaming them must break CI, not the pointer.
 */

const md = readFileSync(resolve(__dirname, '..', 'SKILL.md'), 'utf8');
const section = (title: string) => {
  const start = md.indexOf(`## ${title}`);
  expect(start, `missing section: ${title}`).toBeGreaterThan(-1);
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start, next < 0 ? undefined : next);
};
const description = md.match(/^description: "(.*)"$/m)?.[1] ?? '';

describe('qa-issue — the two anchors other skills point at', () => {
  it('has §Coverage matrix and §Precondition gate', () => {
    expect(md).toContain('## Coverage matrix');
    expect(md).toContain('## Precondition gate');
  });

  it('advertises the plan-only mode and the decisions file in its Args (the description says only when)', () => {
    expect(description).toMatch(/^Use when /);
    expect(md).toMatch(/## Args\n\n`<ISSUE-KEY>[^`]*\[--plan\] \[decisions=<gate file>\]`/);
    expect(md).toContain('- `--plan`: plan and gate only, run nothing.');
    expect(md).toContain("- `decisions=<gate file>`: resume with the requester's recorded answer.");
    expect(md).toMatch(/argument-hint: "[^"]*\[--plan\][^"]*\[decisions=<gate file>\]/);
  });
});

describe('qa-issue §Coverage matrix — what a human QA checks', () => {
  const s = section('Coverage matrix');

  it('names every dimension with its gate.mjs key', () => {
    for (const dim of [
      '`acceptance`',
      '`roles`',
      '`writes`',
      '`crossSurface`',
      '`dataStates`',
      '`negative`',
      '`persistence`',
      '`deviceLocale`',
      '`time`',
      '`regression`',
      '`observability`',
    ]) {
      expect(s, dim).toContain(dim);
    }
  });

  it('fixes each case oracle before running and never leaves a cell blank', () => {
    expect(s).toContain('assertion');
    expect(s).toContain('`N/A: <change-impact reason>`');
    expect(s).toContain('`matrix-incomplete:<dim>`');
    expect(s).toMatch(/`acceptance`, `writes` and `negative` are never N\/A when the change touches a write endpoint/);
  });

  it('runs real writes with read-back and cleanup, and reroutes accounts instead of blocking on a lane', () => {
    expect(s).toContain('read back');
    expect(s).toContain('cleanup');
    expect(s).toMatch(/never blocked because a sub-runner or lane was not allowed to use it/);
  });

  it('bounds mocking and statistics', () => {
    expect(s).toContain('`evidence.mocked`');
    expect(s).toContain('a mocked case never proves server behaviour');
    expect(s).toContain('`tolerance`');
  });

  it('keeps the count floor only as a backstop', () => {
    const levels = section('QA levels and severity');
    expect(levels).toMatch(/`max`: the full Coverage matrix and the Precondition gate/);
    expect(levels).toContain('never a reason to pad');
  });
});

describe('qa-issue §Precondition gate — confirm before QA, never after', () => {
  const s = section('Precondition gate');

  it('checks every planned case before any case runs and before any tracker write', () => {
    expect(s).toContain('before any case runs and before any tracker write');
    expect(s).toContain('read-only');
    for (const k of [
      '`account`',
      '`test-data`',
      '`write-permission`',
      '`env-config`',
      '`external-system`',
      '`time-control`',
      '`device-locale`',
      '`observability`',
    ]) {
      expect(s, k).toContain(k);
    }
    for (const st of ['`met`', '`provisionable`', '`missing`']) expect(s, st).toContain(st);
  });

  it('provisions only what the profile lists, and a waiver never grants a write', () => {
    expect(s).toContain('`qaEnv.accounts`');
    expect(s).toContain('`qaEnv.seed`');
    expect(s).toContain('Nothing is improvised');
    expect(s).toContain('A waiver never grants a write or overrides a security rule');
  });

  it('asks the requester once, with three choices, and runs nothing before the answer', () => {
    expect(s).toMatch(/provide it[\s\S]*proceed without it[\s\S]*skip the key/);
    expect(s).toContain('No case runs and no tracker write happens before the answer');
    expect(s).toContain('No answer is waiting, never consent');
    expect(s).toContain('posted gap table is the question');
  });

  it('binds consent to the disclosed plan through gate.mjs', () => {
    expect(s).toContain('scripts/gate.mjs');
    for (const cmd of ['seal', 'merge', 'answer', 'decide']) expect(s, cmd).toContain(`gate.mjs" ${cmd}`);
    expect(s).toContain(
      'loads the planned cases, coverage matrix and precondition→case mapping from the gate file verbatim',
    );
    expect(s).toContain('never hashed');
    expect(s).toMatch(/`provided` but[^\n]*still `missing`[^\n]*asks again/);
    expect(s).toContain('No wildcard');
  });

  it('documents every case field the fingerprint binds (#591)', () => {
    for (const f of ['`steps`', '`expected`', '`tolerance`', '`accountRef`']) expect(s, f).toContain(f);
  });

  it('defines --plan as steps 1–3 that write a gate file and run nothing', () => {
    expect(s).toMatch(/`--plan`[^\n]*steps 1–3/);
    expect(s).toContain('`<runDir>/gate-<KEY>.json`');
    expect(s).toContain('runs no case and writes no tracker comment');
  });
});

describe('qa-issue procedure and results carry the gate', () => {
  it('runs the gate between building cases and running them', () => {
    const p = section('Procedure');
    const build = p.indexOf('Build cases');
    const gateStep = p.indexOf('Precondition gate');
    const run = p.indexOf('Run the cases');
    expect(build).toBeGreaterThan(-1);
    expect(gateStep).toBeGreaterThan(build);
    expect(run).toBeGreaterThan(gateStep);
  });

  it('every case blocked → blocked; waived cases stay in the count and are never pass', () => {
    const p = section('Procedure');
    expect(p).toContain('every case `blocked` → `blocked`');
    expect(p).toContain('`precondition-waived:<ids> by <who>`');
  });

  it('returns coverage and preconditions in the JSON, with the decision values qa-report reads', () => {
    const r = section('Results');
    expect(r).toContain('"coverage"');
    expect(r).toContain('"preconditions"');
    expect(r).toContain('"precondition"');
    expect(r).toContain('provided|waived|skipped|pending');
    expect(r).toContain('waiting for precondition confirmation');
  });
});

/**
 * A broker installed before compare was allowed refuses every compare `policy-denied` (2026-11-06), and the broker is
 * updated apart from this plugin. The deploy check and the done check then take the containment answer from the
 * commits list through gh_read, which works inside the sandbox; the git fallback of #1015 could not run there.
 * deploy-qa-skill.test.ts runs the range rule against a real history.
 */
describe('qa-issue computes a refused compare from the commits list', () => {
  const github = section('GitHub reads');
  const procedure = section('Procedure');
  const deployCheck = procedure.slice(procedure.indexOf('2. Deploy check'), procedure.indexOf('3. Build cases'));

  it('keeps gh_read first and falls back to the commits list when the compare read is refused or fails', () => {
    expect(github).toContain('Read `compare` with `gh_read` first.');
    expect(github).toMatch(/not an answer[^\n]*`policy-denied`[^\n]*answer from the commits list instead/);
    expect(github).toContain('`compare` takes full 40-character SHAs only');
    expect(github).toContain(
      '`repos/<repo>/commits` with `"-f", "sha=<sha>", "-f", "per_page=100", "-f", "page=<N>"` and the filter `[.[] | {sha, parents: [.parents[].sha]}]`',
    );
  });

  it('contained = the full SHA appears within 10 pages; anything else is no answer, never "not contained"', () => {
    expect(github).toContain(
      "page the list from `<head>`, N = 1 … 10 at most, a page with fewer than 100 commits ends the list; `<base>`'s full SHA appears → contained.",
    );
    expect(github).toContain(
      'Not found within 10 pages, or a page that is not an answer → no answer: never a pass and never "not contained", the check stays unmet.',
    );
  });

  it('names the answer source where qa-report reads it', () => {
    expect(github).toContain(
      'Name the source in `deployConfirm.provenance` and the tracker comment: `compare via commits list: broker refused compare`',
    );
  });

  it('step 2 and the contained done condition take the list answer, mergeSha first', () => {
    expect(deployCheck).toContain(
      '∈ `ahead|identical` — via the commits list, `mergeSha` contained in `runningSha` (`mergeSha` is `runningSha` or one of its ancestors)',
    );
    expect(deployCheck).toContain('no answer from compare or the commits list');
    expect(section('Tracker reconcile')).toContain(
      "step 2's per-repo compare (or its commits-list answer) holds for every `mergeSha`, re-read now",
    );
  });

  it('no git recipe remains', () => {
    expect(md).not.toMatch(
      /git init|merge-base|rev-list|--filter=blob:none|GIT_TERMINAL_PROMPT|credential\.interactive/,
    );
    expect(md).not.toContain('compare via git');
    expect(md).not.toContain('git answer');
  });
});

/**
 * A job log read with `api … actions/jobs/<id>/logs` never answers: gh refuses to print a body with terminal escape
 * sequences, the override flag is outside the gh_read policy, and `--jq` cannot parse the text. `run view --job --log`
 * is allowed and prints the same log, a few hundred KB, so the skill names it and the step-name column.
 */
describe('qa-issue reads a job log with run view, never through api', () => {
  const github = section('GitHub reads');
  const jobLogs = github.slice(github.indexOf('**Job logs.**'), github.indexOf('**Compare via commits list.**'));

  it('sits after Paging, before the compare fallback', () => {
    expect(github).toContain('**Job logs.**');
    expect(github.indexOf('Paging:')).toBeLessThan(github.indexOf('**Job logs.**'));
    expect(github.indexOf('**Job logs.**')).toBeLessThan(github.indexOf('**Compare via commits list.**'));
  });

  it('prescribes run view by job id, with the failed-steps variant and where the job id comes from', () => {
    expect(jobLogs).toContain('`["run", "view", "-R", "<owner/repo>", "--job", "<job id>", "--log"]`');
    expect(jobLogs).toContain('`--log-failed`');
    expect(jobLogs).toContain('`repos/<owner/repo>/actions/runs/<run-id>/jobs`');
  });

  it('forbids the api form and says why', () => {
    expect(jobLogs).toContain('never `api …/actions/jobs/<job id>/logs`');
    expect(jobLogs).toMatch(/gh refuses to print it[^\n]*the policy refuses the flag/);
    expect(md).not.toMatch(/`repos\/[^`]*\/actions\/jobs\//);
  });

  it('picks lines by the step-name column and keeps a truncated output a failed read', () => {
    expect(jobLogs).toContain('hundreds of KB');
    expect(jobLogs).toContain('step-name column');
    expect(jobLogs).toContain('A truncated output is a failed read.');
  });
});
