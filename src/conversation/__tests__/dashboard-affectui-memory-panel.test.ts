/**
 * Epic #437 / #443 — affectUI Memory Panel → 설정 › 기억 › 개인 메모리 (L1)
 * (.prd/affectui/re-memory-panel.md §4 D1–D17). Runs the shipped client script
 * (`MEMORY_CLIENT_JS` + the page helpers it calls — String.raw, so no cook step)
 * against a small fake DOM that parses the markup it writes: ids, attributes,
 * textarea values, focus.
 *
 *   store chips (radiogroup, roving, counts) · search · one group per store
 *   in-place edit (Enter / Shift+Enter / Esc, IME guard) · delete = real DELETE
 *   folding at once + tray "삭제함 “…” · 되돌리기" for 5 s (paused on hover/focus)
 *   · add per store · tray caption + polite status · rolling counts · CSS contract
 */

import { describe, expect, it, vi } from 'vitest';
import { MEMORY_CLIENT_JS, MEMORY_TAB_CSS, MEMORY_TAB_HTML } from '../settings-memory-tab';
import { SETTINGS_CLIENT_JS } from '../settings-page';

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

// ── fake DOM ──
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
const decode = (s: string) => s.replace(/&(lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m]);

class FakeEl {
  attrs = new Map<string, string>();
  textContent = '';
  value = '';
  disabled = false;
  className = '';
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  scrollHeight = 40;
  offsetHeight = 0;
  private html = '';
  constructor(
    private dom: FakeDom,
    public tag: string,
    public id = '',
  ) {}
  setAttribute(n: string, v: unknown) {
    this.attrs.set(n, String(v));
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  getAttribute(n: string) {
    return this.attrs.has(n) ? (this.attrs.get(n) as string) : null;
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  focus() {
    this.dom.active = this;
  }
  scrollIntoView() {}
  setSelectionRange() {}
  appendChild(c: FakeEl) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
  }
  querySelector() {
    return null;
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v: string) {
    this.html = v;
    if (this.id === 'mem-l1-body') this.dom.parseBody(v);
  }
}

class FakeDom {
  els: Record<string, FakeEl> = {};
  active: FakeEl | null = null;
  private bodyIds = new Set<string>();
  constructor(staticHtml: string) {
    this.parse(staticHtml, false);
  }
  parse(html: string, body: boolean) {
    for (const m of html.matchAll(/<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
      const attrs = new Map<string, string>();
      for (const a of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs.set(a[1], decode(a[2] ?? ''));
      const id = attrs.get('id');
      if (!id) continue;
      const el = new FakeEl(this, m[1].toLowerCase(), id);
      el.attrs = attrs;
      el.className = attrs.get('class') ?? '';
      this.els[id] = el;
      if (body) this.bodyIds.add(id);
    }
    for (const m of html.matchAll(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
      if (this.els[m[1]]) this.els[m[1]].value = decode(m[2]);
    }
  }
  parseBody(html: string) {
    for (const id of this.bodyIds) delete this.els[id];
    this.bodyIds.clear();
    this.parse(html, true);
  }
  get document() {
    return {
      getElementById: (id: string) => this.els[id] ?? null,
      createElement: (tag: string) => new FakeEl(this, tag),
    };
  }
}

const S = '\n§\n';
function block(entries: string[], charLimit: number, perEntryCap: number, revision: string) {
  const totalChars = entries.length ? entries.join(S).length : 0;
  return {
    entries,
    charLimit,
    totalChars,
    percentUsed: Math.round((totalChars / charLimit) * 100),
    perEntryCap,
    revision,
  };
}
const MEM = [
  'soma-work 저장소는 PR 전에 npx tsc --noEmit와 npx vitest run을 둘 다 돌린다.',
  '배포는 dev 먼저: git push origin main:deploy/dev, 확인 후 deploy/prod.',
  '대시보드 클라이언트 코드는 dashboard.ts 템플릿 리터럴 안에 있다.',
  'PR #380이 settings-memory-tab.ts를 건드린다 — 충돌 주의.',
  'cron 작업 결과는 채널에 새 메시지로 올린다.',
];
const USR = ['이름은 Zhuge, 2lab.ai에서 soma-work를 만든다.', '답은 한국어로, 결론 먼저 짧게.', '시간대는 Asia/Seoul.'];

const PANEL_FNS = [
  'esc',
  'escAttr',
  'fmtNum',
  'memStatus',
  'memHold',
  'memKeepDraft',
  'memRecover',
  'paintRecover',
  'renderL1Card',
  'paintL1',
  'l1Cancel',
  'l1Busy',
  'l1Count',
  'l1Write',
  'restoreL1Draft',
  'l1EditStart',
  'l1Save',
  'l1Add',
  'l1Delete',
  'l1Undo',
  'l1Clear',
  'l1El',
  'l1Fold',
  'l1Matches',
  'l1Sync',
  'l1ApplyView',
  'l1PaintTray',
  'l1TrayState',
  'l1Notice',
  'l1UndoArm',
  'l1TrayHold',
  'l1Reveal',
  'l1Roll',
  'l1Reduced',
  'l1FocusAct',
  'l1OpenDrafts',
  'l1AddOpen',
  'l1AddClose',
  'l1AddKey',
  'l1EditKey',
  'l1EditInput',
  'l1Grow',
  'l1Pick',
  'l1ChipKey',
  'l1SearchOpen',
  'l1SearchClose',
  'l1SearchInput',
  'l1SearchKey',
];

interface Panel {
  dom: FakeDom;
  fns: Record<string, (...a: any[]) => any>;
  apiWrite: ReturnType<typeof vi.fn>;
  peek(): { _memUndo: any; _mem: any };
  el(id: string): FakeEl;
}

function panel(opts: { apiWrite?: any; reduced?: boolean; raf?: any; mem?: any } = {}): Panel {
  const dom = new FakeDom(MEMORY_TAB_HTML);
  const apiWrite = opts.apiWrite ?? vi.fn();
  const inject: Record<string, unknown> = {
    document: dom.document,
    _mem: opts.mem ?? { l1: { memory: block(MEM, 2200, 660, 'rm1'), user: block(USR, 1375, 412, 'ru1') } },
    _memUndo: null,
    apiWrite,
    loadMemory: vi.fn(async () => true),
    confirmDialog: vi.fn(async () => true),
    window: { matchMedia: () => ({ matches: !!opts.reduced }) },
    requestAnimationFrame: opts.raf,
    cancelAnimationFrame: () => {},
  };
  const names = Object.keys(inject);
  const body = `${['L1_LABELS', 'L1_FILES'].map(clientVar).join('\n')}\n${PANEL_FNS.map(clientFn).join('\n')}\nreturn { fns: { ${PANEL_FNS.join(', ')} }, peek: function () { return { _memUndo: _memUndo, _mem: _mem }; } };`;
  const out = new Function(...names, body)(...names.map((n) => inject[n]));
  return {
    dom,
    fns: out.fns,
    apiWrite,
    peek: out.peek,
    el: (id: string) => dom.els[id],
  };
}
const key = (k: string, extra: Record<string, unknown> = {}) => ({
  key: k,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  ...extra,
});
const isOpen = (el: FakeEl | undefined) => !!el && el.hasAttribute('data-open') && !el.hasAttribute('inert');
const isShut = (el: FakeEl | undefined) => !!el && !el.hasAttribute('data-open') && el.hasAttribute('inert');

describe('D1 · D2 — the panel lives in the L1 block; pages and episodic are untouched', () => {
  it('T1 the L1 section carries the panel shell, a count on the heading and a polite status', () => {
    expect(MEMORY_TAB_HTML).toContain('<div id="l1-panel" class="mm">');
    expect(MEMORY_TAB_HTML).toContain('<div id="mem-l1-body" class="mm-list">');
    expect(MEMORY_TAB_HTML).toContain('<span id="l1-total" class="mm-count" aria-hidden="true"></span>');
    expect(MEMORY_TAB_HTML).toMatch(
      /<span id="l1-live" class="mm-sr" role="status" aria-live="polite" aria-atomic="true">/,
    );
    expect(MEMORY_TAB_HTML).not.toContain('l1-grid');
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
    // the panel chrome waits for data: ready only after the first paint
    const p = panel();
    expect(p.el('l1-panel').hasAttribute('data-ready')).toBe(false);
    p.fns.paintL1();
    expect(p.el('l1-panel').hasAttribute('data-ready')).toBe(true);
  });
});

describe('D3 · D4 — store chips', () => {
  it('T2 a radiogroup of 전체 · 에이전트 노트 · 사용자 프로필 with counts; only the selected one is a tab stop', () => {
    expect(MEMORY_TAB_HTML).toMatch(/<div id="l1-chips" class="mm-chips" role="radiogroup" aria-label="저장소"/);
    const p = panel();
    p.fns.paintL1();
    expect([p.el('l1-n-all').textContent, p.el('l1-n-memory').textContent, p.el('l1-n-user').textContent]).toEqual([
      '8',
      '5',
      '3',
    ]);
    expect(p.el('l1-chip-all').getAttribute('role')).toBe('radio');
    expect(p.el('l1-chip-all').getAttribute('aria-checked')).toBe('true');
    expect(p.el('l1-chip-all').getAttribute('tabindex')).toBe('0');
    expect(p.el('l1-chip-memory').getAttribute('aria-checked')).toBe('false');
    expect(p.el('l1-chip-memory').getAttribute('tabindex')).toBe('-1');
    expect(p.el('l1-total').textContent).toBe('8');
  });

  it('T3 arrows move and select (wrapping), Home/End; the other store folds away and is inert', () => {
    const p = panel();
    p.fns.paintL1();
    p.fns.l1ChipKey(key('ArrowRight'));
    expect(p.el('l1-chip-memory').getAttribute('aria-checked')).toBe('true');
    expect(p.dom.active).toBe(p.el('l1-chip-memory'));
    expect(isShut(p.el('l1-g-user'))).toBe(true);
    expect(isOpen(p.el('l1-g-memory'))).toBe(true);
    p.fns.l1ChipKey(key('ArrowDown'));
    expect(p.el('l1-chip-user').getAttribute('aria-checked')).toBe('true');
    p.fns.l1ChipKey(key('ArrowRight')); // wraps
    expect(p.el('l1-chip-all').getAttribute('aria-checked')).toBe('true');
    p.fns.l1ChipKey(key('ArrowLeft')); // wraps back
    expect(p.el('l1-chip-user').getAttribute('aria-checked')).toBe('true');
    p.fns.l1ChipKey(key('Home'));
    expect(p.el('l1-chip-all').getAttribute('aria-checked')).toBe('true');
    expect(isOpen(p.el('l1-g-user'))).toBe(true);
    p.fns.l1ChipKey(key('End'));
    expect(p.el('l1-chip-user').getAttribute('tabindex')).toBe('0');
    expect(isShut(p.el('l1-g-memory'))).toBe(true);
    const other = key('a');
    p.fns.l1ChipKey(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});

describe('D5 — search', () => {
  it('T4 opens over the chips, matches text and store label case-insensitively, says when nothing matches, Esc closes', () => {
    const p = panel();
    p.fns.paintL1();
    p.fns.l1Pick('user');
    p.fns.l1SearchOpen();
    expect(p.el('l1-filters').hasAttribute('data-searching')).toBe(true);
    expect(p.el('l1-search-open').getAttribute('aria-expanded')).toBe('true');
    expect(p.el('l1-chips').hasAttribute('inert')).toBe(true);
    expect(p.el('l1-search').hasAttribute('inert')).toBe(false);
    expect(p.dom.active).toBe(p.el('l1-q'));
    expect(p.el('l1-chip-all').getAttribute('aria-checked')).toBe('true'); // search clears the store filter

    p.fns.l1SearchInput('VITEST');
    expect(isOpen(p.el('l1-f-memory-0'))).toBe(true);
    expect(isShut(p.el('l1-f-memory-1'))).toBe(true);
    expect(isShut(p.el('l1-g-user'))).toBe(true);

    p.fns.l1SearchInput('사용자');
    expect([0, 1, 2].every((i) => isOpen(p.el(`l1-f-user-${i}`)))).toBe(true);
    expect(isShut(p.el('l1-g-memory'))).toBe(true);

    p.fns.l1SearchInput('zzz');
    expect(isOpen(p.el('l1-nomatch'))).toBe(true);
    expect(p.el('l1-nomatch-text').textContent).toBe('“zzz” 검색 결과가 없습니다');

    const esc = key('Escape');
    p.fns.l1SearchKey(esc);
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(p.el('l1-filters').hasAttribute('data-searching')).toBe(false);
    expect(p.el('l1-q').value).toBe('');
    expect(p.dom.active).toBe(p.el('l1-search-open'));
    expect(isShut(p.el('l1-nomatch'))).toBe(true);
    expect(isOpen(p.el('l1-f-memory-1'))).toBe(true);
  });
});

describe('D6 · D7 — groups and rows', () => {
  it('T5 a labelled group with the meter, bare <li> rows, "#N · L자", named actions, escaped, no §', () => {
    const r = panel().fns.renderL1Card as (t: string, b: any, e: any, ctx?: any) => string;
    const long = 'x'.repeat(700);
    const html = r('memory', block(['테스트 전에 빌드', '<b>배포</b>', long], 2200, 660, 'r1'), null, {
      view: {},
      adding: false,
    });
    expect(html).toContain(
      '<section id="l1-g-memory" class="mm-group mm-fold" data-open aria-labelledby="l1-h-memory">',
    );
    expect(html).toContain('<h3 id="l1-h-memory">에이전트 노트 <span class="sub">MEMORY.md</span></h3>');
    expect(html).toContain('<meter min="0" max="2200"');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('#1 · 9자');
    expect(html).toContain('#3 · 700자 · <span class="mm-over">한 항목 한도 초과</span>');
    expect(html).toContain('aria-label="수정: “테스트 전에 빌드”"');
    expect(html).toContain(`aria-label="삭제: “${'x'.repeat(40)}…”"`);
    expect(html).toContain('onclick="l1EditStart(\'memory\',0)"');
    expect(html).toContain('onclick="l1Delete(\'memory\',1)"');
    expect(html).toContain('&lt;b&gt;배포&lt;/b&gt;');
    expect(html).not.toContain('<b>배포');
    expect(html).not.toContain('§');
    const empty = r('user', block([], 1375, 412, 'u1'), null, { view: {}, adding: false });
    expect(empty).toContain('비어 있음 — Slack에서 "기억해줘"라고 하거나 아래에서 추가하세요.');
    expect(empty).not.toContain('모두 지우기');
  });
});

describe('D8 — in-place edit', () => {
  it('T6 Enter saves, Shift+Enter and IME composition do not, Esc cancels back to 수정, unchanged text sends nothing', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      data: { l1: block(['edited', ...MEM.slice(1)], 2200, 660, 'rm2') },
    }));
    const p = panel({ apiWrite });
    p.fns.paintL1();
    p.fns.l1EditStart('memory', 0);
    const ta = p.el('l1-edit-memory');
    expect(ta.getAttribute('rows')).toBe('1');
    expect(p.dom.active).toBe(ta);
    expect(ta.style.height).toBe('40px'); // grown to its content
    p.fns.l1EditKey(key('Enter'), 'memory', 0); // unchanged → closes, nothing sent
    expect(apiWrite).not.toHaveBeenCalled();
    expect(p.el('l1-edit-memory')).toBeUndefined();
    expect(p.dom.active).toBe(p.el('l1-ed-memory-0'));

    p.fns.l1EditStart('memory', 0);
    p.el('l1-edit-memory').value = 'edited';
    p.fns.l1EditInput(p.el('l1-edit-memory'), 'memory');
    expect(p.el('l1-ecount-memory').textContent).toBe('6 / 660자');
    p.fns.l1EditKey(key('Enter', { shiftKey: true }), 'memory', 0);
    p.fns.l1EditKey(key('Enter', { isComposing: true }), 'memory', 0);
    p.fns.l1EditKey(key('Enter', { keyCode: 229 }), 'memory', 0);
    expect(apiWrite).not.toHaveBeenCalled();
    const enter = key('Enter');
    await p.fns.l1EditKey(enter, 'memory', 0);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/l1/memory/0', { text: 'edited', revision: 'rm1' });
    expect(p.el('l1-edit-memory')).toBeUndefined();
    expect(p.dom.active).toBe(p.el('l1-ed-memory-0'));

    p.fns.l1EditStart('memory', 1);
    p.fns.l1EditKey(key('Escape'), 'memory', 1);
    expect(p.el('l1-edit-memory')).toBeUndefined();
    expect(p.dom.active).toBe(p.el('l1-ed-memory-1'));
  });
});

describe('D9 · D10 — delete folds at once; the tray offers undo for 5 s', () => {
  it('T7 one DELETE at once, the row folds while it is out, then the tray names it with 되돌리기', async () => {
    vi.useFakeTimers();
    try {
      let answer: (v: unknown) => void = () => {};
      const apiWrite = vi.fn(() => new Promise((res) => (answer = res)));
      const p = panel({ apiWrite });
      p.fns.paintL1();
      const del = p.fns.l1Delete('memory', 1);
      const row = p.el('l1-f-memory-1');
      expect(row.hasAttribute('data-leaving')).toBe(true);
      expect(isShut(row)).toBe(true);
      await p.fns.l1Delete('memory', 1);
      expect(apiWrite).toHaveBeenCalledTimes(1);
      expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/l1/memory/1', { revision: 'rm1' });
      answer({ ok: true, data: { l1: block([MEM[0], ...MEM.slice(2)], 2200, 660, 'rm2') } });
      await vi.advanceTimersByTimeAsync(0);
      expect(p.el('mem-l1-body').innerHTML).toContain(MEM[1].slice(0, 10)); // the fold is still playing
      await vi.advanceTimersByTimeAsync(320);
      await del;
      expect(p.el('mem-l1-body').innerHTML).not.toContain('배포는 dev 먼저');
      const s = p.fns.l1TrayState();
      expect(s.key).toMatch(/^forgot-/);
      expect(s.html).toContain('삭제함 “</span><b class="mm-quote">배포는 dev 먼저');
      expect(p.el('l1-undo').hasAttribute('hidden')).toBe(false);
      expect(p.el('l1-live').textContent).toContain('삭제함 “배포는 dev 먼저');
      expect(p.dom.active).toBe(p.el('l1-del-memory-1')); // the next row's 삭제
    } finally {
      vi.useRealTimers();
    }
  });

  it('T7b a refused delete unfolds the row again and reports in #mem-status', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 400, error: '안 됨' }));
    const p = panel({ apiWrite, reduced: true });
    p.fns.paintL1();
    await p.fns.l1Delete('memory', 0);
    const row = p.el('l1-f-memory-0');
    expect(row.hasAttribute('data-leaving')).toBe(false);
    expect(isOpen(row)).toBe(true);
    expect(p.el('mem-status').textContent).toContain('저장하지 못했습니다: 안 됨');
    expect(p.peek()._memUndo).toBeNull();
  });

  it('T8 the undo lasts 5,000 ms, pauses while hovered or focused, and restores through restore:true', async () => {
    vi.useFakeTimers();
    try {
      const after = block([MEM[0], ...MEM.slice(2)], 2200, 660, 'rm2');
      const apiWrite = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { l1: after } })
        .mockResolvedValueOnce({ ok: true, data: { l1: after } })
        .mockResolvedValueOnce({ ok: true, data: { l1: block([...after.entries, MEM[2]], 2200, 660, 'rm3') } });
      const p = panel({ apiWrite, reduced: true });
      p.fns.paintL1();
      await p.fns.l1Delete('memory', 1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(p.peek()._memUndo).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(p.peek()._memUndo).toBeNull();
      expect(p.fns.l1TrayState().key).toBe('rest');
      expect(p.el('l1-undo').hasAttribute('hidden')).toBe(true);

      await p.fns.l1Delete('memory', 1); // a fresh delete (the store answers with the same list)
      await vi.advanceTimersByTimeAsync(3000);
      p.fns.l1TrayHold('hover', true);
      p.fns.l1TrayHold('focus', true);
      await vi.advanceTimersByTimeAsync(10000);
      p.fns.l1TrayHold('hover', false);
      await vi.advanceTimersByTimeAsync(10000);
      expect(p.peek()._memUndo).not.toBeNull(); // still focused
      p.fns.l1TrayHold('focus', false);
      await vi.advanceTimersByTimeAsync(1999);
      expect(p.peek()._memUndo).not.toBeNull();

      await p.fns.l1Undo();
      expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/memory/l1/memory', {
        text: MEM[2],
        revision: 'rm2',
        restore: true,
      });
      expect(p.peek()._memUndo).toBeNull();
      expect(p.fns.l1TrayState().html).toBe('되돌렸습니다 — 목록 끝에 다시 넣었습니다');
      expect(p.dom.active).toBe(p.el('l1-ed-memory-4')); // the restored row, at the end
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D11 — add per store', () => {
  it('T9 a folded editor per group: opens, Esc folds keeping the draft, a draft stays open across a repaint, Enter adds', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block([...USR, 'new note'], 1375, 412, 'ru2') } }));
    const p = panel({ apiWrite });
    p.fns.paintL1();
    expect(p.el('l1-add-user').getAttribute('aria-expanded')).toBe('false');
    expect(p.el('l1-add-user').getAttribute('aria-controls')).toBe('l1-newbox-user');
    expect(isShut(p.el('l1-newbox-user'))).toBe(true);
    expect(p.el('l1-new-user')).toBeDefined(); // the box is in the DOM while folded (draft safety)
    expect(p.el('mem-l1-body').innerHTML).toContain('+ 사용자 프로필에 추가');

    p.fns.l1AddOpen('user');
    expect(isOpen(p.el('l1-newbox-user'))).toBe(true);
    expect(isShut(p.el('l1-addbtn-user'))).toBe(true);
    expect(p.el('l1-add-user').getAttribute('aria-expanded')).toBe('true');
    expect(p.dom.active).toBe(p.el('l1-new-user'));
    expect(p.fns.l1TrayState().html).toBe('Enter 추가 · Shift+Enter 줄바꿈 · Esc 닫기');

    p.el('l1-new-user').value = 'new note';
    p.fns.l1AddKey(key('Escape'), 'user');
    expect(isShut(p.el('l1-newbox-user'))).toBe(true);
    expect(p.el('l1-new-user').value).toBe('new note');
    expect(p.dom.active).toBe(p.el('l1-add-user'));

    p.fns.paintL1(); // a repaint (another write, a reload) with a draft in the box
    expect(isOpen(p.el('l1-newbox-user'))).toBe(true);
    expect(p.el('l1-new-user').value).toBe('new note');

    p.fns.l1AddKey(key('Enter', { isComposing: true }), 'user');
    expect(apiWrite).not.toHaveBeenCalled();
    await p.fns.l1AddKey(key('Enter'), 'user');
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/memory/l1/user', { text: 'new note', revision: 'ru1' });
    expect(p.el('l1-new-user').value).toBe('');
    expect(isShut(p.el('l1-newbox-user'))).toBe(true);
    expect(p.dom.active).toBe(p.el('l1-add-user'));
    expect(p.fns.l1TrayState().html).toBe('추가했습니다');
  });
});

describe('D12 — the tray', () => {
  it('T10 counts and capacity at rest; editing and adding hints; L1 successes speak in the tray, not #mem-status', async () => {
    const apiWrite = vi.fn(async () => ({
      ok: true,
      data: { l1: block(['edited', ...MEM.slice(1)], 2200, 660, 'rm2') },
    }));
    const p = panel({ apiWrite });
    p.fns.paintL1();
    const m = block(MEM, 2200, 660, 'x').totalChars;
    const u = block(USR, 1375, 412, 'x').totalChars;
    const rest = p.fns.l1TrayState();
    expect(rest.key).toBe('rest');
    expect(rest.live).toBe(`8개 항목 · 에이전트 노트 ${m} / 2,200자 · 사용자 프로필 ${u} / 1,375자`);
    expect(p.el('l1-live').textContent).toBe(rest.live);
    expect(MEMORY_TAB_HTML).toMatch(/<span id="l1-caption" class="mm-caption" aria-hidden="true">/);

    p.fns.l1EditStart('memory', 0);
    expect(p.fns.l1TrayState().html).toBe('Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소');
    p.el('l1-edit-memory').value = 'edited';
    await p.fns.l1Save('memory', 0);
    expect(p.fns.l1TrayState().html).toBe('저장했습니다');
    expect(p.el('mem-status').textContent).not.toBe('저장했습니다');
  });
});

describe('D13 — rolling counts', () => {
  it('T11 the heading count rolls over 520 ms (ease-out quart); with reduced motion it jumps', () => {
    const frames: Array<(t: number) => void> = [];
    const p = panel({ raf: (f: (t: number) => void) => frames.push(f) });
    const el = new FakeEl(p.dom, 'span');
    p.fns.l1Roll(el, 8);
    expect(el.textContent).toBe('8'); // first value: no roll
    p.fns.l1Roll(el, 4);
    expect(frames).toHaveLength(1);
    frames.shift()?.(1000);
    frames.shift()?.(1000 + 130); // t = .25 → 1 − .75^4 ≈ .68
    expect(el.textContent).toBe('5');
    frames.shift()?.(1000 + 520);
    expect(el.textContent).toBe('4');
    expect(frames).toHaveLength(0);

    const q = panel({ reduced: true, raf: () => {} });
    const e2 = new FakeEl(q.dom, 'span');
    q.fns.l1Roll(e2, 8);
    q.fns.l1Roll(e2, 3);
    expect(e2.textContent).toBe('3');
  });
});

describe('D14 – D16 — CSS contract', () => {
  const start = MEMORY_TAB_CSS.indexOf('/* ── 개인 메모리 (L1) — memory panel ── */');
  const end = MEMORY_TAB_CSS.indexOf('/* ── end 개인 메모리 (L1) ── */');
  const css = MEMORY_TAB_CSS.slice(start, end);

  it('T12 settings tokens only, fold timing, reduced motion, touch sizes, container widths, no reference names', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(css).toMatch(/\.mm \{[^}]*container-type: inline-size;/);
    expect(css).toContain('--mm-fold: 320ms;');
    expect(css).toMatch(
      /\.mm-fold \{[^}]*grid-template-rows: 0fr;[^}]*transition: grid-template-rows var\(--mm-fold\) var\(--ease-out\)/,
    );
    expect(css).toMatch(/\.mm-fold\[data-leaving\] \{[^}]*filter: blur\(2px\);/);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.mm \*, \.mm \*::before, \.mm \*::after \{ animation: none !important; transition: none !important; \} \}/,
    );
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^@]*\.mm-acts \{ opacity: 1; \}/);
    expect(css).toMatch(/@container \(max-width: 480px\) \{[^@]*\.mm-cap \{ display: none; \}/);
    expect(css).toMatch(/@container \(max-width: 340px\) \{[^@]*\.mm-chip-n \{ display: none; \}/);
    expect(css).toContain('[data-theme="light"] .mm { --mm-warn: #9a6700; }');
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g)).toEqual(['#9a6700']);
    expect(MEMORY_TAB_CSS + MEMORY_TAB_HTML + MEMORY_CLIENT_JS).not.toMatch(/ui-mp/);
    // memory classes are mm-* (the dashboard's model picker owns mp-*, #442)
    expect(MEMORY_TAB_CSS + MEMORY_TAB_HTML + MEMORY_CLIENT_JS).not.toMatch(/\bmp-|class="mp"/);
  });
});
