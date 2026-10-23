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

describe('개인 메모리 undo (review R5)', () => {
  it('undo asks for an exact restore, and a refused restore keeps the text in the add box and the undo offered', async () => {
    const addBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const long = '긴 노트 '.repeat(140); // 700 chars: more than a new note may have, saved by Slack
    const apiWrite = vi.fn().mockResolvedValueOnce({ ok: false, status: 400, error: '저장 실패' });
    const fns = load<any>(['l1Undo', 'l1Write', 'memStatus', 'restoreL1Draft'], [], {
      document: { getElementById: (id: string) => (id === 'l1-new-memory' ? addBox : status) },
      _mem: { l1: { memory: { entries: [], revision: 'r2' } } },
      _memUndo: { target: 'memory', text: long },
      apiWrite,
      paintL1: () => {},
      loadMemory: async () => {},
    });
    await fns.l1Undo();
    expect(apiWrite).toHaveBeenCalledWith('POST', '/api/memory/l1/memory', {
      text: long,
      revision: 'r2',
      restore: true,
    });
    expect(addBox.value).toBe(long);
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
      ['memStatus', 'restoreL1Draft', 'l1Write', 'l1Add', 'l1Save', 'l1Delete', 'l1Undo', 'l1Clear'],
      ['L1_LABELS'],
      deps,
    );
    return { fns, deps, status, mem };
  }

  it('after a 409 a draft for one of two identical notes goes to the add box, not the first match (review R3 P1)', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const { fns, deps, mem } = env(apiWrite);
    mem.l1.memory = block({ entries: ['dup', 'dup'], revision: 'r1' });
    deps.document.getElementById = (id: string) =>
      id === 'l1-edit-memory'
        ? { value: 'mine' }
        : id === 'l1-new-memory'
          ? addBox
          : { textContent: '', setAttribute() {} };
    const addBox: any = { value: '' };
    await fns.l1Save('memory', 1);
    expect(deps.paintL1).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'mine' }));
    expect(addBox.value).toBe('mine');
  });

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

  it('an L1 draft goes back to its own entry only when that entry is unchanged (review R2 P1)', async () => {
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const addBox: any = { value: '' };
    const { fns, deps, status } = env(apiWrite);
    deps.document.getElementById = (id: string) =>
      id === 'mem-status' ? status : id === 'l1-new-memory' ? addBox : null;
    // the stores reloaded: entry 1 was "배포는 dev 먼저", now something else sits there
    deps._mem.l1.memory = block({ entries: ['테스트 전에 빌드', '다른 항목'] });
    deps.loadMemory = vi.fn(async () => {});
    await fns.l1Write(
      'PUT',
      '/api/memory/l1/memory/1',
      { text: '고친 배포 규칙', revision: 'r1' },
      '고친 배포 규칙',
      1,
      '배포는 dev 먼저',
    );
    expect(deps.paintL1).not.toHaveBeenCalledWith({ target: 'memory', index: 1, text: '고친 배포 규칙' });
    expect(addBox.value).toBe('고친 배포 규칙');
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
      restore: true, // the exact note back (review R5)
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

  it('a 409 reloads the stores and puts the WHOLE draft back in an edit box (review P1)', async () => {
    const long = '긴 초안 '.repeat(120);
    const apiWrite = vi.fn(async () => ({ ok: false, status: 409, error: 'conflict' }));
    const addBox: any = { value: '' };
    const { fns, deps, status } = env(apiWrite);
    deps.document.getElementById = (id: string) =>
      id === 'mem-status' ? status : id === 'l1-new-memory' ? addBox : null;
    expect(
      await fns.l1Write('PUT', '/api/memory/l1/memory/1', { text: long, revision: 'r1' }, long, 1, '배포는 dev 먼저'),
    ).toBe(false);
    expect(deps.loadMemory).toHaveBeenCalled();
    expect(deps.paintL1).toHaveBeenLastCalledWith({ target: 'memory', index: 1, text: long });
    expect(status.textContent).toContain('편집 칸에 그대로');
    expect(await fns.l1Write('POST', '/api/memory/l1/memory', { text: long, revision: 'r1' }, long)).toBe(false);
    expect(addBox.value).toBe(long);
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
    const fns = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: { page, revision: 'p1' },
    });
    fns.renderPageEditor();
    expect(el.innerHTML).toContain('value="SSOT &lt;b&gt;"');
    expect(el.innerHTML).toContain('value="ssot, truth"');
    expect(el.innerHTML).toContain('<textarea id="pg-current" rows="8">v2</textarea>');
    expect(el.innerHTML.match(/class="pg-hist"/g)).toHaveLength(2);
    expect(el.innerHTML).toContain('페이지 삭제');
    const fresh = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: { page: { id: '', title: '', aliases: [], current: '', history: [] }, revision: null },
    });
    fresh.renderPageEditor();
    expect(el.innerHTML).toContain('<select id="pg-type">');
    expect(el.innerHTML).toContain('id="pg-name"');
    expect(el.innerHTML).toContain('만들기');
  });

  it('a page the form cannot hold opens as raw markdown, saved with its revision; 409 keeps the draft (review R3 P1)', async () => {
    const el: any = { innerHTML: '' };
    const conflictBox: any = { innerHTML: '' };
    const rawBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const raw = '---\ntitle: L\n---\n\n## Current\n\nintro\n## Details\nimportant <text>\n';
    const memPage: any = {
      page: { id: 'concepts/lossy', title: 'L', aliases: [], current: 'intro', history: [], updated: '2026-10-23' },
      revision: 'p1',
      raw,
      representable: false,
    };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? el : id === 'pg-conflict' ? conflictBox : id === 'pg-raw' ? rawBox : status,
    };
    const view = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: doc,
      _memPage: memPage,
    });
    view.renderPageEditor();
    expect(el.innerHTML).toContain('<textarea id="pg-raw"');
    expect(el.innerHTML).toContain('important &lt;text&gt;');
    expect(el.innerHTML).toContain('양식에 담기지 않는');
    expect(el.innerHTML).not.toContain('id="pg-current"');
    expect(el.innerHTML).toContain('onclick="savePageRaw()"');

    rawBox.value = raw.replace('important', 'very important');
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: true, data: { ...memPage, revision: 'p3' } });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...memPage, revision: 'p2' }) }));
    const fns = load<any>(
      ['esc', 'savePageRaw', 'memStatus', 'renderPageConflict', 'overwritePage'],
      ['_memPageConflict', '_memPageRaw'],
      {
        document: doc,
        fetch,
        _memPage: memPage,
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor: () => {},
      },
    );
    await fns.savePageRaw();
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page/raw', {
      id: 'concepts/lossy',
      raw: rawBox.value,
      revision: 'p1',
    });
    expect(conflictBox.innerHTML).toContain('내 수정본으로 덮어쓰기');
    expect(rawBox.value).toContain('very important'); // the draft is still in the editor
    await fns.overwritePage();
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page/raw', {
      id: 'concepts/lossy',
      raw: rawBox.value,
      revision: 'p2',
    });
  });

  it('any page can be switched to raw markdown editing', () => {
    const el: any = { innerHTML: '' };
    const page = { id: 'concepts/a', title: 'A', aliases: [], current: 'v', history: [], updated: '2026-10-23' };
    const fns = load<any>(['esc', 'escAttr', 'renderPageEditor'], ['PAGE_GROUPS', '_memPageRaw'], {
      document: { getElementById: () => el },
      _memPage: { page, revision: 'p1', raw: '# A\n', representable: true },
    });
    fns.renderPageEditor();
    expect(el.innerHTML).toContain('id="pg-current"');
    expect(el.innerHTML).toContain('onclick="pageRawMode(true)"');
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
    const w = load<any>(['epWrite', 'epSave', 'epDelete', 'memStatus', 'refreshDatesIfEmptied'], [], {
      document: {
        getElementById: (id: string) =>
          id === 'ep-edit' ? { value: '고친 기록' } : { textContent: '', setAttribute() {} },
      },
      _memDay: day,
      apiWrite,
      renderDay: () => {},
      loadDay: async () => {},
      confirmDialog: async () => true,
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    await w.epSave(0);
    expect(apiWrite).toHaveBeenCalledWith('PUT', '/api/memory/episodic/2026-10-20/0', {
      content: '고친 기록',
      revision: 'd1',
    });
  });

  it('after a 409 a draft never lands in ANOTHER entry: only where its original still is, else the note box (review R2 P1)', async () => {
    const renderDay = vi.fn();
    const noteBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const w = load<any>(['epWrite', 'memStatus'], [], {
      document: { getElementById: (id: string) => (id === 'mem-ep-new' ? noteBox : status) },
      // the entry being edited ("A") was deleted elsewhere: index 0 is now "B"
      _memDay: { date: '2026-10-20', revision: 'd2', entries: [{ time: '02:00', content: 'B' }] },
      apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
      renderDay,
      loadDay: async () => {},
    });
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/0',
      { content: 'A fixed', revision: 'd1' },
      'A fixed',
      0,
      'A',
    );
    expect(renderDay).not.toHaveBeenCalledWith(0, 'A fixed');
    expect(noteBox.value).toBe('A fixed');
  });

  it('after a 409 a draft for one of two identical records goes back to the one with its time, never the first match (review R3 P1)', async () => {
    const renderDay = vi.fn();
    const noteBox: any = { value: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const day = {
      date: '2026-10-20',
      revision: 'd2',
      entries: [
        { time: '01:00', content: 'same' },
        { time: '02:00', content: 'same' },
      ],
    };
    const w = load<any>(['epWrite', 'memStatus'], [], {
      document: { getElementById: (id: string) => (id === 'mem-ep-new' ? noteBox : status) },
      _memDay: day,
      apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
      renderDay,
      loadDay: async () => {},
    });
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/1',
      { content: 'mine', revision: 'd1' },
      'mine',
      1,
      'same',
      '02:00',
    );
    expect(renderDay).toHaveBeenLastCalledWith(1, 'mine');
    // identical in time AND text: there is no telling them apart — the draft goes to the note box
    day.entries[0].time = '02:00';
    renderDay.mockClear();
    await w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/1',
      { content: 'mine', revision: 'd1' },
      'mine',
      1,
      'same',
      '02:00',
    );
    expect(renderDay).not.toHaveBeenCalledWith(expect.anything(), 'mine');
    expect(noteBox.value).toBe('mine');
  });

  it('a delete sends the date, entry and revision the confirmation showed, even if the view moved meanwhile (review R3 P1)', async () => {
    const day: any = {
      date: '2026-10-20',
      revision: 'd20',
      entries: [{ time: '05:09', content: 'the 20th' }],
    };
    const apiWrite = vi.fn(async () => ({ ok: true, data: { day: { ...day, entries: [] } } }));
    const w = load<any>(['epWrite', 'epDelete', 'memStatus', 'refreshDatesIfEmptied'], [], {
      document: { getElementById: () => ({ textContent: '', setAttribute() {} }) },
      _memDay: day,
      apiWrite,
      renderDay: () => {},
      loadDay: async () => {},
      // while the dialog is open the date picker finished loading another day
      confirmDialog: async () => {
        Object.assign(day, { date: '2026-10-21', revision: 'd21', entries: [{ time: '07:00', content: 'the 21st' }] });
        return true;
      },
      refreshPageIndex: async () => {},
      paintDates: () => {},
    });
    await w.epDelete(0);
    expect(apiWrite).toHaveBeenCalledWith('DELETE', '/api/memory/episodic/2026-10-20/0', { revision: 'd20' });
  });

  it('clear-all and page delete send the revision the confirmation was about (review R3 P1)', async () => {
    const apiWrite = vi.fn(async () => ({ ok: true, data: { l1: block({ entries: [], revision: 'r9' }) } }));
    const mem: any = { l1: { memory: block(), user: block({ revision: 'u1' }) } };
    const fns = load<any>(['memStatus', 'restoreL1Draft', 'l1Write', 'l1Clear'], ['L1_LABELS'], {
      _mem: mem,
      document: { getElementById: () => ({ textContent: '', setAttribute() {} }) },
      apiWrite,
      paintL1: () => {},
      loadMemory: async () => {},
      confirmDialog: async () => {
        // the list was reloaded under the open dialog: more entries, a newer revision
        mem.l1.memory = block({ entries: ['a', 'b', 'c'], revision: 'r-newer' });
        return true;
      },
    });
    await fns.l1Clear('memory');
    expect(apiWrite).toHaveBeenLastCalledWith('DELETE', '/api/memory/l1/memory', { revision: 'r1' });

    const pageApi = vi.fn(async () => ({ ok: true, data: {} }));
    const memPage: any = { page: { id: 'concepts/a', title: 'A' }, revision: 'pa' };
    const w = load<any>(['deletePage', 'memStatus'], [], {
      document: { getElementById: () => ({ textContent: '', setAttribute() {}, innerHTML: '' }) },
      _memPage: memPage,
      apiWrite: pageApi,
      confirmDialog: async () => {
        Object.assign(memPage, { page: { id: 'concepts/b', title: 'B' }, revision: 'pb' });
        return true;
      },
      refreshPageIndex: async () => {},
      renderPageEditor: () => {},
      paintPageList: () => {},
    });
    await w.deletePage();
    expect(pageApi).toHaveBeenCalledWith('DELETE', '/api/memory/page', { id: 'concepts/a', revision: 'pa' });
  });

  it('a 409 reloads the day the request was for, not the day the view moved to meanwhile (review R4)', async () => {
    const status: any = { textContent: '', setAttribute() {} };
    const loaded: string[] = [];
    const view: any = {
      date: '2026-10-20',
      revision: 'd1',
      entries: [{ time: '09:00', content: 'standup' }],
    };
    const days: Record<string, any> = {
      '2026-10-20': { date: '2026-10-20', revision: 'd2', entries: [{ time: '09:00', content: 'standup' }] },
      '2026-10-21': { date: '2026-10-21', revision: 'e1', entries: [{ time: '09:00', content: 'standup' }] },
    };
    const renderDay = vi.fn();
    let apiDone: (v: unknown) => void = () => {};
    const w = load<any>(['epWrite', 'memStatus'], [], {
      document: { getElementById: () => status },
      _memDay: view,
      apiWrite: () => new Promise((res) => (apiDone = res)),
      renderDay,
      loadDay: async (date: string) => {
        loaded.push(date);
        Object.assign(view, days[date]);
      },
    });
    const pending = w.epWrite(
      'PUT',
      '/api/memory/episodic/2026-10-20/0',
      { content: '20th standup corrected', revision: 'd1' },
      '20th standup corrected',
      0,
      'standup',
      '09:00',
    );
    // the user opens the 21st while the request is in flight
    Object.assign(view, days['2026-10-21']);
    apiDone({ ok: false, status: 409, error: 'conflict' });
    expect(await pending).toBe(false);
    expect(loaded).toEqual(['2026-10-20']);
    // the draft goes back to the 20th's record, shown again; the 21st's look-alike is untouched
    expect(view.date).toBe('2026-10-20');
    expect(renderDay).toHaveBeenLastCalledWith(0, '20th standup corrected');
  });

  it('a 409 on a day reloads it and reopens the edit with the whole draft (review P1)', async () => {
    const loadDay = vi.fn(async () => {});
    const renderDay = vi.fn();
    const status: any = { textContent: '', setAttribute() {} };
    const long = '긴 기록 '.repeat(100);
    const w = load<any>(['epWrite', 'memStatus'], [], {
      document: { getElementById: () => status },
      _memDay: {
        date: '2026-10-20',
        revision: 'd1',
        entries: [
          { time: '01:00', content: 'first' },
          { time: '02:00', content: 'second' },
        ],
      },
      apiWrite: async () => ({ ok: false, status: 409, error: 'conflict' }),
      renderDay,
      loadDay,
    });
    expect(
      await w.epWrite('PUT', '/api/memory/episodic/2026-10-20/1', { content: long, revision: 'd1' }, long, 1, 'second'),
    ).toBe(false);
    expect(loadDay).toHaveBeenCalledWith('2026-10-20');
    expect(renderDay).toHaveBeenLastCalledWith(1, long);
    expect(status.textContent).toContain('편집 칸에 그대로');
  });

  it('a page 409 keeps the editor as typed and offers overwrite with the newer revision (review P1)', async () => {
    const conflictBox: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = {
      'pg-title': 'My title',
      'pg-aliases': 'a',
      'pg-current': 'my long current',
    };
    const doc = {
      getElementById: (id: string) =>
        id === 'pg-conflict' ? conflictBox : id in values ? { value: values[id] } : status,
      querySelectorAll: () => [{ value: '2026-10-23: mine' }],
    };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: true, data: { page: { id: 'concepts/ssot' }, revision: 'p3' } });
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        page: { id: 'concepts/ssot', updated: '2026-10-23', current: 'agent wrote this' },
        revision: 'p2',
      }),
    }));
    const renderPageEditor = vi.fn();
    const openPage = vi.fn();
    const fns = load<any>(
      ['esc', 'pageDraft', 'savePage', 'memStatus', 'renderPageConflict', 'overwritePage'],
      ['_memPageConflict', '_memPageRaw'],
      {
        document: doc,
        fetch,
        _memPage: { page: { id: 'concepts/ssot' }, revision: 'p1' },
        apiWrite,
        refreshPageIndex: async () => {},
        renderPageEditor,
        openPage,
      },
    );
    await fns.savePage();
    expect(openPage).not.toHaveBeenCalled();
    expect(conflictBox.innerHTML).toContain('내 수정본으로 덮어쓰기');
    expect(conflictBox.innerHTML).toContain('agent wrote this');
    await fns.overwritePage();
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ current: 'my long current', title: 'My title', revision: 'p2' }),
    );
  });

  it('after a 409 and overwrite, the raw editor starts from the latest page, never the stale one (review R4)', async () => {
    const conflictBox: any = { innerHTML: '' };
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'Mine', 'pg-aliases': '', 'pg-current': 'my current' };
    const doc = {
      getElementById: (id: string) =>
        id === 'pg-conflict'
          ? conflictBox
          : id === 'mem-page-detail'
            ? detail
            : id in values
              ? { value: values[id] }
              : status,
      querySelectorAll: () => [],
    };
    const memPage: any = {
      page: { id: 'concepts/race', title: 'T', aliases: [], current: 'v1', history: [], updated: '2026-10-23' },
      revision: 'p1',
      raw: 'STALE RAW v1\n',
      representable: true,
    };
    // Meanwhile the agent added a sub-heading: the latest page no longer fits the form.
    const latest = {
      page: { ...memPage.page, current: 'v2' },
      revision: 'p2',
      raw: 'LATEST RAW v2\n## Details\nagent text\n',
      representable: false,
    };
    const apiWrite = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'conflict' })
      .mockResolvedValueOnce({ ok: false, status: 400, error: '원문(markdown)으로 고치세요' });
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'overwritePage',
        'renderPageEditor',
        'pageRawMode',
      ],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        fetch: vi.fn(async () => ({ ok: true, json: async () => latest })),
        _memPage: memPage,
        apiWrite,
        refreshPageIndex: async () => {},
        openPage: vi.fn(),
      },
    );
    await fns.savePage();
    await fns.overwritePage();
    // the overwrite went out on the form path the user was editing in, with the newer revision
    expect(apiWrite).toHaveBeenLastCalledWith('PUT', '/api/memory/page', expect.objectContaining({ revision: 'p2' }));
    // the server refused it (the latest page needs raw editing); raw mode shows the latest bytes
    fns.pageRawMode(true);
    expect(detail.innerHTML).toContain('LATEST RAW v2');
    expect(detail.innerHTML).not.toContain('STALE RAW');
  });

  it('a save that fails after another page was opened keeps the draft: reopening the page puts it back beside the newer version (self-check before review R6)', async () => {
    let detailHtml = '';
    const status: any = { textContent: '', setAttribute() {} };
    const conflict: any = { innerHTML: '' };
    // the form the user typed into: page A's draft
    const values: Record<string, string> = {
      'pg-title': 'A title',
      'pg-aliases': 'x, y',
      'pg-current': 'my long draft',
    };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail'
          ? {
              set innerHTML(v: string) {
                detailHtml = v;
              },
              get innerHTML() {
                return detailHtml;
              },
            }
          : id === 'pg-conflict'
            ? conflict
            : id in values
              ? { value: values[id] }
              : status,
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const pageA2 = { ...pageA, current: 'a, changed by the agent', updated: '2026-10-24' };
    const pageB = { id: 'concepts/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    let answerA: (v: unknown) => void = () => {};
    const apiWrite = vi.fn().mockImplementationOnce(() => new Promise((res) => (answerA = res)));
    const pages: Record<string, unknown> = {
      'concepts/a': { page: pageA2, revision: 'a2', raw: '# A\n', representable: true },
      'concepts/b': { page: pageB, revision: 'b1', raw: '# B\n', representable: true },
    };
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'pageAnswerElsewhere',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'openPage',
      ],
      ['_memPageConflict', '_memPageRaw', '_memPageUnsent', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite,
        fetch: vi.fn(async (url: string) => {
          const id = decodeURIComponent(String(url).split('id=')[1]);
          return { ok: true, json: async () => pages[id] };
        }),
        refreshPageIndex: async () => {},
        paintPageList: () => {},
      },
    );
    const savingA = fns.savePage(); // A's save goes out ...
    await fns.openPage('concepts/b'); // ... the user opens B ...
    answerA({ ok: false, status: 409, error: 'changed' }); // ... and A's save is refused
    await savingA;
    expect(status.textContent).toContain('보관');
    expect(detailHtml).toContain('concepts/b'); // B stays open, untouched
    await fns.openPage('concepts/a');
    // the draft is back in the editor, and the newer version is offered beside it
    expect(detailHtml).toContain('my long draft');
    expect(detailHtml).toContain('A title');
    expect(conflict.innerHTML).toContain('덮어쓰기');
    // opened once more, the page is the stored one (the draft is handed back once)
    await fns.openPage('concepts/a');
    expect(detailHtml).not.toContain('my long draft');
  });

  it('a save answer that arrives after another page was opened never retargets the open editor (review R5)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    // what the editor shows: page B, as the user typed into it
    const values: Record<string, string> = { 'pg-title': 'B title', 'pg-aliases': '', 'pg-current': 'b user edit' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : { innerHTML: '', ...status },
      querySelectorAll: () => [],
    };
    const pageA = { id: 'concepts/a', title: 'A', aliases: [], current: 'a', history: [], updated: '2026-10-23' };
    const pageB = { id: 'concepts/b', title: 'B', aliases: [], current: 'b', history: [], updated: '2026-10-23' };
    let answerA: (v: unknown) => void = () => {};
    const apiWrite = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (answerA = res)))
      .mockResolvedValue({
        ok: true,
        data: { ok: true, page: pageB, revision: 'b2', raw: '# B\n', representable: true },
      });
    const pendingIndex: Array<() => void> = [];
    const fns = load<any>(
      [
        'esc',
        'escAttr',
        'pageDraft',
        'savePage',
        'memStatus',
        'renderPageConflict',
        'renderPageEditor',
        'openPage',
        'pageAnswerElsewhere',
      ],
      ['_memPageConflict', '_memPageRaw', '_memPageUnsent', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: pageA, revision: 'a1', raw: '# A\n', representable: true },
        apiWrite,
        fetch: vi.fn(async () => ({
          ok: true,
          json: async () => ({ page: pageB, revision: 'b1', raw: '# B\n', representable: true }),
        })),
        refreshPageIndex: () => new Promise<void>((res) => pendingIndex.push(res)),
        paintPageList: () => {},
      },
    );
    const savingA = fns.savePage(); // the save of A goes out ...
    await fns.openPage('concepts/b'); // ... and the user opens B before it is answered
    answerA({
      ok: true,
      data: { ok: true, page: { ...pageA, title: 'A' }, revision: 'a2', raw: '# A\n', representable: true },
    });
    await Promise.resolve();
    await Promise.resolve();
    // while the page list refreshes, the user saves B
    const savingB = fns.savePage();
    // let both saves finish: every page-list refresh completes
    for (let k = 0; k < 10; k++) {
      while (pendingIndex.length) pendingIndex.shift()?.();
      await Promise.resolve();
    }
    await Promise.all([savingA, savingB]);
    expect(apiWrite).toHaveBeenLastCalledWith(
      'PUT',
      '/api/memory/page',
      expect.objectContaining({ id: 'concepts/b', revision: 'b1', current: 'b user edit' }),
    );
    expect(detail.innerHTML).not.toContain('concepts/a');
  });

  it('a successful form save keeps the saved raw markdown for a later switch to raw editing (review R4)', async () => {
    const detail: any = { innerHTML: '' };
    const status: any = { textContent: '', setAttribute() {} };
    const values: Record<string, string> = { 'pg-title': 'T', 'pg-aliases': '', 'pg-current': 'v2' };
    const doc = {
      getElementById: (id: string) =>
        id === 'mem-page-detail' ? detail : id in values ? { value: values[id] } : { innerHTML: '', ...status },
      querySelectorAll: () => [],
    };
    const page = { id: 'concepts/kept', title: 'T', aliases: [], current: 'v2', history: [], updated: '2026-10-23' };
    const apiWrite = vi.fn().mockResolvedValueOnce({
      ok: true,
      data: { ok: true, page, revision: 'p2', raw: 'SAVED RAW v2\n', representable: true },
    });
    const fns = load<any>(
      ['esc', 'escAttr', 'pageDraft', 'savePage', 'memStatus', 'renderPageConflict', 'renderPageEditor', 'pageRawMode'],
      ['_memPageConflict', '_memPageRaw', 'PAGE_GROUPS'],
      {
        document: doc,
        _memPage: { page: { ...page, current: 'v1' }, revision: 'p1', raw: 'OLD RAW v1\n', representable: true },
        apiWrite,
        refreshPageIndex: async () => {},
      },
    );
    await fns.savePage();
    fns.pageRawMode(true);
    expect(detail.innerHTML).toContain('SAVED RAW v2');
  });
});
