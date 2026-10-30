import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The precondition gate's deterministic core (qa-issue/scripts/gate.mjs).
 *
 * The gate exists because the 2026-10-30 stage0 qa=max run found 49 of its 69
 * non-pass cases blocked by preconditions (writes forbidden, one account, no test
 * data, …) only while running them, and buried them as PARTIAL. The gate plans
 * first, asks the requester once, and resumes only on a recorded answer bound to
 * the disclosed plan. These tests pin what prose cannot: the fingerprint ignores
 * probe results and workflow-owned fields, a pending gate is never overwritten,
 * and an unanswered or changed gap is asked again instead of run.
 */

const GATE = resolve(__dirname, '..', 'scripts', 'gate.mjs');
const DIMS = [
  'acceptance',
  'roles',
  'writes',
  'crossSurface',
  'dataStates',
  'negative',
  'persistence',
  'deviceLocale',
  'time',
  'regression',
  'observability',
];

let dir: string;

function gate(args: string[]) {
  const run = spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8' });
  const last = run.stdout.trim().split('\n').pop() || '';
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(last);
  } catch {
    /* non-JSON output is asserted by the caller */
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, out };
}

function write(name: string, data: unknown) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function coverage(over: Record<string, unknown> = {}) {
  const c: Record<string, unknown> = {};
  for (const d of DIMS) c[d] = ['QA-1'];
  c.deviceLocale = 'N/A: the change has no layout or text';
  c.time = 'N/A: no time-dependent behaviour in the diff';
  return { ...c, ...over };
}

/** A per-key gate as `qa-issue --plan` writes it, before `seal`. */
function planned(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    env: { profile: 'acme-env:staging-qa', profileRevision: 'r1' },
    inputs: {
      deployedShas: ['acme/app:aaaaaaa'],
      issue: {
        summary: 'Expired bet notice',
        description: 'Show a notice when a pending bet expires.',
        acceptance: '1. notice shows',
      },
      mergedPrs: ['acme/app#42'],
    },
    plan: {
      touchesWrite: true,
      coverage: coverage(),
      cases: [
        {
          id: 'QA-1',
          type: 'happy',
          severity: 'P1',
          desc: 'notice after expiry',
          assertion: 'banner text equals spec',
          preconditions: ['P1'],
        },
        {
          id: 'QA-2',
          type: 'edge',
          severity: 'P2',
          desc: 'other account sees nothing',
          assertion: 'no banner',
          preconditions: ['P2'],
        },
        {
          id: 'QA-3',
          type: 'edge',
          severity: 'P3',
          desc: 'reload keeps state',
          assertion: 'banner gone after ack',
          preconditions: [],
        },
      ],
    },
    preconditions: [
      {
        id: 'P1',
        kind: 'write-permission',
        need: 'place a bet as the test player',
        cases: ['QA-1'],
        status: 'missing',
      },
      { id: 'P2', kind: 'account', need: 'a second player account', cases: ['QA-2'], status: 'missing' },
    ],
    ...over,
  };
}

function sealed(name: string, data: unknown) {
  const p = write(name, data);
  const r = gate(['seal', p]);
  expect(r.status, r.stderr).toBe(0);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-gate-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gate.mjs seal — the coverage matrix is complete before anything runs', { timeout: 30_000 }, () => {
  it('seals a complete plan and reports its missing preconditions', () => {
    const p = write('ok.json', planned('PROJ-1'));
    const r = gate(['seal', p]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ key: 'PROJ-1', missing: ['P1', 'P2'] });
    expect(String(r.out.fingerprint)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(p, 'utf8')).fingerprint).toBe(r.out.fingerprint);
  });

  it('refuses a blank matrix cell with matrix-incomplete:<dim>', () => {
    const p = write(
      'blank.json',
      planned('PROJ-2', { plan: { ...planned('PROJ-2').plan, coverage: coverage({ negative: [] }) } }),
    );
    const r = gate(['seal', p]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('matrix-incomplete:negative');
  });

  it('refuses an N/A without a reason', () => {
    const p = write(
      'na.json',
      planned('PROJ-3', { plan: { ...planned('PROJ-3').plan, coverage: coverage({ regression: 'N/A' }) } }),
    );
    const r = gate(['seal', p]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('matrix-incomplete:regression');
  });

  it('never lets acceptance, writes or negative paths be N/A when the change touches a write endpoint', () => {
    for (const d of ['acceptance', 'writes', 'negative']) {
      const p = write(
        `w-${d}.json`,
        planned('PROJ-4', { plan: { ...planned('PROJ-4').plan, coverage: coverage({ [d]: 'N/A: looks read-only' }) } }),
      );
      const r = gate(['seal', p]);
      expect(r.status, d).toBe(4);
      expect(r.stderr).toContain(`matrix-incomplete:${d}`);
    }
  });

  it('refuses a case that does not list its preconditions (an empty list must be explicit)', () => {
    const base = planned('PROJ-6');
    const { preconditions: _omit, ...unlisted } = base.plan.cases[2];
    const p = write('unlisted.json', {
      ...base,
      plan: { ...base.plan, cases: [base.plan.cases[0], base.plan.cases[1], unlisted] },
    });
    const r = gate(['seal', p]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('case QA-3: preconditions must be listed');
  });

  it('refuses a precondition of an unknown kind or one pointing at a case that is not planned', () => {
    const base = planned('PROJ-5');
    const badKind = write('kind.json', { ...base, preconditions: [{ ...base.preconditions[0], kind: 'vibes' }] });
    expect(gate(['seal', badKind]).status).toBe(4);
    const badCase = write('case.json', { ...base, preconditions: [{ ...base.preconditions[0], cases: ['QA-99'] }] });
    expect(gate(['seal', badCase]).status).toBe(4);
  });
});

describe('gate.mjs fingerprint — bound to the disclosed plan and its inputs, never to probe results', {
  timeout: 30_000,
}, () => {
  it('ignores precondition status, decisions and workflow-owned fields', () => {
    const a = sealed('fa.json', planned('PROJ-10'));
    const b = planned('PROJ-10');
    b.preconditions = b.preconditions.map((p) => ({
      ...p,
      status: 'met',
      decision: 'provided',
      confirmedBy: 'U1',
      confirmedAt: '2026-10-30T01:00:00Z',
      confirmRef: '123.456',
    }));
    (b.inputs.issue as Record<string, unknown>).updated = '2026-10-30T09:00:00Z';
    (b.inputs.issue as Record<string, unknown>).status = 'QA';
    const bp = sealed('fb.json', b);
    expect(gate(['fingerprint', bp]).out.fingerprint).toBe(gate(['fingerprint', a]).out.fingerprint);
  });

  it('normalizes whitespace in the issue text', () => {
    const a = sealed('wa.json', planned('PROJ-11'));
    const b = planned('PROJ-11');
    b.inputs.issue.description = '  Show a notice   when a pending bet\nexpires. ';
    const bp = sealed('wb.json', b);
    expect(gate(['fingerprint', bp]).out.fingerprint).toBe(gate(['fingerprint', a]).out.fingerprint);
  });

  it('changes when a case assertion, a severity, the deployed SHAs, the profile revision or the requirements change', () => {
    const base = gate(['fingerprint', sealed('c0.json', planned('PROJ-12'))]).out.fingerprint;
    const variants: Array<(g: ReturnType<typeof planned>) => void> = [
      (g) => {
        g.plan.cases[0].assertion = 'any banner';
      },
      (g) => {
        g.plan.cases[1].severity = 'P3';
      },
      (g) => {
        g.inputs.deployedShas = ['acme/app:bbbbbbb'];
      },
      (g) => {
        g.env.profileRevision = 'r2';
      },
      (g) => {
        g.inputs.issue.acceptance = '1. notice shows 2. amount is returned';
      },
      (g) => {
        g.preconditions[0].need = 'place a bet as any account';
      },
    ];
    variants.forEach((mutate, i) => {
      const g = planned('PROJ-12');
      mutate(g);
      const fp = gate(['fingerprint', sealed(`c${i + 1}.json`, g)]).out.fingerprint;
      expect(fp, `variant ${i}`).not.toBe(base);
    });
  });
});

describe('gate.mjs merge — one question for the whole run, never overwriting a pending gate', {
  timeout: 30_000,
}, () => {
  it('merges per-key gates into one run gate and says whether to ask', () => {
    const k1 = sealed('m1.json', planned('PROJ-20'));
    const clear = planned('PROJ-21');
    clear.preconditions = clear.preconditions.map((p) => ({ ...p, status: 'met' }));
    const k2 = sealed('m2.json', clear);
    const out = join(dir, 'acme-app-aaaaaaa-20261030T010000Z.json');
    const r = gate(['merge', '--out', out, k1, k2]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ gateId: 'acme-app-aaaaaaa-20261030T010000Z', keys: 2, missing: 2, ask: true });
    const run = JSON.parse(readFileSync(out, 'utf8'));
    expect(run.status).toBe('pending');
    expect(Object.keys(run.keys)).toEqual(['PROJ-20', 'PROJ-21']);
  });

  it('a run with no missing precondition does not ask', () => {
    const g = planned('PROJ-22');
    g.preconditions = g.preconditions.map((p) => ({ ...p, status: 'provisionable' }));
    const out = join(dir, 'clear.json');
    const r = gate(['merge', '--out', out, sealed('m3.json', g)]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ missing: 0, ask: false });
    expect(JSON.parse(readFileSync(out, 'utf8')).status).toBe('clear');
  });

  it('refuses to overwrite an existing gate file', () => {
    const out = join(dir, 'exists.json');
    writeFileSync(out, '{"status":"pending"}');
    const r = gate(['merge', '--out', out, sealed('m4.json', planned('PROJ-23'))]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('never overwritten');
    expect(readFileSync(out, 'utf8')).toBe('{"status":"pending"}');
  });

  it('refuses a per-key gate whose stored fingerprint no longer matches its content', () => {
    const p = sealed('m5.json', planned('PROJ-24'));
    const g = JSON.parse(readFileSync(p, 'utf8'));
    g.plan.cases[0].assertion = 'edited after sealing';
    writeFileSync(p, JSON.stringify(g));
    const r = gate(['merge', '--out', join(dir, 'tampered.json'), p]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('fingerprint mismatch: PROJ-24');
  });

  it('carries decisions only for keys whose fingerprint is unchanged', () => {
    const old = join(dir, 'old-run.json');
    gate(['merge', '--out', old, sealed('c-a.json', planned('PROJ-25')), sealed('c-b.json', planned('PROJ-26'))]);
    gate(['answer', '--gate', old, '--key', 'all', '--decision', 'waived', '--by', 'U_REQ', '--ref', '1.1']);
    const changed = planned('PROJ-26');
    changed.plan.cases[0].assertion = 'new assertion';
    const out = join(dir, 'new-run.json');
    const r = gate([
      'merge',
      '--out',
      out,
      '--carry',
      old,
      sealed('c-a2.json', planned('PROJ-25')),
      sealed('c-b2.json', changed),
    ]);
    expect(r.status, r.stderr).toBe(0);
    const run = JSON.parse(readFileSync(out, 'utf8'));
    expect(run.keys['PROJ-25'].preconditions.map((p: { decision: string }) => p.decision)).toEqual([
      'waived',
      'waived',
    ]);
    expect(run.keys['PROJ-26'].preconditions.map((p: { decision: string | null }) => p.decision)).toEqual([null, null]);
    expect(r.out).toMatchObject({ ask: true });
  });
});

describe('gate.mjs answer + decide — run only on a recorded answer that still matches', { timeout: 30_000 }, () => {
  function runGate(name: string, ...keys: ReturnType<typeof planned>[]) {
    const out = join(dir, `${name}.json`);
    const files = keys.map((k, i) => sealed(`${name}-${i}.json`, k));
    const r = gate(['merge', '--out', out, ...files]);
    expect(r.status, r.stderr).toBe(0);
    return out;
  }
  function current(name: string, g: ReturnType<typeof planned>, statuses: Record<string, string>) {
    return write(`${name}-current.json`, { env: g.env, inputs: g.inputs, statuses });
  }

  it('no answer yet → ask, and no case runs', () => {
    const g = planned('PROJ-30');
    const run = runGate('d-none', g);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-30',
      '--current',
      current('d-none', g, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status).toBe(3);
    expect(r.out).toMatchObject({ action: 'ask', runCases: [] });
    expect(String(r.out.reason)).toContain('unanswered: P1,P2');
  });

  it('waived → those cases are blocked with the precondition and who waived it; the rest run', () => {
    const g = planned('PROJ-31');
    const run = runGate('d-waive', g);
    const a = gate([
      'answer',
      '--gate',
      run,
      '--key',
      'PROJ-31',
      '--decision',
      'waived',
      '--by',
      'U_REQ',
      '--ref',
      '171.2',
    ]);
    expect(a.status, a.stderr).toBe(0);
    const saved = JSON.parse(readFileSync(run, 'utf8'));
    expect(saved.status).toBe('answered');
    expect(saved.keys['PROJ-31'].preconditions[0]).toMatchObject({
      decision: 'waived',
      confirmedBy: 'U_REQ',
      confirmRef: '171.2',
    });
    expect(saved.keys['PROJ-31'].preconditions[0].confirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-31',
      '--current',
      current('d-waive', g, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ action: 'run', runCases: ['QA-3'] });
    expect(r.out.blockedCases).toEqual([
      { id: 'QA-1', precondition: 'P1', reason: 'precondition-waived:P1 by U_REQ' },
      { id: 'QA-2', precondition: 'P2', reason: 'precondition-waived:P2 by U_REQ' },
    ]);
  });

  it('provided and now met → every case runs (a flip to met is the expected resume, not a new gap)', () => {
    const g = planned('PROJ-32');
    const run = runGate('d-prov', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-32', '--decision', 'provided', '--by', 'U_REQ', '--ref', '1.2']);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-32',
      '--current',
      current('d-prov', g, { P1: 'met', P2: 'provisionable' }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ action: 'run', runCases: ['QA-1', 'QA-2', 'QA-3'], blockedCases: [] });
  });

  it('provided but still missing → ask again (a promise is not a precondition)', () => {
    const g = planned('PROJ-33');
    const run = runGate('d-still', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-33', '--decision', 'provided', '--by', 'U_REQ', '--ref', '1.3']);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-33',
      '--current',
      current('d-still', g, { P1: 'met', P2: 'missing' }),
    ]);
    expect(r.status).toBe(3);
    expect(r.out).toMatchObject({ action: 'ask' });
    expect(String(r.out.reason)).toContain('still missing: P2');
  });

  it('waived but now met → the case runs for real (running beats waiving)', () => {
    const g = planned('PROJ-41');
    const run = runGate('d-waive-met', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-41', '--decision', 'waived', '--by', 'U_REQ', '--ref', '1.8']);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-41',
      '--current',
      current('d-waive-met', g, { P1: 'met', P2: 'missing' }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ action: 'run', runCases: ['QA-1', 'QA-3'] });
    expect(r.out.blockedCases).toEqual([{ id: 'QA-2', precondition: 'P2', reason: 'precondition-waived:P2 by U_REQ' }]);
  });

  it('skipped → the key is skipped with who skipped it', () => {
    const g = planned('PROJ-34');
    const run = runGate('d-skip', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-34', '--decision', 'skipped', '--by', 'U_REQ', '--ref', '1.4']);
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-34',
      '--current',
      current('d-skip', g, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ action: 'skip', reason: 'precondition-skipped by U_REQ', runCases: [] });
  });

  it('stale consent: the deployed SHA changed after the answer → ask again, nothing runs', () => {
    const g = planned('PROJ-35');
    const run = runGate('d-stale', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-35', '--decision', 'waived', '--by', 'U_REQ', '--ref', '1.5']);
    const moved = { ...g, inputs: { ...g.inputs, deployedShas: ['acme/app:ccccccc'] } };
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-35',
      '--current',
      current('d-stale', moved, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status).toBe(3);
    expect(r.out).toMatchObject({ action: 'ask', runCases: [] });
    expect(String(r.out.reason)).toContain('inputs changed: deployedShas');
  });

  it('a workflow-owned change (issue status, updated time) does not invalidate the answer', () => {
    const g = planned('PROJ-36');
    const run = runGate('d-owned', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-36', '--decision', 'waived', '--by', 'U_REQ', '--ref', '1.6']);
    const moved = {
      ...g,
      inputs: { ...g.inputs, issue: { ...g.inputs.issue, status: 'QA', updated: '2026-10-30T10:00:00Z' } },
    };
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-36',
      '--current',
      current('d-owned', moved, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ action: 'run', runCases: ['QA-3'] });
  });

  it('a key that is not in the gate → ask (newly discovered scope is never pre-consented)', () => {
    const g = planned('PROJ-37');
    const run = runGate('d-new', g);
    gate(['answer', '--gate', run, '--key', 'all', '--decision', 'waived', '--by', 'U_REQ', '--ref', '1.7']);
    const other = planned('PROJ-38');
    const r = gate(['decide', '--gate', run, '--key', 'PROJ-38', '--current', current('d-new', other, {})]);
    expect(r.status).toBe(3);
    expect(String(r.out.reason)).toContain('not in gate');
  });

  it('refuses an unknown decision and never accepts a wildcard precondition list', () => {
    const run = runGate('d-bad', planned('PROJ-39'));
    expect(
      gate(['answer', '--gate', run, '--key', 'PROJ-39', '--decision', 'maybe', '--by', 'U', '--ref', '1']).status,
    ).toBe(1);
    expect(
      gate([
        'answer',
        '--gate',
        run,
        '--key',
        'PROJ-39',
        '--ids',
        '*',
        '--decision',
        'waived',
        '--by',
        'U',
        '--ref',
        '1',
      ]).status,
    ).toBe(1);
    expect(JSON.parse(readFileSync(run, 'utf8')).status).toBe('pending');
  });

  it('answer requires who answered and where', () => {
    const run = runGate('d-who', planned('PROJ-40'));
    expect(gate(['answer', '--gate', run, '--key', 'PROJ-40', '--decision', 'waived']).status).toBe(1);
    expect(existsSync(run)).toBe(true);
  });

  // Review findings on PR #589 (trinity code-review gate).
  it('a gate edited after sealing is never run under the old answer', () => {
    const g = planned('PROJ-42');
    const run = runGate('d-edit', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-42', '--decision', 'waived', '--by', 'U_REQ', '--ref', '2.1']);
    const saved = JSON.parse(readFileSync(run, 'utf8'));
    saved.keys['PROJ-42'].plan.cases[0].assertion = 'anything goes';
    saved.keys['PROJ-42'].plan.cases.push({
      id: 'QA-9',
      type: 'edge',
      severity: 'P1',
      desc: 'added later',
      assertion: 'x',
      preconditions: [],
    });
    writeFileSync(run, JSON.stringify(saved));
    const r = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-42',
      '--current',
      current('d-edit', g, { P1: 'missing', P2: 'missing' }),
    ]);
    expect(r.status).toBe(3);
    expect(r.out).toMatchObject({ action: 'ask', runCases: [] });
    expect(String(r.out.reason)).toContain('gate edited after sealing');
  });

  it('a current file without env or inputs, or without a status for every precondition, is refused (never fail-open)', () => {
    const g = planned('PROJ-43');
    const run = runGate('d-partial', g);
    gate(['answer', '--gate', run, '--key', 'PROJ-43', '--decision', 'waived', '--by', 'U_REQ', '--ref', '2.2']);
    const onlyStatuses = write('d-partial-cur1.json', { statuses: { P1: 'missing', P2: 'missing' } });
    const r1 = gate(['decide', '--gate', run, '--key', 'PROJ-43', '--current', onlyStatuses]);
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain('--current needs env, inputs and statuses');
    const r2 = gate([
      'decide',
      '--gate',
      run,
      '--key',
      'PROJ-43',
      '--current',
      current('d-partial', g, { P1: 'missing' }),
    ]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('statuses missing or invalid for: P2');
  });

  it('refuses a one-sided precondition mapping (a case that lists P1 must be in P1.cases, and back)', () => {
    const g = planned('PROJ-44');
    g.plan.cases[2].preconditions = ['P1'];
    const p = write('asym.json', g);
    const r = gate(['seal', p]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('case QA-3 lists P1 but P1.cases does not list QA-3');
  });

  it('answer with nothing to answer for that key fails instead of reporting success', () => {
    const g = planned('PROJ-45');
    g.preconditions = g.preconditions.map((x) => ({ ...x, status: 'met' }));
    const run = runGate('d-nothing', g);
    const r = gate([
      'answer',
      '--gate',
      run,
      '--key',
      'PROJ-45',
      '--decision',
      'waived',
      '--by',
      'U_REQ',
      '--ref',
      '2.3',
    ]);
    expect(r.status).toBe(1);
  });
});
