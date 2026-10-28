import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SKILL_ROOT = resolve(__dirname, '..');
const SKILL_MD = resolve(SKILL_ROOT, 'SKILL.md');
const LICENSES_DIR = resolve(SKILL_ROOT, 'LICENSES');
const EXAMPLES = ['card-sheet.html', 'dialog-sheet.html'].map((f) => resolve(SKILL_ROOT, 'examples', f));
const DIAGRAM_ROUTER_MD = resolve(SKILL_ROOT, '..', 'diagram', 'SKILL.md');

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

describe('local:dimensional-drawing skill — RED contract', () => {
  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('frontmatter names the skill and carries EN + KO triggers', () => {
    const fm = parseFrontmatter(readSkill());
    expect(fm.name).toBe('dimensional-drawing');
    expect(fm.license).toBe('MIT');
    const desc = fm.description ?? '';
    expect(desc).toMatch(/dimensional drawing/i);
    expect(desc).toMatch(/anatomy|spec sheet|redline/i);
    // House style: Korean trigger keywords so Slack users reach the skill.
    expect(desc).toMatch(/도면/);
    expect(desc).toMatch(/치수/);
  });

  it('keeps the five upstream house rules', () => {
    const md = readSkill();
    expect(md).toMatch(/\*\*Monochrome\.\*\*/);
    expect(md).toMatch(/\*\*Architecture, not content\.\*\*/);
    expect(md).toMatch(/\*\*Variables, not numbers\.\*\*/);
    expect(md).toMatch(/\*\*Unbranded\.\*\*/);
    expect(md).toMatch(/\*\*Never invent values\.\*\*/);
    expect(md).toMatch(/\[TBD\]/);
  });

  it('keeps the drawing kit helper contract', () => {
    const md = readSkill();
    for (const helper of ['dimH(', 'dimV(', 'callout(', 'rad(', 'nb(', 'detailRef(', 'table(', 'notes(']) {
      expect(md).toContain(helper);
    }
  });

  it('every example the skill points at is bundled and contains a drawing sheet', () => {
    const md = readSkill();
    expect(md).toContain('examples/dialog-sheet.html');
    expect(md).toContain('examples/card-sheet.html');
    for (const file of EXAMPLES) {
      expect(existsSync(file)).toBe(true);
      const html = readFileSync(file, 'utf8');
      expect(html).toMatch(/viewBox="0 0 1700 1060"|1700 1060/);
      expect(html).toMatch(/color-scheme:\s*light/);
    }
  });

  it('bundled examples obey the monochrome rule — every hex colour is a gray', () => {
    for (const file of EXAMPLES) {
      const html = readFileSync(file, 'utf8');
      const hexes = html.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g) ?? [];
      expect(hexes.length).toBeGreaterThan(0);
      for (const hex of hexes) {
        const h = hex.slice(1);
        const full =
          h.length === 3
            ? h
                .split('')
                .map((c) => c + c)
                .join('')
            : h;
        const [r, g, b] = [0, 2, 4].map((i) => full.slice(i, i + 2).toLowerCase());
        expect({ hex, gray: r === g && g === b }).toEqual({ hex, gray: true });
      }
    }
  });

  it('replaces the claude.ai Artifact delivery with the soma-work Slack path', () => {
    const md = readSkill();
    // PNG via the html skill renderer, link via its server, both files into the thread.
    expect(md).toContain('skills/html/renderer/render.mjs');
    expect(md).toContain('skills/html/server/serve.mjs');
    expect(md).toMatch(/send_media/);
    expect(md).toMatch(/send_file/);
  });

  it('derives the plugin root when the bot shell has no CLAUDE_PLUGIN_ROOT', () => {
    expect(readSkill()).toMatch(/export CLAUDE_PLUGIN_ROOT="\$\{CLAUDE_PLUGIN_ROOT:-<base directory>\/\.\.\/\.\.\}"/);
  });

  it('every delivery bash block sets the plugin root itself, because Bash calls do not share env', () => {
    const md = readSkill();
    const delivery = md.slice(md.indexOf('## Delivery in soma-work'), md.indexOf('To animate the finished sheet'));
    const blocks = delivery.split('```bash').slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block.trimStart().startsWith('export CLAUDE_PLUGIN_ROOT=')).toBe(true);
    }
  });

  it('never publishes a private source to the LAN-readable archive', () => {
    expect(readSkill()).toMatch(/skip this step when the source is private/);
  });

  it('every flag the delivery commands pass exists in the html renderer / server parsers', () => {
    const md = readSkill();
    const delivery = md.slice(md.indexOf('## Delivery in soma-work'));
    const parsers: Record<string, string> = {
      'html/renderer/render.mjs': readFileSync(resolve(SKILL_ROOT, '..', 'html', 'renderer', 'render.mjs'), 'utf8'),
      'html/server/serve.mjs': readFileSync(resolve(SKILL_ROOT, '..', 'html', 'server', 'serve.mjs'), 'utf8'),
    };
    let checked = 0;
    for (const [script, source] of Object.entries(parsers)) {
      const commands = delivery.split('node "$CLAUDE_PLUGIN_ROOT/skills/').filter((c) => c.startsWith(script));
      expect({ script, documented: commands.length > 0 }).toEqual({ script, documented: true });
      for (const command of commands) {
        const body = command.slice(0, command.indexOf('```'));
        for (const flag of body.match(/--[a-z][a-z-]*/g) ?? []) {
          expect({ script, flag, parsed: source.includes(`'${flag}'`) }).toEqual({ script, flag, parsed: true });
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it('hands animation off to the motion skill', () => {
    expect(readSkill()).toMatch(/dimensional-drawing-motion/);
  });

  it('LICENSES/ carries the upstream MIT license and an attribution NOTICE', () => {
    expect(existsSync(LICENSES_DIR)).toBe(true);
    const files = readdirSync(LICENSES_DIR).map((f) => f.toLowerCase());
    expect(files.some((f) => f.includes('notice'))).toBe(true);
    expect(files.some((f) => f.includes('mit'))).toBe(true);
    const notice = readFileSync(resolve(LICENSES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/enesozturk\/dimensional-drawing/);
    expect(notice).toMatch(/MIT/);
    expect(notice).toMatch(/[0-9a-f]{7,40}/);
  });

  it('entry-point wiring: the diagram router delegates drawing requests here', () => {
    const router = readFileSync(DIAGRAM_ROUTER_MD, 'utf8');
    expect(router).toContain('local:dimensional-drawing');
    // The specific drawing signals must beat ARCHITECTURE's generic "component" signal.
    expect(router).toMatch(/도면/);
    expect(router).toMatch(/anatomy/i);
    expect(router).toMatch(/DRAWING[^\n]*(wins|beats|precedence|over)[^\n]*ARCHITECTURE/i);
    // A bare "take apart" is too broad: it must be scoped to a site or component.
    const row = router.split('\n').find((l) => l.startsWith('| **DRAWING**')) ?? '';
    expect(row).not.toMatch(/(\|\s*|,\s*)뜯어줘/);
    // A drawing word aimed at a system or flow stays ARCHITECTURE.
    expect(router).toMatch(/request flow[^\n]*stays ARCHITECTURE/);
  });
});
