/**
 * Epic #437 / #443 — affectUI Memory Panel → 설정 › 기억 › 개인 메모리 (L1)
 * (.prd/affectui/re-memory-panel.md §4 D1–D17).
 *
 * The inline copy (#443: `renderL1Card` … `l1PanelFocus`, the `.mm-*` styles) is
 * replaced by the library element it was ported to: `<ui-memory-panel>` from
 * @2lab.ai/ui (src/components/memory-panel/). This file pins the host contract —
 * where the element sits, which tokens it gets, which strings stay the tab's —
 * and names, for every #443 test, the test that owns the behaviour now:
 *
 *   #443 test                                          now
 *   T1  shell, polite status                           here (T1) · memory-panel.test.ts “draws the store chips…”
 *   T2  chips: radiogroup, counts, one tab stop        memory-panel.test.ts “draws the store chips as a radiogroup with counts and one tab stop”
 *   T3  chips: arrows, Home/End, other store inert     memory-panel.test.ts “moves and selects with arrows (wrapping), Home / End; other groups fold and go inert”
 *   T4  search                                         memory-panel.test.ts “opens search over the chips, filters with highlight, matches store names, says when nothing matches”
 *   T5  groups and rows, escaped, no §                 memory-panel.test.ts “draws one named group per store…”, “escapes every host string…”
 *   T6  in-place edit keys, unchanged sends nothing    memory-panel.test.ts “opens in place, Enter saves…”, “a whitespace-only change closes without an event…”, “Esc cancels…”
 *   T7  delete at once, fold, tray undo                memory-panel.test.ts “emits ui-delete at once, folds the row, offers Undo…”
 *   T7b refused delete: row back, no undo              memory-panel.test.ts “refuse(ui-delete): the row comes back and Undo is withdrawn”; host: settings-memory-tab.test.ts “over the limit, a lock or a network error…”
 *   T8  undo 5 s, paused, restore:true                 memory-panel.test.ts “keeps Undo for 5 s…”, “pauses while the pointer rests on the tray…”; route: settings-memory-tab.test.ts “add / edit / delete / undo / clear”
 *   T9  add per store, draft kept                      memory-panel.test.ts “opens the store’s editor, Esc folds it keeping the draft, Enter adds (ui-add)…”
 *   T10 tray at rest, hints; successes in the tray     memory-panel.test.ts “shows the empty state and the tray summary”; here (T10)
 *   T11 rolling count                                  memory-panel.test.ts “shows a title with the entry count when given” (the tab drops the heading badge: 전체 N on the chip)
 *   R1-1 trimmed-equal edit sends nothing              memory-panel.test.ts “a whitespace-only change closes without an event; an empty one is refused”
 *   R1-2 count keeps rolling through repaints          memory-panel.test.ts “stays coherent when the host answers during the fold…”
 *   R1-3 add box grows with its draft                  memory-panel.test.ts “refuse(ui-add): … the note is back in the open add box”
 *   R1-4 focus after delete                            memory-panel.test.ts “focus falls back to the previous row, then the add button”
 *   R1-5 held key guard; refused delete view           memory-panel.test.ts “ignores a held Enter (key guard)…”, “a refused delete changes nothing”
 *   R2-1 L1 success clears its own alert               settings-memory-tab.test.ts “a successful L1 write clears the alert L1 left…”
 *   R2-2 hover before the delete holds the undo        memory-panel.test.ts “pauses while the pointer rests on the tray, resuming from the time left”
 *   R2-3 focus in the panel holds the undo             memory-panel.test.ts “keeps Undo for 5 s once focus is outside the panel, and paused while focus is inside”
 *   R2-4 focus rings not clipped                       the element's styles (.mm-addline / .mm-chips padding) — library styles.ts
 *   T12 CSS contract                                   here (T12): the tab keeps no .mm-* styles; the element's own CSS is the library's
 */

import { describe, expect, it, vi } from 'vitest';
import { MEMORY_CLIENT_JS, MEMORY_TAB_CSS, MEMORY_TAB_HTML } from '../settings-memory-tab';
import { SETTINGS_CLIENT_JS, SETTINGS_PAGE_CSS } from '../settings-page';
import { pageTokenAliases, uiLibTokensCss } from '../ui-lib';

const ALL_JS = `${MEMORY_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
function clientVar(name: string): string {
  const m = ALL_JS.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return m[1];
}

describe('D1 · D2 — the element lives in the L1 block; pages and episodic are untouched', () => {
  it('T1 the L1 section carries <ui-memory-panel lang="ko"> in the token wrapper under its heading; #mem-status stays polite', () => {
    const l1 = MEMORY_TAB_HTML.slice(MEMORY_TAB_HTML.indexOf('id="m-l1"'), MEMORY_TAB_HTML.indexOf('id="m-pages"'));
    expect(l1).toContain('<h2 id="h-m-l1">개인 메모리</h2>'); // no count badge: 전체 N is on the element's chip
    expect(l1).toContain('<div id="mem-l1-body"><div class="notice">불러오는 중…</div></div>');
    expect(l1).toContain('<div class="ui-tok"><ui-memory-panel id="l1-panel" lang="ko"></ui-memory-panel></div>');
    expect(MEMORY_TAB_HTML).toContain('<div id="mem-status" class="status" role="status" aria-live="polite"></div>');
    expect(MEMORY_TAB_HTML).toContain(`onclick="memJump('m-l1')"`);
    for (const id of [
      'mem-page-list',
      'mem-page-detail',
      'mem-ep-date',
      'mem-ep-body',
      'mem-ep-new',
      'mem-page-filter',
    ]) {
      expect(MEMORY_TAB_HTML).toContain(`id="${id}"`);
    }
  });
});

describe('D12 — the tray', () => {
  it('T10 L1 successes speak in the element’s tray, not #mem-status; the empty line is the tab’s', async () => {
    const status = { textContent: '', className: '', setAttribute: vi.fn() };
    const listeners: Record<string, (e: unknown) => void> = {};
    const panel: any = {
      addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
      refuse: vi.fn(),
    };
    const block = { entries: ['a'], charLimit: 2200, totalChars: 1, perEntryCap: 660, revision: 'r1' };
    const names = [
      'memStatus',
      'memHold',
      'l1Stores',
      'paintL1',
      'l1Route',
      'l1OnWrite',
      'l1Say',
      'l1Held',
      'l1Unsay',
      'l1Write',
    ];
    const vars = ['L1_LABELS', 'L1_FILES', 'L1_TARGETS', 'L1_EMPTY', 'L1_WRITES'];
    const body = `${vars.map(clientVar).join('\n')}\n${names.map(clientFn).join('\n')}\nreturn { ${names.join(', ')} };`;
    const els: Record<string, unknown> = { 'l1-panel': panel, 'mem-status': status };
    const fns = new Function('document', '_mem', 'apiWrite', 'loadMemory', body)(
      { getElementById: (id: string) => els[id] ?? null },
      { l1: { memory: block, user: { ...block, entries: [] } } },
      vi.fn(async () => ({ ok: true, data: { ok: true, l1: { ...block, entries: ['a', 'b'], revision: 'r2' } } })),
      vi.fn(),
    );
    fns.paintL1();
    expect(panel.data.stores[1].empty).toBe('비어 있음 — Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.');
    listeners['ui-add']({
      type: 'ui-add',
      detail: { store: 'memory', text: 'b' },
      currentTarget: panel,
      preventDefault() {},
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.data.stores[0].entries).toEqual(['a', 'b']);
    expect(status.textContent).toBe(''); // the element said 추가했습니다 itself
    const glue = MEMORY_CLIENT_JS.slice(
      MEMORY_CLIENT_JS.indexOf('// ── 개인 메모리 (L1) ──'),
      MEMORY_CLIENT_JS.indexOf('// ── 지식 페이지 ──'),
    );
    expect(glue).toContain('function l1Write(');
    expect(glue).not.toMatch(/(저장했습니다|추가했습니다|되돌렸습니다|모두 지웠습니다)'/);
  });
});

describe('D14 – D16 — CSS contract', () => {
  it('T12 the tab keeps no styles of the panel: no .mm-*, no meter, no counter; the section frame and the token bridge only', () => {
    expect(MEMORY_TAB_CSS).not.toMatch(/\.mm\b|\.mm-|\.meter-line|\.counter|--mm-/);
    // tone pass P9: section.group cards carry --ib-shadow; the element-drawn L1 section drops it too
    expect(MEMORY_TAB_CSS).toContain('#m-l1 { background: none; border: 0; box-shadow: none; }');
    expect(MEMORY_TAB_CSS).toContain('#m-l1 > header { padding: 0 2px 10px; border-bottom: 0; }');
    // the light-theme amber the inline .mm used is the page's light --yellow — since tone pass P9 the
    // library's own (@2lab.ai/ui tokens.css, aliased), no longer a settings-page hex (#9a6700)
    expect(uiLibTokensCss()).toMatch(/:root, \[data-theme="light"\] \{[^}]*--ui-yellow: #[0-9a-f]{6};/);
    expect(pageTokenAliases()).toContain('--yellow: var(--ui-yellow);');
    expect(SETTINGS_PAGE_CSS).not.toMatch(/--yellow: #/);
    expect(SETTINGS_PAGE_CSS).toMatch(/\.ui-tok \{[^}]*--ui-yellow: var\(--yellow\);/);
    // pages and episodic still use the global textarea look
    expect(MEMORY_TAB_CSS).toContain('textarea { width: 100%; font: inherit; font-size: 13px;');
    // memory classes never borrow the model picker's mp-* (#442)
    expect(MEMORY_TAB_CSS + MEMORY_TAB_HTML + MEMORY_CLIENT_JS).not.toMatch(/\bmp-|class="mp"|ui-mp/);
  });
});
