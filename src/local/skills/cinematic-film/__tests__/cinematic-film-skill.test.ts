import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const read = (...p: string[]) => readFileSync(resolve(SKILL_ROOT, ...p), 'utf8');

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (key) out[key] = line.slice(colon + 1).trim();
  }
  return out;
}

describe('cinematic-film skill — contract', () => {
  it('SKILL.md has frontmatter name cinematic-film and a trigger-bearing description', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    const fm = parseFrontmatter(read('SKILL.md'));
    expect(fm.name).toBe('cinematic-film');
    expect(fm.description).toMatch(/cinematic/i);
    expect(fm.description).toMatch(/시네마틱/);
    expect(fm.description).toMatch(/depth of field|out-of-focus|아웃오브포커스/i);
  });

  it('states the look as rules: fixed blur levels, moving focus masks, oversampled plane, beat cuts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/never animate the blur radius/i);
    expect(md).toMatch(/oversampl/i);
    expect(md).toMatch(/rack/i);
    expect(md).toMatch(/beat/i);
    expect(md).toMatch(/-14 LUFS/);
  });

  it('carries the privacy rule: readable text is published text', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/privacy/i);
    expect(md).toMatch(/every readable/i);
  });

  it('requires an independent review loop until SHIP', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/independent review/i);
    expect(md).toMatch(/SHIP/);
    expect(existsSync(resolve(SKILL_ROOT, 'references', 'review-rubric.md'))).toBe(true);
  });

  it('ships the rig, the cut/GIF/mix scripts and the example film it describes', () => {
    for (const f of [
      'templates/remotion/Plate.tsx.template',
      'templates/remotion/Film.example.tsx.template',
      'scripts/cut.py',
      'scripts/make_gif.py',
      'scripts/mix_audio.py',
      'references/review-rubric.md',
    ]) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
    }
    const plate = read('templates', 'remotion', 'Plate.tsx.template');
    // self-contained: no import from a project-specific lib path
    expect(plate).not.toMatch(/from '\.\.\/lib\//);
    expect(plate).toMatch(/export const Plate/);
  });

  it('ships the device look: its rules, the phone templates and the capture/cut scripts', () => {
    const md = read('SKILL.md');
    expect(md).toMatch(/device look/i);
    expect(md).toMatch(/iPhone/);
    expect(md).toMatch(/references\/device-demo\.md/);
    expect(md).toMatch(/cinetic/);
    const fm = parseFrontmatter(md);
    expect(fm.description).toMatch(/아이폰 목업|iPhone mockup/);
    for (const f of [
      'references/device-demo.md',
      'templates/remotion/device/Device.tsx.template',
      'templates/remotion/device/Keyboard.tsx.template',
      'templates/remotion/device/hangul.ts.template',
      'templates/remotion/device/Touch.tsx.template',
      'templates/remotion/device/Caption.tsx.template',
      'templates/remotion/device/Safari.tsx.template',
      'templates/remotion/device/Slack.tsx.template',
      'templates/remotion/device/tokens.ts.template',
      'templates/remotion/device/PhoneFilm.example.tsx.template',
      'scripts/mobile_capture.cjs',
      'scripts/cut_phone.py',
    ]) {
      expect(existsSync(resolve(SKILL_ROOT, f)), f).toBe(true);
    }
    for (const f of [
      'Device.tsx',
      'Keyboard.tsx',
      'Touch.tsx',
      'Caption.tsx',
      'Safari.tsx',
      'Slack.tsx',
      'PhoneFilm.example.tsx',
    ]) {
      expect(read('templates', 'remotion', 'device', `${f}.template`), f).not.toMatch(/from '\.\.\/lib\//);
    }
    const ref = read('references', 'device-demo.md');
    expect(ref).toMatch(/60 fps/);
    expect(ref).toMatch(/-14 LUFS/);
    expect(ref).toMatch(/Mock only what cannot be recorded/);
  });

  it('types Hangul jamo by jamo on the 2-set keyboard (hangul.ts.template)', () => {
    const src = read('templates', 'remotion', 'device', 'hangul.ts.template');
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    new Function('module', 'exports', js)(mod, mod.exports);
    const presses = mod.exports.presses as (
      t: string,
    ) => Array<{ key: string; layout: string; shift: boolean; text: string }>;
    // 읽 = ㅇ ㅣ ㄹ ㄱ, composing in place
    expect(presses('읽').map((p) => p.key)).toEqual(['ㅇ', 'ㅣ', 'ㄹ', 'ㄱ']);
    expect(presses('읽').map((p) => p.text)).toEqual(['ㅇ', '이', '일', '읽']);
    // 와 = ㅇ ㅗ ㅏ (a compound vowel is two keys); 쌀 starts with shift + ㅅ
    expect(presses('와').map((p) => p.key)).toEqual(['ㅇ', 'ㅗ', 'ㅏ']);
    expect(presses('쌀')[0]).toMatchObject({ key: 'ㅅ', shift: true });
    // Latin switches to the English rows (capitals with shift); punctuation to 123
    expect(presses('A.').map((p) => [p.key, p.layout, p.shift])).toEqual([
      ['a', 'en', true],
      ['.', 'num', false],
    ]);
    expect(presses('세 줄').at(-1)?.text).toBe('세 줄');
  });

  const hasPython = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!hasPython)(
    'cut_phone.py maps take markers to film frames (speed, offsets, swipe ends, extra taps)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cut-phone-'));
      mkdirSync(join(dir, 'takes', 't1'), { recursive: true });
      const marks = [
        { ts: 100, name: 'rec-start' },
        { ts: 101.5, name: 'swipe', x: 196, y: 420, dy: 300 },
        { ts: 102, name: 'tap', what: 'open', x: 120.04, y: 300 },
        { ts: 102.2, name: 'key', ch: '요' },
        { ts: 102.5, name: 'swipe-end' },
        { ts: 104, name: 'tap', what: 'outside', x: 1, y: 1 },
      ];
      writeFileSync(join(dir, 'takes', 't1', 'markers.jsonl'), `${marks.map((m) => JSON.stringify(m)).join('\n')}\n`);
      const shot = {
        id: 's1',
        take: 't1',
        t0: 1,
        t1: 3,
        speed: 2,
        vh: 716,
        drop: [[1.1, 1.2]],
        extra: [{ t: 2.5, x: 350, y: 26, what: 'close' }],
      };
      writeFileSync(join(dir, 'shots.json'), JSON.stringify({ fps: 60, shots: [shot] }));
      const gen = join(dir, 'shots.gen.ts');
      const args = [
        resolve(SKILL_ROOT, 'scripts', 'cut_phone.py'),
        join(dir, 'shots.json'),
        '--takes',
        join(dir, 'takes'),
      ];
      const r = spawnSync('python3', [...args, '--public', join(dir, 'pub'), '--gen', gen, '--events-only'], {
        encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      const ts = readFileSync(gen, 'utf8');
      const table = JSON.parse(ts.slice(ts.indexOf('Record<string, Shot> = ') + 23, ts.lastIndexOf(';')));
      const s1 = table.s1;
      // 2 s of source at speed 2 = 1 s of film = 60 frames; source time t lands at (t - t0) / speed * 60
      expect(s1.dur).toBe(60);
      expect(s1.ev).toEqual(
        expect.arrayContaining([
          { f: 15, k: 'swipe', x: 196, y: 420, dy: 300, to: 45 },
          { f: 30, k: 'tap', x: 120, y: 300, what: 'open' },
          { f: 36, k: 'key', ch: '요' },
          { f: 45, k: 'tap', x: 350, y: 26, what: 'close' },
        ]),
      );
      expect(s1.ev.some((e: { what?: string }) => e.what === 'outside')).toBe(false);
      // cut-only fields never reach the film's Shot type
      expect(s1).not.toHaveProperty('drop');
      expect(s1).not.toHaveProperty('extra');
      expect(s1).not.toHaveProperty('take');
    },
  );

  it('names the Remotion license condition instead of hiding it', () => {
    expect(read('SKILL.md')).toMatch(/Remotion.*licen[cs]e/i);
  });
});
