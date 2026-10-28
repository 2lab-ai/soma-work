import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');
const BUNDLED = [
  'templates/scene-dialog.js',
  'templates/base.css',
  'adapters/claude-motion.md',
  'adapters/headless/render.mjs',
  'adapters/headless/player.html',
  'adapters/headless/package.json',
  'adapters/headless/README.md',
];

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (key) out[key] = value;
  }
  return out;
}

function readSkill(): string {
  return readFileSync(SKILL_MD, 'utf8');
}

describe('local:dimensional-drawing-motion skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter names the skill and carries EN + KO triggers', () => {
    const fm = parseFrontmatter(readSkill());
    expect(fm.name).toBe('dimensional-drawing-motion');
    expect(fm.license).toBe('MIT');
    const desc = fm.description ?? '';
    expect(desc).toMatch(/motion|film|animate/i);
    expect(desc).toMatch(/dimensional drawing/i);
    expect(desc).toMatch(/도면/);
  });

  it('every template and adapter the skill points at is bundled', () => {
    const md = readSkill();
    for (const rel of BUNDLED) {
      expect({ rel, exists: existsSync(resolve(SKILL_ROOT, rel)) }).toEqual({ rel, exists: true });
    }
    expect(md).toContain('templates/scene-dialog.js');
    expect(md).toContain('templates/base.css');
    expect(md).toContain('adapters/headless');
  });

  it('keeps the pure-function-of-time scene contract', () => {
    const md = readSkill();
    expect(md).toMatch(/pure function of time/i);
    expect(md).toContain('render(t)');
    expect(readFileSync(resolve(SKILL_ROOT, 'templates/scene-dialog.js'), 'utf8')).toContain('render(t)');
  });

  it('keeps the strokes-before-fills rule that prevents white flashes', () => {
    expect(readSkill()).toMatch(/Strokes first, fills after/i);
  });

  it('makes the headless adapter the soma-work path and forbids installing into the plugin dir', () => {
    const md = readSkill();
    expect(md).toMatch(/soma-work/);
    expect(md).toContain('$CLAUDE_PLUGIN_ROOT/skills/dimensional-drawing-motion/adapters/headless/render.mjs');
    expect(md).toMatch(/send_media/);
    expect(md).toMatch(/do not run `npm install`/i);
  });

  it('derives the plugin root and checks ffmpeg before rendering', () => {
    const md = readSkill();
    expect(md).toMatch(/export CLAUDE_PLUGIN_ROOT="\$\{CLAUDE_PLUGIN_ROOT:-<base directory>\/\.\.\/\.\.\}"/);
    expect(md).toContain('command -v ffmpeg');
  });

  it('every flag the soma-work commands pass is read by the headless renderer', () => {
    const md = readSkill();
    const runtime = md.slice(md.indexOf('## Running in soma-work'));
    const block = runtime.slice(runtime.indexOf('```bash'), runtime.indexOf('```', runtime.indexOf('```bash') + 7));
    const source = readFileSync(resolve(SKILL_ROOT, 'adapters/headless/render.mjs'), 'utf8');
    const flags = [...new Set(block.match(/--[a-z][a-z-]*/g) ?? [])];
    expect(flags.length).toBeGreaterThanOrEqual(5);
    for (const flag of flags) {
      expect({ flag, read: source.includes(`o.${flag.slice(2)}`) }).toEqual({ flag, read: true });
    }
  });

  it('LICENSES/ carries the upstream MIT license and an attribution NOTICE', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('notice'))).toBe(true);
    expect(files.some((f) => f.includes('mit'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/enesozturk\/dimensional-drawing/);
    expect(notice).toMatch(/MIT/);
  });
});
