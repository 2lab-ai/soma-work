/**
 * SSOT 2026-11-09 T4 — "Png로 만드는거 스킬에서 삭제해줘": the visual skills make no PNG of their page.
 * The page is still checked before it ships, in a headless browser that writes no image: render.mjs --check
 * prints the fonts lines and a JSON verdict (text present, no horizontal overflow, no overlapping text, no
 * broken image, no uncaught error) and exits 3 when the page fails.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SKILLS = resolve(__dirname, '..', '..');
const RENDERER = resolve(SKILLS, 'html', 'renderer', 'render.mjs');
const md = (name: string) => readFileSync(resolve(SKILLS, name, 'SKILL.md'), 'utf8');
const dir = mkdtempSync('/tmp/html-check-');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(name: string, body: string) {
  const input = join(dir, `${name}.html`);
  writeFileSync(
    input,
    `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`,
  );
  const r = spawnSync(
    process.execPath,
    [RENDERER, '--input', input, '--check', '--width', '800', '--height', '600', '--wait-ms', '0'],
    {
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('check: '));
  return { status: r.status, out: r.stdout + r.stderr, verdict: line ? JSON.parse(line.slice(7)) : null };
}

describe('render.mjs --check — the page is checked, no image is made', () => {
  it('a sound page passes: fonts lines, a verdict, exit 0, and no PNG anywhere', () => {
    const r = check(
      'ok',
      '<h1>보고서</h1><p>이 페이지는 충분한 본문 텍스트를 담고 있습니다. 검수만 하고 이미지는 만들지 않습니다.</p>',
    );
    expect(r.out).toMatch(/fonts loaded: /);
    expect(r.out).toMatch(/fonts used: /);
    expect(r.verdict).toMatchObject({ ok: true, overflowX: 0, overlaps: 0, brokenImages: 0, pageErrors: [] });
    expect(r.verdict.textChars).toBeGreaterThan(20);
    expect(r.status).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toEqual([]);
  }, 150_000);

  it('a page that fails says why and exits 3: overflow, overlapping text, an uncaught error', () => {
    const r = check(
      'bad',
      '<div style="width:2000px">wide content that scrolls sideways past the viewport</div>' +
        '<p style="position:absolute;top:100px;left:10px;margin:0">first overlapping label text</p>' +
        '<p style="position:absolute;top:102px;left:12px;margin:0">second overlapping label text</p>' +
        '<script>throw new Error("boom")</script>',
    );
    expect(r.status).toBe(3);
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.overflowX).toBeGreaterThan(0);
    expect(r.verdict.overlaps).toBeGreaterThan(0);
    expect(r.verdict.pageErrors.join(' ')).toMatch(/boom/);
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toEqual([]);
  }, 150_000);
});

describe('review gate — the check judges what a reader sees', () => {
  it('hidden slides (parent opacity:0) and an empty child box are not overlaps', () => {
    const slides = [1, 2, 3]
      .map(
        (n) =>
          `<section class="s${n === 1 ? ' on' : ''}" style="position:absolute;inset:0;opacity:${n === 1 ? 1 : 0}"><h1>Slide ${n} title</h1><p>Body text of slide number ${n}.</p></section>`,
      )
      .join('');
    const r = check('deck', `<div style="position:relative;height:500px">${slides}</div>`);
    expect(r.verdict).toMatchObject({ ok: true, overlaps: 0 });
    const box = check(
      'emptybox',
      '<div style="position:relative">Section label text here<div style="width:600px;height:200px"></div><p style="position:absolute;top:60px;left:20px;margin:0">A label inside that empty space</p></div>',
    );
    expect(box.verdict).toMatchObject({ ok: true, overlaps: 0 });
  }, 150_000);

  it('a positioned child label drawn over its parent’s own text is an overlap; text nobody can see fails', () => {
    const over = check(
      'childover',
      '<div style="position:relative;font-size:20px">Parent paragraph text that sits here<span style="position:absolute;left:0;top:0">Child label on top</span></div><p>More text so the page has enough characters.</p>',
    );
    expect(over.verdict.overlaps).toBeGreaterThan(0);
    const invisible = check(
      'invisible',
      '<div style="opacity:0"><h1>Everything here is invisible to a reader</h1></div>',
    );
    expect(invisible.status).toBe(3);
    expect(invisible.verdict.textChars).toBeLessThan(20);
  }, 150_000);

  it('a horizontal-swipe deck (fixed-canvas template) reports its sideways scroll but does not fail on it', () => {
    const input = join(dir, 'swipe.html');
    const slide = (n: number) =>
      `<section style="flex:0 0 1920px;height:1080px"><h1>Slide ${n} heading</h1><p>Slide ${n} body text for the deck.</p></section>`;
    writeFileSync(
      input,
      `<!doctype html><html><body style="margin:0"><main style="display:flex;width:3840px">${slide(1)}${slide(2)}</main></body></html>`,
    );
    const r = spawnSync(
      process.execPath,
      [RENDERER, '--input', input, '--check', '--template', 'deck-simple', '--wait-ms', '0'],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    const v = JSON.parse(((r.stdout || '').split('\n').find((l) => l.startsWith('check: ')) ?? 'check: null').slice(7));
    expect(v).toMatchObject({ ok: true, overlaps: 0 });
    expect(v.overflowX).toBeGreaterThan(0);
    expect(r.status).toBe(0);
  }, 150_000);

  it("the drawing skill's own starter sheets pass the check at 1800 px", () => {
    for (const ex of ['dialog-sheet.html', 'card-sheet.html']) {
      const input = resolve(SKILLS, 'dimensional-drawing', 'examples', ex);
      const r = spawnSync(
        process.execPath,
        [RENDERER, '--input', input, '--check', '--width', '1800', '--height', '1200', '--wait-ms', '800'],
        {
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('check: '));
      expect({ ex, verdict: line ? JSON.parse(line.slice(7)).ok : null }).toEqual({ ex, verdict: true });
    }
  }, 300_000);
});

describe('the skills check the page with --check and render no PNG', () => {
  it('html: Step 5–6 check in a headless browser; no PNG is rendered unless the user asks for an image', () => {
    const s = md('html');
    const steps = s.slice(s.indexOf('### 5.'), s.indexOf('### 7.'));
    expect(steps).toContain('### 5. Check the page in a headless browser (no image)');
    expect(steps).toContain('--check');
    expect(steps).not.toMatch(/\.png|PNG=/);
    expect(s).not.toContain('QA snapshot');
    const fm = s.slice(0, s.indexOf('\n---', 4));
    expect(fm).toContain('no image is made');
    const step8 = s.slice(s.indexOf('### 8.'), s.indexOf('### 9.'));
    expect(step8).toContain('No PNG is made');
  });

  it('dimensional-drawing: Step 3 checks the sheet with --check; no PNG snapshot; the upstream screenshot step is overridden', () => {
    const s = md('dimensional-drawing');
    const delivery = s.slice(s.indexOf('## Delivery in soma-work'));
    expect(delivery).toContain('no screenshot is made');
    const step3 = s.slice(s.indexOf('3. **'), s.indexOf('4. **Publish**'));
    expect(step3).toContain('--check');
    expect(step3).not.toMatch(/\.png|snapshot/i);
  });

  it('design and html: no PNG or screenshot wording left', () => {
    expect(md('design')).not.toMatch(/PNG is a QA snapshot|HTML\+PNG/);
    expect(md('html')).not.toMatch(/before the\s+screenshot/);
  });
});
