/**
 * Contract: the `brainstorm` skill (issue #1122).
 *
 * Cheap engines generate wide, the session model picks, the user decides.
 *
 * SSOT-TASK-TREE mapping:
 *   T1 — the skill exists and is callable
 *   T2 — luna low + haiku low subagents do the mass generation
 *   T3 — the session model returns the top picks; the user makes the final call
 *   T4 — the user's hints are an input and drive generation and picking
 *   T5 — generation and picking run per field
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginRoot = path.join(repoRoot, 'src', 'local');
const skillDir = path.join(pluginRoot, 'skills', 'brainstorm');
const skillFile = path.join(skillDir, 'SKILL.md');
const mergeScript = path.join(skillDir, 'scripts', 'merge.mjs');
const agentsDir = path.join(pluginRoot, 'agents');

const read = (file: string) => fs.readFileSync(file, 'utf8');

function frontmatter(file: string): Record<string, string> {
  const fm = read(file).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const body = (file: string) => read(file).replace(/^---\n[\s\S]*?\n---\n/, '');

describe('T1 — the brainstorm skill exists and is callable', () => {
  it('has a SKILL.md named brainstorm with Korean and English triggers', () => {
    expect(fs.existsSync(skillFile)).toBe(true);
    const fm = frontmatter(skillFile);
    expect(fm.name).toBe('brainstorm');
    expect(fm.description).toMatch(/brainstorm/);
    expect(fm.description).toMatch(/브레인스토밍/);
  });

  it('stays under the 10 KB authoring limit', () => {
    expect(fs.statSync(skillFile).size).toBeLessThanOrEqual(10 * 1024);
  });

  it('makes no soma-work harness call (the plugin also runs outside soma-work)', () => {
    expect(read(skillFile)).not.toMatch(/ASK_USER_QUESTION|UPDATE_SESSION|GET_SESSION|mcp__model-command/);
  });
});

describe('T2 — luna low and haiku low subagents generate', () => {
  it.each([
    ['brainstorm-luna', 'luna'],
    ['brainstorm-haiku', 'haiku'],
  ])('agent %s exists with model %s, effort low and Write as its only tool', (agent, model) => {
    const file = path.join(agentsDir, `${agent}.md`);
    expect(fs.existsSync(file)).toBe(true);
    const fm = frontmatter(file);
    expect(fm.model).toBe(model);
    expect(fm.effort).toBe('low');
    const tools = read(file).match(/^tools:\n((?:\s+- .*\n)+)/m)?.[1] ?? '';
    expect(
      tools
        .trim()
        .split('\n')
        .map((l) => l.trim()),
    ).toEqual(['- Write']);
  });

  it('gives both generators the same instructions (only the engine differs)', () => {
    expect(body(path.join(agentsDir, 'brainstorm-luna.md'))).toBe(body(path.join(agentsDir, 'brainstorm-haiku.md')));
  });

  it('keeps generators isolated: generate only, spawn nothing, judge nothing', () => {
    const text = body(path.join(agentsDir, 'brainstorm-luna.md'));
    expect(text).toMatch(/스폰하지 마라/);
    expect(text).toMatch(/평가하지 마라/);
    expect(text).toMatch(/DONE <[^>]+> <[^>]+>/);
  });

  it('dispatches exactly the two generator agents, each call at effort low', () => {
    const skill = read(skillFile);
    const dispatched = [...skill.matchAll(/subagent_type:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(dispatched)).toEqual(new Set(['zworkflow:brainstorm-luna', 'zworkflow:brainstorm-haiku']));
    const calls = [...skill.matchAll(/Agent\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/effort:\s*"low"/);
  });

  it('never fills a dead engine with the other one silently', () => {
    expect(read(skillFile)).toMatch(/다른 엔진으로 채우지 않는다/);
  });
});

describe('T3 — the session model picks, the user decides', () => {
  it('states that the skill draws no conclusion and the user makes the final call', () => {
    const skill = read(skillFile);
    expect(skill).toMatch(/최종 결정은 유저/);
    expect(skill).toMatch(/결론을 내리지 않는다/);
  });

  it('keeps the whole pool on disk and hands its path to the user', () => {
    const skill = read(skillFile);
    expect(skill).toMatch(/pool\/<[^>]+>\.md/);
    expect(skill).toMatch(/merge\.mjs/);
  });
});

describe('T4 — hints are an input', () => {
  it('takes the hints as a named input and uses them as the picking criterion', () => {
    const skill = read(skillFile);
    expect(skill).toMatch(/^- `hints`/m);
    expect(skill).toMatch(/힌트를 몇 개 살리나/);
  });
});

describe('T5 — per-field generation and picking, with the stated defaults', () => {
  it('defaults to 300 generated and 20 picked per field, and top 100 in overall mode', () => {
    const skill = read(skillFile);
    expect(skill).toMatch(/^- `per-field`[^\n]*기본 300/m);
    expect(skill).toMatch(/^- `pick`[^\n]*기본 20/m);
    expect(skill).toMatch(/^- `top`[^\n]*100/m);
  });
});

describe('merge.mjs — pools, ids, dedupe and survival numbers', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-merge-'));
  afterAll(() => fs.rmSync(run, { recursive: true, force: true }));

  it('merges raw cell files into numbered per-field pools without duplicates', () => {
    expect(fs.existsSync(mergeScript)).toBe(true);
    const raw = path.join(run, 'raw');
    fs.mkdirSync(raw);
    fs.writeFileSync(
      path.join(raw, 'A1__luna.txt'),
      [
        '1. 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
        '- 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다.',
        '{"idea":"클릭한 지점에 잔상이 남아 다음 일섬의 배율이 된다"}',
        '',
        '   ',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(raw, 'A2__haiku.txt'),
      ['보스가 바닥을 반으로 갈라서 왕복 경로를 끊는다', '보스의 그림자만 때릴 수 있는 페이즈가 있다'].join('\n'),
    );
    fs.writeFileSync(path.join(raw, 'B1__haiku.txt'), '보스가 바닥을 반으로 갈라 왕복 경로를 끊는다\n');

    const out = execFileSync('node', [mergeScript, run], { encoding: 'utf8' });

    const poolA = read(path.join(run, 'pool', 'A.md'));
    const linesA = poolA.split('\n').filter((l) => /^[A-Z]\d-\d{3} /.test(l));
    // Exact duplicate (list marker + trailing period) and the near duplicate in A2 are both gone.
    expect(linesA).toEqual([
      'A1-001 [luna] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
      'A1-003 [luna] 클릭한 지점에 잔상이 남아 다음 일섬의 배율이 된다',
      'A2-002 [haiku] 보스의 그림자만 때릴 수 있는 페이즈가 있다',
    ]);
    // Dedupe is per field: the same idea in field B stays.
    expect(read(path.join(run, 'pool', 'B.md'))).toContain(
      'B1-001 [haiku] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
    );

    const stats = JSON.parse(read(path.join(run, 'stats.json')));
    expect(stats.engines.luna).toEqual({ generated: 3, kept: 2 });
    expect(stats.engines.haiku).toEqual({ generated: 3, kept: 2 });
    expect(stats.fields.A).toEqual({ generated: 5, kept: 3 });
    expect(stats.total).toEqual({ generated: 6, kept: 4 });
    expect(out).toMatch(/6 → 4/);
  });

  it('fails loudly when the run folder has no raw files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-empty-'));
    expect(() => execFileSync('node', [mergeScript, empty], { stdio: 'pipe' })).toThrow();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
