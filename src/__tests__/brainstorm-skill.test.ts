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

const readPluginFile = (file: string) => fs.readFileSync(file, 'utf8');

function pluginFrontmatter(file: string): Record<string, string> {
  const fm = readPluginFile(file).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

const instructionsOf = (file: string) => readPluginFile(file).replace(/^---\n[\s\S]*?\n---\n/, '');

describe('T1 — the brainstorm skill exists and is callable', () => {
  it('has a SKILL.md named brainstorm with Korean and English triggers', () => {
    expect(fs.existsSync(skillFile)).toBe(true);
    const fm = pluginFrontmatter(skillFile);
    expect(fm.name).toBe('brainstorm');
    expect(fm.description).toMatch(/brainstorm/);
    expect(fm.description).toMatch(/브레인스토밍/);
  });

  it('stays under the 10 KB authoring limit', () => {
    expect(fs.statSync(skillFile).size).toBeLessThanOrEqual(10 * 1024);
  });

  it('makes no soma-work harness call (the plugin also runs outside soma-work)', () => {
    expect(readPluginFile(skillFile)).not.toMatch(/ASK_USER_QUESTION|UPDATE_SESSION|GET_SESSION|mcp__model-command/);
  });
});

describe('T2 — luna low and haiku low subagents generate', () => {
  it.each([
    ['brainstorm-luna', 'luna'],
    ['brainstorm-haiku', 'haiku'],
  ])('agent %s exists with model %s, effort low and Write as its only tool', (agent, model) => {
    const file = path.join(agentsDir, `${agent}.md`);
    expect(fs.existsSync(file)).toBe(true);
    const fm = pluginFrontmatter(file);
    expect(fm.model).toBe(model);
    expect(fm.effort).toBe('low');
    const tools = readPluginFile(file).match(/^tools:\n((?:\s+- .*\n)+)/m)?.[1] ?? '';
    expect(tools.trim()).toBe('- Write');
  });

  it('gives both generators the same instructions (only the engine differs)', () => {
    expect(instructionsOf(path.join(agentsDir, 'brainstorm-luna.md'))).toBe(
      instructionsOf(path.join(agentsDir, 'brainstorm-haiku.md')),
    );
  });

  it('keeps generators isolated: generate only, spawn nothing, judge nothing', () => {
    const text = instructionsOf(path.join(agentsDir, 'brainstorm-luna.md'));
    expect(text).toMatch(/스폰하지 마라/);
    expect(text).toMatch(/평가하지 마라/);
    expect(text).toMatch(/DONE <[^>]+> <[^>]+>/);
  });

  it('dispatches exactly the two generator agents, each call at effort low and in the foreground', () => {
    const skill = readPluginFile(skillFile);
    const dispatched = [...skill.matchAll(/subagent_type:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(dispatched)).toEqual(new Set(['zworkflow:brainstorm-luna', 'zworkflow:brainstorm-haiku']));
    const calls = [...skill.matchAll(/Agent\(\{[^}]*\}\)/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/effort:\s*"low"/);
      // A batch returns as a whole: no "wait for a notification without ending the turn" contradiction.
      expect(call).toMatch(/run_in_background:\s*false/);
    }
    expect(skill).not.toMatch(/턴을 끝내지 않는다/);
  });

  it('never fills a dead engine with the other one silently, and probes each engine first', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/다른 엔진으로 채우지 않는다/);
    expect(skill).toMatch(/첫 묶음은 엔진마다 칸 하나씩만/);
  });

  it('starts each run in its own folder and re-counts existing cells before skipping them on resume', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/실행마다 새 폴더다/);
    expect(skill).toMatch(/수를 채운 칸만 건너뛰고/);
  });

  it('retries a short cell only after moving its file away (a Write-only generator cannot overwrite)', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/failed\//);
    expect(skill).toMatch(/덮어쓰지 못한다/);
    expect(skill).toMatch(/merge\.mjs" "<run 폴더>" --count/);
  });
});

describe('T3 — the session model picks, the user decides', () => {
  it('states that the skill draws no conclusion and the user makes the final call', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/최종 결정은 유저/);
    expect(skill).toMatch(/결론을 내리지 않는다/);
  });

  it('keeps the whole pool on disk and hands its path to the user', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/pool\/<[^>]+>\.md/);
    expect(skill).toMatch(/dropped\.md/);
    expect(skill).toMatch(/merge\.mjs/);
  });
});

describe('T4 — hints are an input', () => {
  it('takes the hints as a named input and uses them as the picking criterion', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/^- `hints`/m);
    expect(skill).toMatch(/힌트를 몇 개 살리나/);
  });
});

describe('T5 — per-field generation and picking, with the stated defaults', () => {
  it('defaults to 300 generated and 20 picked per field, and top 100 in overall mode', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/^- `per-field`[^\n]*기본 300/m);
    expect(skill).toMatch(/^- `pick`[^\n]*기본 20/m);
    expect(skill).toMatch(/^- `top`[^\n]*100/m);
  });

  it('generates in cells of 50 and keeps the overall mode at 2,000 ideas or more', () => {
    const skill = readPluginFile(skillFile);
    expect(skill).toMatch(/칸당 50개/);
    expect(skill).toMatch(/^- `top`[^\n]*2,000 이상/m);
  });
});

// Each case starts node once or twice; a busy host needs more than the default 5 s.
describe('merge.mjs — pools, ids, dedupe and survival numbers', { timeout: 30_000 }, () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A run folder holding the given raw files. */
  function runWith(rawFiles: Record<string, string>): string {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-merge-'));
    scratch.push(run);
    fs.mkdirSync(path.join(run, 'raw'));
    for (const [name, text] of Object.entries(rawFiles)) fs.writeFileSync(path.join(run, 'raw', name), text);
    return run;
  }

  const merge = (...args: string[]) =>
    execFileSync(process.execPath, [mergeScript, ...args], { encoding: 'utf8', stdio: 'pipe' });

  const poolLines = (run: string, field: string) =>
    readPluginFile(path.join(run, 'pool', `${field}.md`))
      .split('\n')
      .filter((l) => /^[A-Z]\d+-\d{3} /.test(l));

  it('merges raw cell files into numbered per-field pools without duplicates', () => {
    expect(fs.existsSync(mergeScript)).toBe(true);
    const run = runWith({
      'A1__luna.txt': [
        '1. 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
        '- 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다.',
        '{"idea":"클릭한 지점에 잔상이 남아 다음 일섬의 배율이 된다"}',
        '',
        '   ',
      ].join('\n'),
      'A2__haiku.txt': [
        '보스가 바닥을 반으로 갈라서 왕복 경로를 끊는다',
        '보스의 그림자만 때릴 수 있는 페이즈가 있다',
      ].join('\n'),
      'B1__haiku.txt': '보스가 바닥을 반으로 갈라 왕복 경로를 끊는다\n',
    });

    const out = merge(run);

    // Exact duplicate (list marker + trailing period) and the near duplicate in A2 are both gone.
    expect(poolLines(run, 'A')).toEqual([
      'A1-001 [luna] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
      'A1-003 [luna] 클릭한 지점에 잔상이 남아 다음 일섬의 배율이 된다',
      'A2-002 [haiku] 보스의 그림자만 때릴 수 있는 페이즈가 있다',
    ]);
    // Dedupe is per field: the same idea in field B stays.
    expect(poolLines(run, 'B')).toEqual(['B1-001 [haiku] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다']);

    const stats = JSON.parse(readPluginFile(path.join(run, 'stats.json')));
    expect(stats.engines.luna).toEqual({ generated: 3, kept: 2 });
    expect(stats.engines.haiku).toEqual({ generated: 3, kept: 2 });
    expect(stats.fields.A).toEqual({ generated: 5, kept: 3 });
    expect(stats.total).toEqual({ generated: 6, kept: 4 });
    expect(out).toMatch(/6 → 4/);

    // Nothing vanishes silently: each dropped line names the id it repeats.
    const dropped = readPluginFile(path.join(run, 'dropped.md'));
    expect(dropped).toContain('A1-002 [luna] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다 ← A1-001');
    expect(dropped).toContain('A2-001 [haiku] 보스가 바닥을 반으로 갈라서 왕복 경로를 끊는다 ← A1-001');
  });

  it('numbers an idea by its line in the raw file, also past blank lines, fences and lead-ins', () => {
    const run = runWith({
      'A1__haiku.txt': [
        '아이디어 50개:',
        '',
        '```',
        '첫째 발상은 얼음 바닥이다',
        '',
        '둘째 발상은 거울 기둥이다',
        '```',
      ].join('\n'),
    });
    merge(run);
    expect(poolLines(run, 'A')).toEqual([
      'A1-004 [haiku] 첫째 발상은 얼음 바닥이다',
      'A1-006 [haiku] 둘째 발상은 거울 기둥이다',
    ]);
  });

  it('reads lens numbers past 9 and keeps a JSON line that has no idea key', () => {
    const run = runWith({
      'A9__luna.txt': '아홉째 관점의 발상이다\n',
      'A10__haiku.txt': '{"text":"열째 관점의 전혀 다른 생각"}\n',
    });
    merge(run);
    expect(poolLines(run, 'A')).toEqual([
      'A10-001 [haiku] {"text":"열째 관점의 전혀 다른 생각"}',
      'A9-001 [luna] 아홉째 관점의 발상이다',
    ]);
    expect(readPluginFile(path.join(run, 'pool', 'A.md'))).toMatch(/Lenses: 10, 9\./);
  });

  it('counts ideas per raw file with --count, ignoring blank lines and the DONE line', () => {
    const run = runWith({ 'A1__luna.txt': '하나의 생각\n\n또 하나의 생각\nDONE /x/y 2\n' });
    expect(merge(run, '--count').trim()).toBe('A1__luna.txt 2');
    expect(merge('--count', run).trim()).toBe('A1__luna.txt 2');
    expect(fs.existsSync(path.join(run, 'pool'))).toBe(false);
  });

  it('honours --threshold: at 1 only the exact duplicate goes, and bad values are refused', () => {
    const run = runWith({
      'A1__luna.txt': '보스가 바닥을 반으로 갈라 왕복 경로를 끊는다\n보스가 바닥을 반으로 갈라 왕복 경로를 끊는다.\n',
      'A2__haiku.txt': '보스가 바닥을 반으로 갈라서 왕복 경로를 끊는다\n',
    });
    merge(run, '--threshold', '1');
    expect(poolLines(run, 'A')).toEqual([
      'A1-001 [luna] 보스가 바닥을 반으로 갈라 왕복 경로를 끊는다',
      'A2-001 [haiku] 보스가 바닥을 반으로 갈라서 왕복 경로를 끊는다',
    ]);
    merge(run);
    expect(poolLines(run, 'A')).toHaveLength(1);
    for (const bad of ['0', '1.1', 'abc']) {
      expect(() => merge(run, '--threshold', bad)).toThrow(/merge: --threshold must be a number/);
    }
    expect(() => merge(run, '--threshold')).toThrow(/merge: --threshold must be a number/);
  });

  it('removes the pool of a field whose raw files are gone', () => {
    const run = runWith({ 'A1__luna.txt': '남는 분야의 생각\n', 'B1__luna.txt': '사라질 분야의 생각\n' });
    merge(run);
    fs.unlinkSync(path.join(run, 'raw', 'B1__luna.txt'));
    merge(run);
    expect(fs.readdirSync(path.join(run, 'pool'))).toEqual(['A.md']);
  });

  it.each([
    ['no raw files', {}],
    ['two raw files in one cell', { 'A1__luna.txt': '하나\n', 'A1__haiku.txt': '둘\n' }],
    ['a raw file with an unexpected name', { 'A1__luna__2.txt': '하나\n' }],
  ])('fails loudly on %s', (_label, rawFiles) => {
    const run = runWith(rawFiles);
    expect(() => merge(run)).toThrow(/merge: /);
  });

  it('fails with a plain message when labels.json is broken', () => {
    const run = runWith({ 'A1__luna.txt': '하나의 생각\n' });
    fs.writeFileSync(path.join(run, 'labels.json'), '{broken');
    expect(() => merge(run)).toThrow(/merge: labels\.json is not valid JSON/);
  });
});
