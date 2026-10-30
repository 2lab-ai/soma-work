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

  it('advertises the plan-only mode and the decisions file', () => {
    expect(description).toContain('--plan');
    expect(description).toContain('decisions=<gate file>');
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
