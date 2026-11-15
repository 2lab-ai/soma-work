/**
 * #1080 — the cron drawer's 내용 보기 and 편집, client half. Executes the shipped
 * client code cut out of renderDashboardPage()'s template literal, cooked
 * exactly as the browser receives it (the harness of
 * dashboard-view-mode-client.test.ts), with injected fakes.
 *
 *   gate     the short facts offer 내용 보기 to the owner or an admin with
 *            관리자 모드 on, one plain line to everyone else — never the prompt
 *   detail   내용 보기 loads GET /api/dashboard/cron/:id; the facts become the
 *            whole job (every field, the prompt as written)
 *   form     편집 draws the form once, from a draft; typing goes to the draft;
 *            a board render never repaints an open form; 취소 discards it
 *   save     저장 PATCHes only what changed, with the CSRF token (one retry);
 *            success repaints and reloads the lane, a refusal keeps the form
 *            and says the server's reason next to it
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { viewerScope } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function declarationCount(name: string): number {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name.replace(/[$]/g, '\\$')}\\b`, 'gm');
  return (TEMPLATE.match(re) ?? []).length;
}
function clientFn(name: string): string {
  const n = declarationCount(name);
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  let start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
const STATE = 'function __state() { return _cronDetail; }\nfunction __setState(v) { _cronDetail = v; }';
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${STATE}\nreturn { ${[...fns, '__state', '__setState'].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

/** An element as these functions touch it: markup, text, attributes, focus. */
function fakeEl(id = '', found: Record<string, any> = {}) {
  const attrs: Record<string, string> = {};
  let html = '';
  const el: any = {
    id,
    hidden: false,
    textContent: '',
    value: '',
    htmlSets: 0,
    get innerHTML() {
      return html;
    },
    set innerHTML(v: string) {
      html = v;
      el.htmlSets++;
    },
    setAttribute: (k: string, v: unknown) => {
      attrs[k] = String(v);
    },
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    removeAttribute: (k: string) => {
      delete attrs[k];
    },
    focus: vi.fn(),
    querySelector: (sel: string) => found[sel] ?? null,
  };
  return el;
}
function fakeDoc(els: Record<string, any>) {
  return { getElementById: (id: string) => els[id] ?? null };
}

const T0 = Date.parse('2026-11-09T08:30:00Z');
const LANE_JOB = {
  id: 'job-1',
  name: 'nightly-qa',
  expression: '0 9 * * 1-5',
  owner: 'U_OWNER',
  channel: 'C0001',
  mode: 'default',
  target: 'channel',
  model: 'default',
  nextRunAt: Date.parse('2026-11-09T09:00:00Z'),
  lastRunAt: null,
  historyCap: 20,
  runs: [],
};
const GROUP = { key: 'id:job-1', jobId: 'job-1', name: 'nightly-qa', job: LANE_JOB, cards: [] };
const DETAIL = {
  id: 'job-1',
  name: 'nightly-qa',
  expression: '0 9 * * 1-5',
  prompt: 'check <the> "queue"\nthen report & stop',
  owner: 'U_OWNER',
  channel: 'C0001',
  threadTs: null,
  mode: 'default',
  target: 'channel',
  model: { type: 'default' },
  runAllowlist: [],
  createdAt: Date.parse('2026-10-01T00:00:00Z'),
  scheduleChangedAt: null,
  lastRunAt: Date.parse('2026-11-08T09:00:00Z'),
  nextRunAt: Date.parse('2026-11-09T09:00:00Z'),
};
// The words the facts are drawn with: their own functions, pinned elsewhere.
const FACT_ENV = {
  cronScheduleLabel: () => '평일 18:00',
  capClockLabel: () => '18:00',
  cronCountdownHtml: () => '<ui-elapsed></ui-elapsed>',
  cronRunWhen: () => '11/8 18:00 · 1일 전',
};
// The facts open with the job's actions (지금 실행 · 편집 · 삭제 — pinned in dashboard-cron-actions-client.test.ts).
const META_FNS = [
  'esc',
  'escAttr',
  'cronDetailAllowed',
  'cronDetailGate',
  'cronDetailWhen',
  'cronArmed',
  'cronActionBar',
  'cronArmedSaid',
  'renderCronDetail',
];
const META_VARS = [
  '_cronDetail',
  'CRON_MODE_LABEL',
  'CRON_TARGET_LABEL',
  'CRON_MODEL_LABEL',
  'CRON_ACT_LABEL',
  'CRON_ARMED_SAID',
  'CRON_NOTE_OTHERS',
  'CRON_ARMED_SAID_POST',
];

describe('gate — 내용 보기 for whoever may manage the job, one plain line for everyone else', () => {
  type Meta = { renderCronDrawerMeta(g: unknown, now: number): string; __setState(v: unknown): void };
  const meta = (viewer: Record<string, unknown>) =>
    load<Meta>([...META_FNS, 'renderCronDrawerMeta'], META_VARS, { ...FACT_ENV, ...viewer });

  it('the owner and an admin with 관리자 모드 on get 내용 보기; the prompt is not on the page yet', () => {
    for (const viewer of [
      { currentUserId: 'U_OWNER' },
      { currentUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => true },
    ]) {
      const html = meta(viewer).renderCronDrawerMeta(GROUP, T0);
      expect(html).toContain('data-cron-act="detail"');
      expect(html).toContain('내용 보기');
      expect(html).not.toContain('cron-prompt');
      // The short facts stay as they were.
      expect(html).toContain('<dl class="ui-dl">');
    }
  });

  it('anyone else — an admin with 관리자 모드 off too — gets one plain line and no control', () => {
    for (const viewer of [
      { currentUserId: 'U_STRANGER' },
      { currentUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => false },
    ]) {
      const html = meta(viewer).renderCronDrawerMeta(GROUP, T0);
      expect(html).not.toContain('data-cron-act');
      expect(html).toContain('<p class="cron-detail-note">');
      expect(html).toContain('관리자 모드');
    }
  });

  it('once 내용 보기 loaded it, the facts are the whole job: every field, the prompt as written, escaped', () => {
    const f = meta({ currentUserId: 'U_OWNER' });
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: null });
    const html = f.renderCronDrawerMeta(GROUP, T0);
    const labels = [
      '스케줄',
      '다음 실행',
      '프롬프트',
      '채널',
      '스레드',
      '실행 방식',
      '출력',
      '모델',
      '수동 실행 허용',
      '소유자',
      '만든 때',
      '스케줄 바꾼 때',
      '마지막 실행',
    ];
    let at = -1;
    for (const l of labels) {
      const i = html.indexOf(`<dt>${l}</dt>`);
      expect(i, l).toBeGreaterThan(at);
      at = i;
    }
    expect(html).toContain(
      '<pre class="cron-prompt">check &lt;the&gt; &quot;queue&quot;\nthen report &amp; stop</pre>',
    );
    expect(html).toContain('0 9 * * 1-5 (UTC)');
    expect(html).toContain('C0001');
    expect(html).toContain('U_OWNER');
    expect(html).toContain('<time datetime="2026-11-08T09:00:00.000Z">');
    expect(html).toContain('data-cron-act="edit"');
    expect(html).toContain('data-cron-act="hide"');
    // Another job's loaded detail is not this one's.
    f.__setState({ key: 'id:job-2', jobId: 'job-2', job: DETAIL, draft: null });
    expect(f.renderCronDrawerMeta(GROUP, T0)).not.toContain('cron-prompt');
  });

  it('a custom model reads its id, the others their words; grants list who may run it', () => {
    const f = meta({ currentUserId: 'U_OWNER' });
    f.__setState({
      key: GROUP.key,
      job: {
        ...DETAIL,
        model: { type: 'custom', model: 'claude-sonnet-4-20250514' },
        runAllowlist: ['U_A', 'U_B'],
        threadTs: '1700.1',
        target: 'thread',
        mode: 'fastlane',
      },
    });
    const html = f.renderCronDrawerMeta(GROUP, T0);
    expect(html).toContain('<dt>모델</dt><dd>claude-sonnet-4-20250514</dd>');
    expect(html).toContain('<dt>수동 실행 허용</dt><dd>U_A, U_B</dd>');
    expect(html).toContain('<dt>스레드</dt><dd>1700.1</dd>');
    expect(html).toContain('<dt>실행 방식</dt><dd>항상 새 스레드</dd>');
  });
});

describe('detail — 내용 보기 asks the server for the whole job', () => {
  type F = { cronDetailLoad(): Promise<void>; __state(): any; __setState(v: unknown): void };
  function env(answer: { status: number; body: unknown } | 'offline', viewer: Record<string, unknown> = {}) {
    const status = fakeEl('cron-detail-status');
    const edit = fakeEl('edit');
    const metaEl = fakeEl('cron-drawer-meta', { '[data-cron-act="edit"]': edit });
    const fetch = vi.fn(async () => {
      if (answer === 'offline') throw new Error('offline');
      return { ok: answer.status < 300, status: answer.status, json: async () => answer.body };
    });
    const paintCronDrawer = vi.fn();
    const f = load<F>(
      [
        'cronDrawerGroup',
        'cronDetailAllowed',
        'cronDetailStatus',
        'cronDetailFocus',
        'cronDetailError',
        'cronDetailLoad',
      ],
      ['_cronDetail'],
      {
        currentUserId: 'U_OWNER',
        ...viewer,
        fetch,
        paintCronDrawer,
        document: fakeDoc({ 'cron-detail-status': status, 'cron-drawer-meta': metaEl }),
        _cronPlan: { groups: [GROUP] },
        _cronDrawerKey: GROUP.key,
      },
    );
    return { f, fetch, paintCronDrawer, status, edit };
  }

  it('loads the job by id and paints it; focus goes to 편집', async () => {
    const e = env({ status: 200, body: { job: DETAIL } });
    await e.f.cronDetailLoad();
    // A GET: the page's fetch wrapper adds X-Admin-Mode to writes only, so the read says it itself (fable P1).
    expect(e.fetch).toHaveBeenCalledWith('/api/dashboard/cron/job-1', { headers: { 'X-Admin-Mode': 'off' } });
    expect(e.f.__state()).toMatchObject({ key: 'id:job-1', jobId: 'job-1', job: DETAIL, loading: false, draft: null });
    expect(e.paintCronDrawer).toHaveBeenCalled();
    expect(e.status.textContent).toBe('');
    expect(e.edit.focus).toHaveBeenCalled();
  });

  it('a refusal says why in the status line and leaves no job: the owner-only words for 403, else the server’s', async () => {
    const forbidden = env({ status: 403, body: { error: 'Forbidden — …' } });
    await forbidden.f.cronDetailLoad();
    expect(forbidden.f.__state().job).toBeNull();
    expect(forbidden.status.textContent).toBe('소유자나 관리자 모드를 켠 관리자만 할 수 있어요');
    expect(forbidden.status.getAttribute('data-tone')).toBe('fail');
    const gone = env({ status: 404, body: { error: '크론 잡을 찾을 수 없어요' } });
    await gone.f.cronDetailLoad();
    expect(gone.status.textContent).toBe('크론 잡을 찾을 수 없어요');
    const broken = env({ status: 500, body: null });
    await broken.f.cronDetailLoad();
    expect(broken.status.textContent).toContain('HTTP 500');
    const offline = env('offline');
    await offline.f.cronDetailLoad();
    expect(offline.status.textContent).not.toBe('');
  });

  it('an admin in 관리자 모드 reads someone else’s job with X-Admin-Mode: on — the server gate needs it on a GET too', async () => {
    const e = env(
      { status: 200, body: { job: DETAIL } },
      { currentUserId: 'U_OWNER', _viewerUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => true },
    );
    await e.f.cronDetailLoad();
    expect(e.fetch).toHaveBeenCalledWith('/api/dashboard/cron/job-1', { headers: { 'X-Admin-Mode': 'on' } });
    expect(e.f.__state().job).toEqual(DETAIL);
  });

  it('asks nothing for a viewer who may not see it', async () => {
    const e = env({ status: 200, body: { job: DETAIL } }, { currentUserId: 'U_STRANGER' });
    await e.f.cronDetailLoad();
    expect(e.fetch).not.toHaveBeenCalled();
    expect(e.f.__state()).toBeNull();
  });

  it('an answer for a drawer that moved on is dropped', async () => {
    const e = env({ status: 200, body: { job: DETAIL } });
    const loading = e.f.cronDetailLoad();
    e.f.__setState(null); // the drawer closed meanwhile
    await loading;
    expect(e.f.__state()).toBeNull();
  });
});

describe('form — drawn once from a draft; a board render never repaints it', () => {
  type P = { paintCronDrawer(): void; __state(): any; __setState(v: unknown): void };
  function painter(viewer: Record<string, unknown> = { currentUserId: 'U_OWNER' }) {
    const els: Record<string, any> = {
      'cron-drawer-title': fakeEl(),
      'cron-drawer-badge': fakeEl(),
      'cron-drawer-meta': fakeEl(),
      'cron-drawer-body': fakeEl(),
      'cron-detail-status': fakeEl(),
    };
    const renderCronDrawerMeta = vi.fn(() => 'META');
    const f = load<P>(
      ['cronDrawerGroup', 'cronDetailAllowed', 'cronDetailStatus', 'paintCronDrawer'],
      ['_cronDetail'],
      {
        ...viewer,
        document: fakeDoc(els),
        _cronPlan: { groups: [GROUP] },
        _cronDrawerKey: GROUP.key,
        renderCronDrawerMeta,
        cronGroupRuns: () => [],
        renderCronRunRow: () => '',
        closeCronDrawer: vi.fn(),
        CLOCK_SVG: '',
      },
    );
    return { f, els, renderCronDrawerMeta };
  }

  it('an open form keeps what is typed: the meta is left alone while the draft is open', () => {
    const p = painter();
    p.f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: { name: 'typed' } });
    p.els['cron-drawer-meta'].innerHTML = 'FORM';
    p.f.paintCronDrawer();
    p.f.paintCronDrawer();
    expect(p.els['cron-drawer-meta'].innerHTML).toBe('FORM');
    expect(p.renderCronDrawerMeta).not.toHaveBeenCalled();
    expect(p.f.__state().draft).toEqual({ name: 'typed' });
    // Closed: the facts again.
    p.f.__state().draft = null;
    p.f.paintCronDrawer();
    expect(p.els['cron-drawer-meta'].innerHTML).toBe('META');
  });

  it('the same facts are not written again (focus on 편집 stays through a board render)', () => {
    const p = painter();
    p.f.paintCronDrawer();
    p.f.paintCronDrawer();
    p.f.paintCronDrawer();
    expect(p.els['cron-drawer-meta'].htmlSets).toBe(1);
  });

  it('the whole job goes when the viewer may no longer see it (관리자 모드 off) or the drawer shows another job', () => {
    let adminMode = true;
    const p = painter({ currentUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => adminMode });
    p.f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: { name: 'typed' }, say: '저장했어요' });
    p.f.paintCronDrawer();
    expect(p.f.__state()).not.toBeNull();
    adminMode = false;
    p.f.paintCronDrawer();
    expect(p.f.__state()).toBeNull();
    expect(p.els['cron-drawer-meta'].innerHTML).toBe('META');
    expect(p.els['cron-detail-status'].textContent).toBe('');
    const q = painter();
    q.f.__setState({ key: 'id:job-2', jobId: 'job-2', job: DETAIL, draft: null });
    q.f.paintCronDrawer();
    expect(q.f.__state()).toBeNull();
  });

  type E = {
    cronDetailEdit(): void;
    cronDetailCancel(): void;
    onCronDetailInput(e: unknown): void;
    onCronDetailClick(e: unknown): void;
    __state(): any;
    __setState(v: unknown): void;
  };
  function editor(job: Record<string, unknown> = DETAIL) {
    const name = fakeEl('cron-edit-name');
    const editBtn = fakeEl('edit');
    const meta = fakeEl('cron-drawer-meta', { '#cron-edit-name': name, '[data-cron-act="edit"]': editBtn });
    const row = fakeEl('cron-edit-model-id-row');
    const paintCronDrawer = vi.fn();
    const f = load<E>(
      [
        'esc',
        'escAttr',
        'cronDraftOf',
        'cronEditOptions',
        'renderCronEditForm',
        'cronDetailStatus',
        'cronDetailFocus',
        'cronDetailEdit',
        'cronDetailCancel',
        'onCronDetailInput',
      ],
      META_VARS,
      {
        document: fakeDoc({
          'cron-drawer-meta': meta,
          'cron-detail-status': fakeEl(),
          'cron-edit-model-id-row': row,
        }),
        paintCronDrawer,
      },
    );
    f.__setState({ key: GROUP.key, jobId: 'job-1', job, draft: null, say: '저장했어요', tone: 'done' });
    return { f, meta, name, row, paintCronDrawer, editBtn };
  }

  it('편집 draws every field from the job, focus on 이름; the prompt keeps a leading line break', () => {
    const e = editor({ ...DETAIL, prompt: '\nfirst line blank' });
    e.f.cronDetailEdit();
    const html = e.meta.innerHTML;
    expect(e.f.__state().draft).toEqual({
      name: 'nightly-qa',
      expression: '0 9 * * 1-5',
      prompt: '\nfirst line blank',
      channel: 'C0001',
      mode: 'default',
      target: 'channel',
      modelType: 'default',
      modelId: '',
    });
    expect(e.f.__state().say).toBe('');
    expect(html).toContain('<form class="cron-edit" id="cron-edit-form"');
    expect(html).toContain('id="cron-edit-name" data-cron-field="name" value="nightly-qa"');
    expect(html).toContain('id="cron-edit-expression" data-cron-field="expression" value="0 9 * * 1-5"');
    expect(html).toContain('id="cron-edit-channel" data-cron-field="channel" value="C0001"');
    // The parser drops one line break right after <textarea>: the page writes one, so the prompt's own stays.
    expect(html).toMatch(/data-cron-field="prompt"[^>]*>\n\nfirst line blank<\/textarea>/);
    expect(html).toContain('UTC');
    expect(html).toContain('<option value="fastlane">항상 새 스레드</option>');
    // No thread anchor: the dashboard cannot pick a Slack thread, so a thread reply is not offered.
    expect(html).toMatch(/<option value="thread" disabled>/);
    expect(html).toMatch(/id="cron-edit-model-id-row" hidden/);
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-cron-act="cancel"');
    expect(e.name.focus).toHaveBeenCalled();
    expect(e.paintCronDrawer).not.toHaveBeenCalled();
  });

  it('a job with an anchor and a custom model: the thread reply is offered, the id row shown', () => {
    const e = editor({ ...DETAIL, threadTs: '1700.1', target: 'thread', model: { type: 'custom', model: 'm-1' } });
    e.f.cronDetailEdit();
    const html = e.meta.innerHTML;
    expect(html).toContain('<option value="thread" selected>');
    expect(html).not.toMatch(/id="cron-edit-model-id-row" hidden/);
    expect(html).toContain('data-cron-field="modelId" value="m-1"');
    expect(e.f.__state().draft).toMatchObject({ target: 'thread', modelType: 'custom', modelId: 'm-1' });
  });

  it('typing goes to the draft; picking 직접 입력 shows the model id', () => {
    const e = editor();
    e.f.cronDetailEdit();
    const input = (field: string, value: string) => {
      const t = fakeEl();
      t.setAttribute('data-cron-field', field);
      t.setAttribute('aria-invalid', 'true');
      t.value = value;
      e.f.onCronDetailInput({ target: t });
      return t;
    };
    const typed = input('prompt', 'a new prompt');
    expect(e.f.__state().draft.prompt).toBe('a new prompt');
    expect(typed.getAttribute('aria-invalid')).toBeNull();
    e.row.hidden = true;
    input('modelType', 'custom');
    expect(e.row.hidden).toBe(false);
    input('modelType', 'opus');
    expect(e.row.hidden).toBe(true);
    // Not a form field, or no form open: nothing.
    e.f.onCronDetailInput({ target: fakeEl() });
    e.f.__state().draft = null;
    input('name', 'x');
    expect(e.f.__state().draft).toBeNull();
  });

  it('취소 discards the draft and paints the facts again', () => {
    const e = editor();
    e.f.cronDetailEdit();
    e.f.cronDetailCancel();
    expect(e.f.__state().draft).toBeNull();
    expect(e.paintCronDrawer).toHaveBeenCalledTimes(1);
  });
});

describe('save — only what changed, with the CSRF token; a refusal keeps the form', () => {
  it('cronEditPatch: nothing changed is nothing; each changed field as the server takes it', () => {
    const { cronEditPatch, cronDraftOf } = load<{
      cronEditPatch(j: unknown, d: unknown): Record<string, unknown>;
      cronDraftOf(j: unknown): Record<string, string>;
    }>(['cronDraftOf', 'cronEditPatch'], []);
    const draft = () => cronDraftOf(DETAIL);
    expect(cronEditPatch(DETAIL, draft())).toEqual({});
    expect(cronEditPatch(DETAIL, { ...draft(), name: ' morning-qa ', expression: ' 0 0 * * 1-5 ' })).toEqual({
      name: 'morning-qa',
      expression: '0 0 * * 1-5',
    });
    expect(
      cronEditPatch(DETAIL, { ...draft(), prompt: 'p', channel: 'C0002 ', mode: 'fastlane', target: 'dm' }),
    ).toEqual({ prompt: 'p', channel: 'C0002', mode: 'fastlane', target: 'dm' });
    expect(cronEditPatch(DETAIL, { ...draft(), modelType: 'opus' })).toEqual({ model: { type: 'opus' } });
    expect(cronEditPatch(DETAIL, { ...draft(), modelType: 'custom', modelId: ' m-1 ' })).toEqual({
      model: { type: 'custom', model: 'm-1' },
    });
    // A custom model whose id changed is a change; the id of another type is not sent.
    const custom = { ...DETAIL, model: { type: 'custom', model: 'm-1' } };
    expect(cronEditPatch(custom, { ...cronDraftOf(custom), modelId: 'm-2' })).toEqual({
      model: { type: 'custom', model: 'm-2' },
    });
    expect(cronEditPatch(DETAIL, { ...draft(), modelId: 'stray' })).toEqual({});
  });

  type S = { cronDetailSave(): Promise<void>; __state(): any; __setState(v: unknown): void };
  function saver(answers: Array<{ status: number; body: unknown }>) {
    const fields: Record<string, any> = {};
    for (const id of ['name', 'expression', 'prompt', 'channel', 'mode', 'target', 'model', 'model-id'])
      fields[`cron-edit-${id}`] = fakeEl(`cron-edit-${id}`);
    const save = fakeEl('cron-edit-save');
    const status = fakeEl('cron-detail-status');
    const editBtn = fakeEl('edit');
    const meta = fakeEl('cron-drawer-meta', { '[data-cron-act="edit"]': editBtn });
    const fetch = vi.fn(async (_url: string, _init: any) => {
      const a = answers.shift()!;
      const res: any = { ok: a.status < 300, status: a.status, json: async () => a.body };
      res.clone = () => ({ json: async () => a.body });
      return res;
    });
    const refreshCsrfToken = vi.fn(async () => {});
    const paintCronDrawer = vi.fn();
    const loadCronJobs = vi.fn();
    const f = load<S>(
      [
        'cronDraftOf',
        'cronEditPatch',
        'cronDetailWrite',
        'cronEditBusy',
        'cronEditInvalid',
        'cronDetailError',
        'cronDetailStatus',
        'cronDetailFocus',
        'cronDetailCancel',
        'cronDetailSave',
      ],
      ['_cronDetail'],
      {
        fetch,
        refreshCsrfToken,
        paintCronDrawer,
        loadCronJobs,
        _csrfToken: 'tok-1',
        document: fakeDoc({
          ...fields,
          'cron-edit-save': save,
          'cron-detail-status': status,
          'cron-drawer-meta': meta,
        }),
      },
    );
    const draft = {
      name: 'nightly-qa',
      expression: '0 0 * * 1-5',
      prompt: DETAIL.prompt,
      channel: 'C0001',
      mode: 'default',
      target: 'channel',
      modelType: 'default',
      modelId: '',
    };
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft, saving: false });
    return { f, fetch, refreshCsrfToken, paintCronDrawer, loadCronJobs, status, save, fields, draft, editBtn };
  }

  it('success: the change goes as a PATCH with the token, the detail repaints, the lane reloads', async () => {
    const fresh = { ...DETAIL, expression: '0 0 * * 1-5', scheduleChangedAt: T0 };
    const s = saver([{ status: 200, body: { job: fresh } }]);
    await s.f.cronDetailSave();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = s.fetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/cron/job-1');
    expect(init.method).toBe('PATCH');
    expect(init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(JSON.parse(init.body)).toEqual({ expression: '0 0 * * 1-5' });
    expect(s.f.__state()).toMatchObject({ job: fresh, draft: null, saving: false });
    expect(s.paintCronDrawer).toHaveBeenCalled();
    expect(s.loadCronJobs).toHaveBeenCalledTimes(1);
    expect(s.status.textContent).toBe('저장했어요');
    expect(s.editBtn.focus).toHaveBeenCalled();
  });

  it('a refusal keeps the form and the typed values, says the server’s reason, and marks the field', async () => {
    const s = saver([{ status: 400, body: { error: '스케줄은 5칸 cron 식이어야 해요', field: 'expression' } }]);
    await s.f.cronDetailSave();
    expect(s.f.__state().draft).toBe(s.draft);
    expect(s.f.__state().saving).toBe(false);
    expect(s.paintCronDrawer).not.toHaveBeenCalled();
    expect(s.loadCronJobs).not.toHaveBeenCalled();
    expect(s.status.textContent).toBe('스케줄은 5칸 cron 식이어야 해요');
    expect(s.status.getAttribute('data-tone')).toBe('fail');
    expect(s.fields['cron-edit-expression'].getAttribute('aria-invalid')).toBe('true');
    expect(s.fields['cron-edit-expression'].focus).toHaveBeenCalled();
    expect(s.save.getAttribute('aria-busy')).toBeNull();
  });

  it('a 403 refreshes the CSRF token and tries once more', async () => {
    const s = saver([
      { status: 403, body: { error: 'CSRF token validation failed', code: 'csrf_failed' } },
      { status: 200, body: { job: DETAIL } },
    ]);
    await s.f.cronDetailSave();
    expect(s.refreshCsrfToken).toHaveBeenCalledTimes(1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.f.__state().draft).toBeNull();
  });

  it('a 403 that is a refusal, not the token, says the owner-only words — and is not sent again', async () => {
    const s = saver([{ status: 403, body: { error: 'Forbidden' } }]);
    await s.f.cronDetailSave();
    expect(s.refreshCsrfToken).not.toHaveBeenCalled();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.status.textContent).toBe('소유자나 관리자 모드를 켠 관리자만 할 수 있어요');
    expect(s.f.__state().draft).toBe(s.draft);
  });

  it('nothing changed: no request, the form closes', async () => {
    const s = saver([]);
    s.f.__state().draft = { ...s.draft, expression: DETAIL.expression };
    await s.f.cronDetailSave();
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.f.__state().draft).toBeNull();
    expect(s.paintCronDrawer).toHaveBeenCalled();
  });
});

describe('page wiring', () => {
  it('the drawer answers its own controls, the form’s typing and its 저장; closing it drops the whole job', () => {
    expect(TEMPLATE).toContain("if (d) d.addEventListener('click', onCronDetailClick);");
    expect(TEMPLATE).toContain("if (d) d.addEventListener('input', onCronDetailInput);");
    expect(TEMPLATE).toContain(
      "if (d) d.addEventListener('submit', function(e) { e.preventDefault(); cronDetailSave(); });",
    );
    expect(clientFn('closeCronDrawer')).toContain('_cronDetail = null;');
    // The status line sits between the facts and the runs, outside what a render repaints.
    expect(TEMPLATE).toMatch(
      /id="cron-drawer-meta"><\/div>\s*<p class="ui-status-line cron-detail-status" id="cron-detail-status" role="status" aria-live="polite"><\/p>\s*<div class="cron-drawer-body"/,
    );
  });

  it('the buttons route by their action', () => {
    const calls: string[] = [];
    const f = load<{ onCronDetailClick(e: unknown): void }>(['onCronDetailClick'], [], {
      cronDetailLoad: () => calls.push('load'),
      cronDetailEdit: () => calls.push('edit'),
      cronDetailCancel: () => calls.push('cancel'),
      cronDetailHide: () => calls.push('hide'),
    });
    for (const act of ['detail', 'edit', 'cancel', 'hide', 'other']) {
      const b = fakeEl();
      b.setAttribute('data-cron-act', act);
      f.onCronDetailClick({ target: { closest: (sel: string) => (sel === '[data-cron-act]' ? b : null) } });
    }
    f.onCronDetailClick({ target: { closest: () => null } });
    expect(calls).toEqual(['load', 'edit', 'cancel', 'hide']);
  });
});
