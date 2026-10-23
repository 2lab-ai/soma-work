/**
 * SSOT 2026-10-23 T3 — the settings page "기억" tab, client half. Runs the
 * shipped script (`MEMORY_CLIENT_JS` + the page helpers it calls) with stubbed
 * fetch / DOM: what each store looks like, what every control sends, and that
 * a conflicting edit reloads and keeps the user's draft.
 */

import { describe, expect, it, vi } from 'vitest';
import { MEMORY_CLIENT_JS } from '../settings-memory-tab';
import { renderSettingsPage, SETTINGS_CLIENT_JS } from '../settings-page';

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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

function block(over: Record<string, unknown> = {}) {
  return {
    entries: ['테스트 전에 빌드', '배포는 dev 먼저'],
    charLimit: 2200,
    totalChars: 30,
    percentUsed: 1,
    perEntryCap: 660,
    revision: 'r1',
    ...over,
  };
}

describe('기억 tab shell', () => {
  it('the page carries the 기억 tab and the whole script still parses', () => {
    const html = renderSettingsPage();
    expect(html).toContain('<a href="#memory">기억</a>');
    expect(html).toContain('<div data-tab="memory" class="page" hidden>');
    const script = /<script>([\s\S]*)<\/script>\s*<\/body>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('the memory script ships byte for byte (no template-literal syntax)', () => {
    expect(MEMORY_CLIENT_JS).not.toContain('`');
    expect(MEMORY_CLIENT_JS).not.toContain('${');
  });
});

describe('개인 메모리 cards', () => {
  const r = load<{ renderL1Card(t: string, b: any, editing: any): string }>(
    ['esc', 'escAttr', 'fmtNum', 'renderL1Card'],
    ['L1_LABELS', 'L1_FILES'],
    { _memUndo: null },
  );

  it('one row per entry with edit / delete, a meter with visible numbers, an add box with the per-entry cap', () => {
    const html = r.renderL1Card('memory', block(), null);
    expect(html).toContain('에이전트 노트');
    expect(html).toContain('MEMORY.md');
    expect(html).toContain('<meter min="0" max="2200"');
    expect(html).toContain('30 / 2,200자');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('onclick="l1EditStart(\'memory\',1)"');
    expect(html).toContain('onclick="l1Delete(\'memory\',0)"');
    expect(html).toContain('한 항목 최대 660자');
    expect(html).toContain('모두 지우기');
    expect(html).not.toContain('§');
  });

  it('marks a full store and escapes entry text', () => {
    const html = r.renderL1Card(
      'user',
      block({ entries: ['<script>x</script>'], totalChars: 1375, charLimit: 1375 }),
      null,
    );
    expect(html).toContain('meter-line is-full');
    expect(html).toContain('가득 참');
    expect(html).not.toContain('<script>x');
  });

  it('edit mode shows a textarea with the entry and save / cancel', () => {
    const html = r.renderL1Card('memory', block(), { index: 0, text: '테스트 전에 빌드' });
    expect(html).toContain('<textarea id="l1-edit-memory"');
    expect(html).toContain('onclick="l1Save(\'memory\',0)"');
  });
});

describe('개인 메모리 writes', () => {
  function env(apiWrite: any, extra: Record<string, unknown> = {}) {
    const status: any = { textContent: '', className: '', setAttribute: vi.fn() };
    const elements: Record<string, any> = {
      'mem-status': status,
      'l1-new-memory': { value: '새 메모' },
      'l1-edit-memory': { value: '고친 메모' },
    };
    const mem = { l1: { memory: block(), user: block({ revision: 'u1' }) } };
    const deps: Record<string, any> = {
      _mem: mem,
      _memUndo: null,
      document: { getElementById: (id: string) => elements[id] ?? null },
      apiWrite,
      paintL1: vi.fn(),
      loadMemory: vi.fn(async () => {}),
      confirmDialog: vi.fn(async () => true),
      ...extra,
    };
    const fns = load<any>(
      ['memStatus', 'l1Write', 'l1Add', 'l1Save', 'l1Delete', 'l1Undo', 'l1Clear'],
      ['L1_LABELS'],
      deps,
    );
    return { fns, deps, status, mem };
  }

  it('add / save / delete send the loaded revision to the right route', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block({ revision: 'r2' }) } }));
    const { fns } = env(apiWrite);
    await fns.l1Add('memory');
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/memory/l1/memory', { text: '새 메모', revision: 'r1' });
    await fns.l1Save('memory', 1);
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/l1/memory/1', { text: '고친 메모', revision: 'r2' });
    await fns.l1Delete('memory', 0);
    expect(apiWrite).toHaveBeenLastCalledWith('DELETE', '/api/memory/l1/memory/0', { revision: 'r2' });
  });

  it('a single delete offers undo, which adds the text back', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block({ revision: 'r9' }) } }));
    const { fns } = env(apiWrite);
    // l1Delete stores the undo in the module-level _memUndo — read it back via l1Undo's call.
    await fns.l1Delete('memory', 1);
    await fns.l1Undo();
    expect(apiWrite).toHaveBeenLastCalledWith('POST', '/api/memory/l1/memory', {
      text: '배포는 dev 먼저',
      revision: 'r9',
    });
  });

  it('clear all confirms and names the count; cancel sends nothing', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block({ entries: [] }) } }));
    const confirmDialog = vi.fn(async () => false);
    const { fns } = env(apiWrite, { confirmDialog });
    await fns.l1Clear('memory');
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ action: '2개 모두 지우기' }));
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it('a 409 reloads the stores and keeps the draft in the status line', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const { fns, deps, status } = env(apiWrite);
    expect(await fns.l1Write('POST', '/api/memory/l1/memory', { text: '새 메모', revision: 'r1' }, '새 메모')).toBe(
      false,
    );
    expect(deps.loadMemory).toHaveBeenCalled();
    expect(status.textContent).toContain('최신 내용을 불러왔습니다');
    expect(status.textContent).toContain('새 메모');
  });
});

describe('지식 페이지 editor', () => {
  it('shows title, aliases, Current and every History line editable; a new page asks type and name', () => {
    const el: any = { innerHTML: '' };
    const doc = { getElementById: () => el };
    const page = {
      id: 'concepts/ssot',
      title: 'SSOT <b>',
      aliases: ['ssot', 'truth'],
      current: 'v2',
      history: ['2026-10-22: a', '2026-10-21: b'],
      updated: '2026-10-22',
    };
    const fns = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS'], {
      document: doc,
      _memPage: { page, revision: 'p1' },
    });
    fns.renderPageEditor();
    expect(el.innerHTML).toContain('value="SSOT &lt;b&gt;"');
    expect(el.innerHTML).toContain('value="ssot, truth"');
    expect(el.innerHTML).toContain('<textarea id="pg-current" rows="8">v2</textarea>');
    expect(el.innerHTML.match(/class="pg-hist"/g)).toHaveLength(2);
    expect(el.innerHTML).toContain('페이지 삭제');
    const fresh = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS'], {
      document: doc,
      _memPage: { page: { id: '', title: '', aliases: [], current: '', history: [] }, revision: null },
    });
    fresh.renderPageEditor();
    expect(el.innerHTML).toContain('<select id="pg-type">');
    expect(el.innerHTML).toContain('id="pg-name"');
    expect(el.innerHTML).toContain('만들기');
  });

  it('save sends the whole page with the loaded revision; a new page is created with revision null', async () => {
    const values: Record<string, string> = {
      'pg-title': 'New title',
      'pg-aliases': 'a, b ,, c',
      'pg-current': 'now',
      'pg-type': 'agent',
      'pg-name': 'ci-runner',
    };
    const hist = [{ value: '2026-10-23: x' }, { value: '  ' }];
    const doc = {
      getElementById: (id: string) => (id in values ? { value: values[id] } : { textContent: '', setAttribute() {} }),
      querySelectorAll: () => hist,
    };
    const apiWrite = vi.fn(async () => ({ ok: true, data: { page: { id: 'x' }, revision: 'p2' } }));
    const memPage: any = { page: { id: 'concepts/ssot' }, revision: 'p1' };
    const fns = load<any>(['pageDraft', 'savePage', 'memStatus'], [], {
      document: doc,
      _memPage: memPage,
      apiWrite,
      refreshPageIndex: async () => {},
      renderPageEditor: () => {},
      openPage: async () => {},
    });
    await fns.savePage();
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/page', {
      id: 'concepts/ssot',
      title: 'New title',
      aliases: ['a', 'b', 'c'],
      current: 'now',
      history: ['2026-10-23: x'],
      revision: 'p1',
    });
    const fresh = load<any>(['pageDraft', 'savePage', 'memStatus'], [], {
      document: doc,
      _memPage: { page: { id: '' }, revision: null },
      apiWrite,
      refreshPageIndex: async () => {},
      renderPageEditor: () => {},
      openPage: async () => {},
    });
    await fresh.savePage();
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ id: 'agent/ci-runner', revision: null }),
    );
  });
});

describe('관찰 기록 (에피소딕)', () => {
  it('a day shows entries with time, edit and delete; the edit sends the day revision', async () => {
    const el: any = { innerHTML: '' };
    const day = { date: '2026-10-20', revision: 'd1', entries: [{ time: '05:09', title: 'Ask', content: 'Ask: <x>' }] };
    const fns = load<any>(['esc', 'escAttr', 'renderDay'], [], {
      document: { getElementById: () => el },
      _memDay: day,
    });
    fns.renderDay();
    expect(el.innerHTML).toContain('05:09 UTC');
    expect(el.innerHTML).toContain('Ask: &lt;x&gt;');
    expect(el.innerHTML).toContain('onclick="epDelete(0)"');

    const apiWrite = vi.fn(async () => ({ ok: true, data: { day: { ...day, revision: 'd2' } } }));
    const w = load<any>(['epWrite', 'epSave', 'epDelete', 'memStatus'], [], {
      document: {
        getElementById: (id: string) =>
          id === 'ep-edit' ? { value: '고친 기록' } : { textContent: '', setAttribute() {} },
      },
      _memDay: day,
      apiWrite,
      renderDay: () => {},
      loadDay: async () => {},
      confirmDialog: async () => true,
    });
    await w.epSave(0);
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/episodic/2026-10-20/0', {
      content: '고친 기록',
      revision: 'd1',
    });
  });

  it('a 409 on a day (a turn appended meanwhile) reloads that day', async () => {
    const loadDay = vi.fn(async () => {});
    const status: any = { textContent: '', setAttribute() {} };
    const w = load<any>(['epWrite', 'memStatus'], [], {
      document: { getElementById: () => status },
      _memDay: { date: '2026-10-20', revision: 'd1', entries: [] },
      apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
      renderDay: () => {},
      loadDay,
    });
    expect(await w.epWrite('DELETE', '/api/memory/episodic/2026-10-20/0', { revision: 'd1' })).toBe(false);
    expect(loadDay).toHaveBeenCalledWith('2026-10-20');
    expect(status.textContent).toContain('최신 내용을 불러왔습니다');
  });
});
