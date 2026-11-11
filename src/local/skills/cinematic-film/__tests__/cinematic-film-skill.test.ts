import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('names the Remotion license condition instead of hiding it', () => {
    expect(read('SKILL.md')).toMatch(/Remotion.*licen[cs]e/i);
  });
});
