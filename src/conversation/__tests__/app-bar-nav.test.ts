/**
 * One app bar on every page: the dashboard, the settings page and the conversation pages hand <ui-app-bar> the
 * same four links (대시보드 · 대화 · 설정 · 기억, each with what the page is for), the page's own marked current,
 * and the same speaker (the head's sound script). Before this, each page kept its own list — the dashboard had
 * 기억 and no 대시보드, the others had 대시보드 and no 기억, and the conversation pages had no speaker.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

type Link = { id: string; label: string; href: string; icon: string; title: string; current?: boolean };

function navOf(file: string): Link[] {
  const src = SRC(file);
  const start = src.indexOf('\nvar APP_BAR_NAV = [');
  if (start < 0) throw new Error(`${file}: APP_BAR_NAV not found`);
  const end = src.indexOf('];\n', start);
  return new Function(`${src.slice(start + 1, end + 2)}\nreturn APP_BAR_NAV;`)() as Link[];
}

const PAGES = [
  { file: 'dashboard.ts', current: 'dashboard' },
  { file: 'settings-page.ts', current: 'settings' },
  { file: 'viewer.ts', current: 'conversations' },
];

describe('the app bar — one list of page links on every page', () => {
  it('every page has the same four links, each saying what its page is for', () => {
    const lists = PAGES.map((p) => navOf(p.file).map(({ current: _c, ...l }) => l));
    expect(lists[0].map((l) => l.id)).toEqual(['dashboard', 'conversations', 'settings', 'memory']);
    for (const l of lists[0]) expect(l.title.length).toBeGreaterThan(0);
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
  });

  it('each page marks its own link current, and only that one', () => {
    for (const p of PAGES) {
      expect(
        navOf(p.file)
          .filter((l) => l.current)
          .map((l) => l.id),
      ).toEqual([p.current]);
    }
  });

  it('every page carries the speaker: the head sound script and the bar’s sound choice', () => {
    for (const p of PAGES) {
      const src = SRC(p.file);
      expect(src).toContain('<script data-sound>${soundClientJs(UI_LIB_VERSION)}</script>');
      expect(src).toContain("sound: typeof _somaOn !== 'undefined' && !!_somaOn");
    }
  });
});
