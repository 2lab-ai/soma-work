/**
 * SSOT 2026-11-02 T7 — the Executive Summary's TL;DR on the dashboard's task card, client half.
 *
 * "tl;dr은 태스크 카드에 표기해줘. (이 내역은 슬리핑이나 작업 완료로 넘어가면 안보이게해줘. 그리고 tl;dr
 * 표시창 우상단에 x 표시 넣어서 해당 x누르면 삭제해서 작업 카드를 컴팩트하게 유지할 수 있게 해줘."
 *
 *   - the card (`esTldr` from the server) hands @2lab.ai/ui <ui-agent-inbox> its `tldr` (the element draws
 *     the box and its ×) — never on a sleeping or archived card (the 'closed' column);
 *   - the user's face layout (faceOf) keeps it, after the summary row, whatever rows it picked;
 *   - × (the element's ui-dismiss) drops it from this card for good in this browser — a newer summary shows again.
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked exactly as the
 * browser receives it) and the shared layout script as is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
function memStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

const ES = {
  lines: ['PR #771 merged — the viewer fills the screen.', 'CI is green.', 'Next: deploy to dev.'],
  at: 1_793_591_000_000,
};
const sess = (over: Record<string, unknown> = {}) => ({ key: 'inst::C1:t1', esTldr: ES, ...over });

type Api = {
  cardTldrOf(s: unknown, col: string): { lines: string[]; title?: string } | null;
  tldrDismiss(key: string): void;
};
const api = (storage = memStorage(), refreshed: string[] = []) =>
  load<Api>(['toNum', 'tldrGoneLoad', 'cardTldrOf', 'tldrDismiss'], ['TLDR_GONE_KEY', 'TLDR_GONE_MAX', '_tldrGone'], {
    localStorage: storage,
    _sessionCache: { 'inst::C1:t1': sess() },
    refreshCard: (k: string) => refreshed.push(k),
  });

describe('T7 — the card hands the element its TL;DR', () => {
  it('waiting, working, idle: the lines under the TL;DR label; sleeping or archived (closed): none', () => {
    const m = api();
    for (const col of ['waiting', 'working', 'idle']) {
      expect(m.cardTldrOf(sess(), col)).toEqual({ lines: ES.lines, title: 'TL;DR' });
    }
    expect(m.cardTldrOf(sess(), 'closed')).toBeNull();
    expect(m.cardTldrOf(sess({ esTldr: undefined }), 'idle')).toBeNull();
    expect(m.cardTldrOf(sess({ esTldr: { lines: [], at: 1 } }), 'idle')).toBeNull();
  });

  it('× drops it from this card in this browser (kept across reloads); a newer summary shows again', () => {
    const storage = memStorage();
    const refreshed: string[] = [];
    const m = api(storage, refreshed);
    m.tldrDismiss('inst::C1:t1');
    expect(refreshed).toEqual(['inst::C1:t1']);
    expect(m.cardTldrOf(sess(), 'idle')).toBeNull();
    // A page loaded later reads what this one stored.
    const later = api(storage);
    expect(later.cardTldrOf(sess(), 'idle')).toBeNull();
    expect(later.cardTldrOf(sess({ esTldr: { ...ES, at: ES.at + 60_000 } }), 'idle')).not.toBeNull();
    // Another card's TL;DR is untouched.
    expect(later.cardTldrOf(sess({ key: 'inst::C2:t2' }), 'idle')).not.toBeNull();
  });

  it('storage that throws or holds junk never breaks the board', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    const m = load<Api>(
      ['toNum', 'tldrGoneLoad', 'cardTldrOf', 'tldrDismiss'],
      ['TLDR_GONE_KEY', 'TLDR_GONE_MAX', '_tldrGone'],
      {
        localStorage: broken,
        _sessionCache: { 'inst::C1:t1': sess() },
        refreshCard: () => {},
      },
    );
    expect(m.cardTldrOf(sess(), 'idle')).not.toBeNull();
    expect(() => m.tldrDismiss('inst::C1:t1')).not.toThrow();
    expect(m.cardTldrOf(sess(), 'idle')).toBeNull(); // this page still remembers it
    const junk = api(memStorage({ 'soma-dash-tldr-gone': '{nope' }));
    expect(junk.cardTldrOf(sess(), 'idle')).not.toBeNull();
  });

  it('wiring: the face gets it (viewCardOf), and the element’s ui-dismiss is answered on every inbox', () => {
    expect(clientFn('viewCardOf')).toContain('var tl = cardTldrOf(s, col);');
    expect(clientFn('wireInbox')).toContain("host.addEventListener('ui-dismiss'");
    expect(clientFn('wireInbox')).toContain('tldrDismiss(String(e.detail.cardId))');
  });
});

describe('T7 — the user’s face layout keeps the TL;DR, after the summary row', () => {
  const faceOf = new Function(`${VIEW_LAYOUT_CLIENT_JS}\nreturn faceOf;`)() as (
    card: Record<string, unknown>,
    model: string,
    face: unknown,
    asks: boolean,
  ) => Record<string, unknown> & { rows: string[] };
  const card = {
    id: 'k',
    title: 't',
    status: 'done',
    summary: '왜 여기',
    task: { label: 'x' },
    tldr: { lines: ['a'] },
  };
  const on = (id: string) => ({ id, on: true });

  it('after the summary when the layout shows it; first when it does not; absent without one', () => {
    const a = faceOf(card, '', { rows: [on('summary'), on('task')], foot: [] }, false);
    expect(a.rows).toEqual(['summary', 'tldr', 'task']);
    expect(a.tldr).toEqual({ lines: ['a'] });
    const b = faceOf(card, '', { rows: [on('task')], foot: [] }, false);
    expect(b.rows).toEqual(['tldr', 'task']);
    const c = faceOf({ ...card, tldr: undefined }, '', { rows: [on('summary')], foot: [] }, false);
    expect(c.rows).toEqual(['summary']);
    expect(c).not.toHaveProperty('tldr');
  });
});
