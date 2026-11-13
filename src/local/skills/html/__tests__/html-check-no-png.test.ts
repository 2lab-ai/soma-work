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

describe('review gate — each defect alone fails the check (all other checks passing)', () => {
  const FILL = '<p>This paragraph is long enough that the page has plenty of visible text.</p>';
  it.each([
    ['short text', '<p>tiny</p>', (v: Record<string, number>) => expect(v.textChars).toBeLessThan(20)],
    [
      'sideways scroll',
      `${FILL}<div style="width:2000px">wide</div>`,
      (v: Record<string, number>) => expect(v.overflowX).toBeGreaterThan(0),
    ],
    [
      'overlapping text',
      `${FILL}<p style="position:absolute;top:200px;left:10px;margin:0">first label text</p><p style="position:absolute;top:202px;left:12px;margin:0">second label text</p>`,
      (v: Record<string, number>) => expect(v.overlaps).toBeGreaterThan(0),
    ],
    [
      'broken image',
      `${FILL}<img src="missing.png" alt="">`,
      (v: Record<string, number>) => expect(v.brokenImages).toBe(1),
    ],
    [
      'broken lazy image below the fold',
      `${FILL}<div style="height:20000px"></div><img loading="lazy" src="missing-lazy.png" alt="">`,
      (v: Record<string, number>) => expect(v.brokenImages).toBe(1),
    ],
    [
      'uncaught error',
      `${FILL}<script>throw new Error("boom-only")</script>`,
      (v: { pageErrors: string[] }) => expect(v.pageErrors.join(' ')).toMatch(/boom-only/),
    ],
  ])(
    '%s',
    (name, body, assertDefect) => {
      const r = check(`one-${String(name).replace(/\W+/g, '-')}`, body as string);
      expect(r.verdict.ok).toBe(false);
      expect(r.status).toBe(3);
      (assertDefect as (v: unknown) => void)(r.verdict);
      expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toEqual([]);
    },
    150_000,
  );
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
    expect(steps).toContain('--check');
    expect(steps).not.toMatch(/\.png|PNG=/);
    expect(s).not.toContain('QA snapshot');
    // The description says only when; the no-image rule is stated in the body's opening.
    expect(s).toContain('no image of it is made');
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

/**
 * research-skill run 2026-11-13 (html probes H1 · H4 · H5 and report v1): the overlap check failed sound pages.
 * A visually-hidden heading (the standard sr-only pattern) and table rows clipped by a scroll box were measured
 * as visible text, so authors deleted accessible headings and scroll boxes to get a pass. Text a reader cannot
 * see because an ancestor clips it is not an overlap; text that really collides still is.
 */
describe('review gate — clipped text is not drawn, so it does not overlap', () => {
  const FILL = '<p>This paragraph is long enough that the page has plenty of visible text for the check.</p>';
  const SR =
    'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';

  it('a visually-hidden (sr-only) heading over a summary is not an overlap', () => {
    const r = check(
      'sronly',
      `${FILL}<section style="position:relative"><h2 style="${SR}">방법론</h2><details><summary>방법론 · 증거 · 출처</summary><p>본문</p></details></section>`,
    );
    expect(r.verdict).toMatchObject({ ok: true, overlaps: 0 });
  }, 150_000);

  it('rows a scroll box clips away do not collide with the text after the box', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `<tr><td>row ${i} cell text</td><td>value ${i}</td></tr>`).join(
      '',
    );
    const r = check(
      'scrollbox',
      `${FILL}<div style="height:120px;overflow:auto"><table>${rows}</table></div><p>Text right after the scroll box.</p><p>More text after it.</p>`,
    );
    expect(r.verdict).toMatchObject({ ok: true, overlaps: 0 });
  }, 150_000);

  it('text that spills out of a box with visible overflow still collides', () => {
    const r = check(
      'spill',
      `${FILL}<div style="height:20px"><p style="margin:0">line one of a box that is too short</p><p style="margin:0">line two spills out</p><p style="margin:0">line three spills out</p></div><p style="margin:0">text right after the short box, under the spill</p>`,
    );
    expect(r.verdict.overlaps).toBeGreaterThan(0);
  }, 150_000);
});

/**
 * research-skill run 2026-11-13: in five of five html probes the first screen held no answer, no map of the page
 * and no reading guide — the template's KPI band came first (owner complaint #1, weight ×2). html Step 0 now marks
 * the three with data-first-screen="answer|map|guide"; `--first-screen` fails a page where any of them is missing
 * or starts below the first viewport.
 */
describe('--first-screen — the answer, the map and the reading guide open the page', () => {
  function checkFirst(name: string, body: string) {
    const input = join(dir, `${name}.html`);
    writeFileSync(
      input,
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>t</title></head><body style="margin:0">${body}</body></html>`,
    );
    const r = spawnSync(
      process.execPath,
      [RENDERER, '--input', input, '--check', '--first-screen', '--width', '1200', '--height', '800', '--wait-ms', '0'],
      { encoding: 'utf8', timeout: 120_000 },
    );
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('check: '));
    return { status: r.status, verdict: line ? JSON.parse(line.slice(7)) : null };
  }
  const TOP =
    '<p data-first-screen="answer">요약: Air에서 가져올 것은 이벤트 트리거 자동화 하나가 먼저다.</p>' +
    '<ol data-first-screen="map"><li>판단</li><li>근거</li><li>원자료</li></ol>' +
    '<p data-first-screen="guide">결정만 필요하면 판단까지, 의심되면 근거까지 읽는다.</p>';

  it('a page that opens with all three passes and reports where each sits', () => {
    const r = checkFirst('fs-ok', `${TOP}<div style="height:3000px"></div><p>아래 본문.</p>`);
    expect(r.status).toBe(0);
    expect(r.verdict.firstScreen).toMatchObject({ answer: true, map: true, guide: true });
  }, 150_000);

  it('a missing reading guide fails', () => {
    const r = checkFirst(
      'fs-noguide',
      TOP.replace(/<p data-first-screen="guide">.*<\/p>/, '') + '<p>본문 텍스트가 충분히 길게 이어진다.</p>',
    );
    expect(r.status).toBe(3);
    expect(r.verdict.firstScreen.guide).toBe(false);
  }, 150_000);

  it('an answer pushed below the first viewport by a KPI band fails', () => {
    const r = checkFirst('fs-below', `<div style="height:1400px">KPI 띠 자리</div>${TOP}`);
    expect(r.status).toBe(3);
    expect(r.verdict.firstScreen.answer).toBe(false);
  }, 150_000);

  it('without --first-screen the check does not ask for the markers (other skills share render.mjs)', () => {
    const r = check('fs-off', '<p>첫 화면 표시가 없는 페이지지만 다른 스킬이 쓰는 검사는 그대로 통과해야 한다.</p>');
    expect(r.status).toBe(0);
    expect(r.verdict.firstScreen).toBeUndefined();
  }, 150_000);
});
