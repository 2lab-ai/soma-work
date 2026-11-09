/**
 * The dashboard's library elements speak the page's display language (#771–#773). Elements written in the page's
 * HTML carry `lang="ko"` and translatePage rewrites it to the viewer's language; elements the client makes at run
 * time (`setAttribute('lang', …)`) are invisible to that rewrite. A literal 'ko' there left an English viewer with a
 * Korean composer after switching cards ("작업 중인 에이전트에 지시…", "다음 단계 · 지금 반영 · 줄바꿈"), a Korean
 * work-log tree, approval card, and so on. Every run-time lang reads the page's own <html lang>, inline and guarded: the
 * client-function test harnesses load functions by name (a shared helper would be undefined there) and some stub
 * `document` without a documentElement (then 'ko', as before).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const PAGE_LANG = "document.documentElement && document.documentElement.lang === 'en' ? 'en' : 'ko'";

describe('dashboard client — run-time lang attributes follow the display language', () => {
  it('no element is given a literal lang at run time', () => {
    const literal = [...DASHBOARD_TS.matchAll(/setAttribute\(\s*'lang'\s*,\s*'(ko|en)'\s*\)/g)].map((m) => m[0]);
    expect(literal).toEqual([]);
  });

  it('the card composer made on a card switch (pcFreshSteer) takes the page language', () => {
    const at = DASHBOARD_TS.indexOf('function pcFreshSteer(');
    const fn = DASHBOARD_TS.slice(at, at + 900);
    expect(fn).toContain(`el.setAttribute('lang', ${PAGE_LANG})`);
    expect(fn).toContain(`c.setAttribute('lang', ${PAGE_LANG})`);
  });

  it('every run-time lang reads the document language the server rendered', () => {
    const all = [...DASHBOARD_TS.matchAll(/setAttribute\(\s*'lang'\s*,\s*([^)]*?)\s*\)/g)].map((m) => m[1]);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const arg of all) expect(arg).toBe(PAGE_LANG);
  });
});
