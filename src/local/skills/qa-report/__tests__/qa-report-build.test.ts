import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BUILD = resolve(__dirname, '..', 'scripts', 'build.mjs');
// 1x1 PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ATTR_INJECTION = `data:image/png;base64,${PNG_B64}" onerror="alert(1)`;
const SCRIPT_BREAKOUT = '</script><img src=x onerror=alert(2)>';

interface ShotStub {
  idx: string;
  src?: string;
}

/** Run the report's own script against a minimal DOM stub; returns the markup it produced. */
function runReport(html: string) {
  const data = html.match(/<script type="application\/json" id="qa-data">([\s\S]*?)<\/script>/);
  const js = html.match(/<script>\n([\s\S]*?)<\/script>/);
  if (!data || !js) throw new Error('report is missing its data or script block');
  const nodes: Record<string, { textContent: string; innerHTML: string }> = {
    'qa-data': { textContent: data[1], innerHTML: '' },
    left: { textContent: '', innerHTML: '' },
    right: { textContent: '', innerHTML: '' },
  };
  const shots: ShotStub[] = [];
  const document = {
    getElementById: (id: string) => nodes[id],
    querySelectorAll: (sel: string) => {
      if (sel !== '#right img[data-shot]') return [];
      const found = [...nodes.right.innerHTML.matchAll(/data-shot="(\d+)"/g)].map((m) => ({
        idx: m[1],
        getAttribute: () => m[1],
      }));
      shots.push(...found);
      return found;
    },
  };
  vm.runInNewContext(js[1], { document });
  return { left: nodes.left.innerHTML, right: nodes.right.innerHTML, shots, data: data[1] };
}

let dir: string;
let shotsDir: string;

function build(input: unknown, extra: string[] = []) {
  const inPath = join(dir, `input-${Math.random().toString(36).slice(2)}.json`);
  const out = join(dir, `report-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(inPath, JSON.stringify(input));
  const run = spawnSync(process.execPath, [BUILD, '--input', inPath, '--out', out, '--shots', shotsDir, ...extra], {
    encoding: 'utf8',
  });
  return { run, out };
}

function evidenceCase(id: string, shot: string, respRaw = '{"ok":true}') {
  return {
    id,
    type: 'edge',
    severity: 'P2',
    status: 'pass',
    auth: { accountRef: 'qaEnv.accounts.player' },
    steps: ['1) open the page'],
    expected: 'renders',
    actual: 'renders',
    evidence: {
      reqResp: { method: 'POST', url: 'https://app.example.com/api/x', reqBody: '{}', status: 200, respRaw },
      shot,
    },
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa-report-build-'));
  shotsDir = join(dir, 'shots');
  mkdirSync(shotsDir);
  writeFileSync(join(shotsDir, 'real.png'), Buffer.from(PNG_B64, 'base64'));
  writeFileSync(join(shotsDir, 'fake.png'), '<svg onload="alert(3)"></svg>');
  writeFileSync(join(dir, 'outside.png'), Buffer.from(PNG_B64, 'base64'));
  symlinkSync(join(dir, 'outside.png'), join(shotsDir, 'escape.png'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('qa-report build.mjs — adversarial input', () => {
  const input = () => ({
    meta: { title: 'adversarial', ssot: SCRIPT_BREAKOUT },
    issues: [
      {
        key: 'PROJ-1',
        qaLevel: 'max',
        env: { profile: 'acme-env:post-deploy', versionStart: '1.0.0', versionEnd: '1.0.0' },
        verdict: 'partial',
        reason: SCRIPT_BREAKOUT,
        cases: [
          evidenceCase('QA-1', join(shotsDir, 'real.png'), `{"note":"${SCRIPT_BREAKOUT}","id":12345678901234567890}`),
          evidenceCase('QA-2', ATTR_INJECTION),
          evidenceCase('QA-3', join(shotsDir, 'fake.png')),
          evidenceCase('QA-4', join(dir, 'outside.png')),
          evidenceCase('QA-5', join(shotsDir, 'escape.png')),
          evidenceCase('QA-6', `data:image/png;base64,${PNG_B64}`),
          evidenceCase('QA-7', join(shotsDir, 'absent.png')),
        ],
      },
    ],
    links: {
      'PROJ-1': {
        issue: 'javascript:alert(4)',
        prs: [{ repo: 'acme/app', number: 1, url: 'javascript:alert(5)' }],
        commits: [{ repo: 'acme/app', sha: 'a1b2c3d4e5f6' }],
      },
    },
    nonQa: [{ key: 'PROJ-2', status: 'deferred', reason: 'open PR' }],
  });

  it('builds, embedding only real images from inside the screenshots directory', () => {
    const { run, out } = build(input());
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(run.stdout);
    expect(summary).toMatchObject({ keys: 2, pass: 0, fail: 0, other: 2, shots: 2, shotProblems: 5 });
    expect(summary.png).toBe(out.replace(/\.html$/, '.png'));

    const data = JSON.parse(runReport(readFileSync(out, 'utf8')).data);
    const shots = data.issues[0].cases.map((c: { evidence: { shot?: string; shotProblem?: string } }) => c.evidence);
    expect(shots[0].shot).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(shots[1].shotProblem).toMatch(/^rejected: not a base64/);
    expect(shots[2].shotProblem).toMatch(/^rejected: not a png/);
    expect(shots[3].shotProblem).toMatch(/^rejected: outside/);
    expect(shots[4].shotProblem).toMatch(/^rejected: outside/);
    expect(shots[5].shot).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(shots[6].shotProblem).toBe('missing at build time');
  });

  it('keeps every input inside the data block — no </script> breakout', () => {
    const { run, out } = build(input());
    expect(run.status, run.stderr).toBe(0);
    const html = readFileSync(out, 'utf8');
    // Exactly two closing tags: the data block and the report script.
    expect(html.match(/<\/script/gi)?.length).toBe(2);
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('\\u003c/script>\\u003cimg src=x onerror=alert(2)>');
  });

  it('sets image sources through the DOM, never in markup, and renders no javascript: links', () => {
    const { out } = build(input());
    const r = runReport(readFileSync(out, 'utf8'));
    expect(r.right).not.toMatch(/<img[^>]*\ssrc=/i);
    expect(r.right).not.toContain('onerror="alert(1)');
    expect(r.shots.map((s) => s.src)).toEqual([`data:image/png;base64,${PNG_B64}`, `data:image/png;base64,${PNG_B64}`]);
    expect(`${r.left}${r.right}`).not.toMatch(/href="javascript:/i);
    expect(r.right).toContain('no issue link');
    expect(r.right).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;');
    expect(r.right).toContain('12345678901234567890');
  });

  it('refuses duplicate keys', () => {
    const bad = input();
    bad.nonQa.push({ key: 'PROJ-1', status: 'deferred', reason: 'dup' });
    const { run } = build(bad);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('duplicate keys: PROJ-1');
  });

  it('masks secrets before they reach the report', () => {
    const withSecrets = input();
    withSecrets.issues[0].cases[0].evidence.reqResp.url = 'https://app.example.com/api/x?access_token=leak-q';
    withSecrets.issues[0].cases[0].evidence.reqResp.reqBody = 'user=bob&password=leak-f';
    const { run, out } = build(withSecrets);
    expect(run.status, run.stderr).toBe(0);
    const html = readFileSync(out, 'utf8');
    expect(html).not.toContain('leak-q');
    expect(html).not.toContain('leak-f');
    expect(JSON.parse(run.stdout).masked).toBe(2);
  });
});

/** Row class and status tag the report renders for `key`. */
function row(left: string, key: string) {
  const m = left.match(
    new RegExp(`<div class="row (\\w+)"[^>]*data-k="${key}">[\\s\\S]*?<span class="tag \\w+">([^<]*)</span>`),
  );
  return m ? { cls: m[1], status: m[2] } : undefined;
}

function passIssue(key: string, verified: boolean) {
  return {
    key,
    qaLevel: 'max',
    env: { profile: 'acme-env:post-deploy', versionStart: '1.0.0', versionEnd: '1.0.0' },
    verdict: 'pass',
    reason: '',
    statusTransition: {
      from: 'QA',
      to: 'Done',
      performed: verified,
      verified,
      reason: verified ? '' : 'state changed',
    },
    cases: [evidenceCase('QA-1', `data:image/png;base64,${PNG_B64}`)],
  };
}

describe('qa-report build.mjs — closeout outcomes', () => {
  it('uses the caller outcome for row status and counts, and keeps the qa-issue verdict as detail', () => {
    const { run, out } = build({
      issues: [passIssue('PROJ-1', true), passIssue('PROJ-2', true)],
      nonQa: [{ key: 'PROJ-3', status: 'deferred', reason: 'open PR' }],
      outcomes: {
        'PROJ-1': { outcome: 'blocked', reason: 'open PR in acme/api' },
        'PROJ-2': { outcome: 'pass', reason: '' },
        'PROJ-3': { outcome: 'deferred', reason: 'open PR acme/app#9' },
      },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ keys: 3, pass: 1, fail: 0, other: 2 });
    const r = runReport(readFileSync(out, 'utf8'));
    expect(row(r.left, 'PROJ-1')).toEqual({ cls: 'warn', status: 'blocked' });
    expect(row(r.left, 'PROJ-2')).toEqual({ cls: 'ok', status: 'pass' });
    expect(row(r.left, 'PROJ-3')).toEqual({ cls: 'warn', status: 'deferred' });
    expect(r.left).toContain('open PR in acme/api');
    expect(r.left).toContain('qa-issue verdict pass');
    expect(r.left).toContain('open PR acme/app#9');
  });

  it('standalone: a pass whose transition is not verified is "pass (not moved)" and not counted as pass', () => {
    const { run, out } = build({ issues: [passIssue('PROJ-1', false), passIssue('PROJ-2', true)] });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ keys: 2, pass: 1, fail: 0, other: 1 });
    const r = runReport(readFileSync(out, 'utf8'));
    expect(row(r.left, 'PROJ-1')).toEqual({ cls: 'warn', status: 'pass (not moved)' });
    expect(row(r.left, 'PROJ-2')).toEqual({ cls: 'ok', status: 'pass' });
    expect(r.right).toContain('PROJ-1');
  });

  // deploy-qa without the QA lock QA's nothing: no qa-issue JSON exists, so the input has no issues.
  it("builds a report with no QA'd issue: every key a nonQa row", () => {
    const { run, out } = build({
      meta: { repo: 'acme/app', target: 'deploy/staging', status: 'deployed, QA incomplete: QA lock unavailable' },
      issues: [],
      nonQa: [
        { key: 'PROJ-1', status: 'not-run', reason: 'QA lock unavailable' },
        { key: 'PROJ-2', status: 'report-only', reason: 'docs only' },
      ],
      outcomes: {
        'PROJ-1': { outcome: 'not-run', reason: 'QA lock unavailable' },
        'PROJ-2': { outcome: 'report-only', reason: 'docs only' },
      },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ keys: 2, pass: 0, fail: 0, other: 2 });
    const r = runReport(readFileSync(out, 'utf8'));
    expect(row(r.left, 'PROJ-1')?.status).toBe('not-run');
    expect(row(r.left, 'PROJ-2')?.status).toBe('report-only');
    expect(r.left).toContain('QA lock unavailable');
    expect(r.right).toContain('PROJ-1');
  });

  it('refuses outcomes for keys that have no row', () => {
    const { run } = build({
      issues: [passIssue('PROJ-1', true)],
      outcomes: { 'PROJ-9': { outcome: 'pass', reason: '' } },
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('outcomes for keys with no row: PROJ-9');
  });
});

/**
 * Preconditions lead the report: what was missing, which cases it blocked, and who
 * decided what — so "QA could not be done properly because…" is the first thing a
 * reader sees instead of a column of PARTIAL rows (2026-10-30 stage0: 49 of 69
 * non-pass cases were precondition gaps).
 */
describe('qa-report build.mjs — preconditions first', { timeout: 30_000 }, () => {
  const pre = (key: string, decision: string | null, status = 'missing', by: string | null = 'U_REQ') => ({
    key,
    id: 'P1',
    kind: 'write-permission',
    need: 'place a bet as the test player',
    cases: ['QA-1'],
    status,
    decision,
    confirmedBy: decision && decision !== 'pending' ? by : null,
    confirmedAt: decision && decision !== 'pending' ? '2026-10-30T01:00:00Z' : null,
  });

  it('waiting: no case ran, every key not-run, the gap table and the pending decision lead', () => {
    const { run, out } = build({
      meta: {
        repo: 'acme/app',
        target: 'deploy/staging',
        status: 'deployed, QA incomplete: waiting for precondition confirmation',
      },
      issues: [],
      nonQa: [{ key: 'PROJ-1', status: 'not-run', reason: 'waiting for precondition confirmation' }],
      outcomes: { 'PROJ-1': { outcome: 'not-run', reason: 'waiting for precondition confirmation' } },
      preconditions: [pre('PROJ-1', 'pending')],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ keys: 1, pass: 0, preconditions: 1, preconditionsOpen: 1 });
    const r = runReport(readFileSync(out, 'utf8'));
    const head = r.left.indexOf('<h2>Preconditions');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(r.left.indexOf('class="kpis"'));
    expect(r.left).toContain('waiting for the requester');
    expect(r.left).toContain('place a bet as the test player');
    expect(r.left).toContain('QA-1');
  });

  it('resumed waiver: the waived case stays in the counts as blocked and names who waived it', () => {
    const issue = {
      key: 'PROJ-2',
      qaLevel: 'max',
      env: { profile: 'acme-env:post-deploy', versionStart: '1.0.0', versionEnd: '1.0.0' },
      verdict: 'partial',
      reason: 'precondition-waived:P1 by U_REQ',
      preconditions: [{ ...pre('PROJ-2', 'waived'), key: undefined }],
      cases: [
        {
          id: 'QA-1',
          type: 'happy',
          severity: 'P1',
          status: 'blocked',
          precondition: 'P1',
          auth: { accountRef: 'qaEnv.accounts.player' },
          steps: ['1) not run'],
          expected: 'bet expires and the notice shows',
          actual: 'precondition-waived:P1 by U_REQ',
        },
        evidenceCase('QA-2', `data:image/png;base64,${PNG_B64}`),
      ],
    };
    const { run, out } = build({ issues: [issue] });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      keys: 1,
      pass: 0,
      other: 1,
      preconditions: 1,
      preconditionsOpen: 1,
    });
    const r = runReport(readFileSync(out, 'utf8'));
    expect(r.left).toContain('waived by U_REQ');
    expect(r.left).toContain('PROJ-2');
    expect(row(r.left, 'PROJ-2')?.status).toBe('partial');
    expect(r.right).toContain('precondition P1');
  });

  it('skipped key: deferred row, and the gap shows the skip decision', () => {
    const { run, out } = build({
      issues: [],
      nonQa: [{ key: 'PROJ-3', status: 'deferred', reason: 'precondition-skipped by U_REQ' }],
      outcomes: { 'PROJ-3': { outcome: 'deferred', reason: 'precondition-skipped by U_REQ' } },
      preconditions: [pre('PROJ-3', 'skipped')],
    });
    expect(run.status, run.stderr).toBe(0);
    const r = runReport(readFileSync(out, 'utf8'));
    expect(row(r.left, 'PROJ-3')?.status).toBe('deferred');
    expect(r.left).toContain('skipped by U_REQ');
  });

  it('a precondition that was provided and is met is listed as resolved and not open', () => {
    const { run, out } = build({
      issues: [passIssue('PROJ-4', true)],
      preconditions: [pre('PROJ-4', 'provided', 'met')],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ preconditions: 1, preconditionsOpen: 0 });
    expect(runReport(readFileSync(out, 'utf8')).left).toContain('provided by U_REQ');
  });

  it('refuses a precondition for a key that has no row', () => {
    const { run } = build({ issues: [passIssue('PROJ-5', true)], preconditions: [pre('PROJ-9', 'waived')] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('preconditions for keys with no row: PROJ-9');
  });
});
