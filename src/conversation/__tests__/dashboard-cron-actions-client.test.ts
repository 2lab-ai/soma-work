/**
 * The cron drawer's actions, client half: 지금 실행 · 편집 · 삭제 in one row above the facts, for whoever may manage
 * the job (its owner, or an admin with 관리자 모드 on). Executes the shipped client code cut out of
 * renderDashboardPage()'s template literal (the harness of dashboard-cron-edit-client.test.ts), with injected fakes.
 *
 *   bar      the row is there for the owner and an admin in 관리자 모드, in the short facts and the whole job alike;
 *            nobody else gets a control; an open form has its own 저장 / 취소 instead
 *   edit     편집 is one press: from the short facts it loads the job, then opens the form
 *   confirm  지금 실행 and 삭제 cannot be undone, so each asks once (the page's armed press, 4 s): the label says to
 *            press again, a line under the row says what follows; a second press under 0.4 s is a doubled click
 *   run      the second press POSTs …/run with the CSRF token; the drawer says what the scheduler said; the lane
 *            reloads
 *   delete   the second press DELETEs; the drawer closes, the lane drops the job, a toast says so; a refusal stays
 *            in the drawer
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageText, registerPageCatalog, scanPage } from '@soma/common/i18n-page';
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
const STATE =
  'function __state() { return _cronDetail; }\nfunction __setState(v) { _cronDetail = v; }\nfunction __jobs() { return _cronJobs; }';
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n${STATE}\nreturn { ${[...fns, '__state', '__setState', '__jobs'].join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

function fakeEl(id = '', found: Record<string, any> = {}) {
  const attrs: Record<string, string> = {};
  const el: any = {
    id,
    textContent: '',
    innerHTML: '',
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
  prompt: 'check the queue',
  owner: 'U_OWNER',
  channel: 'C0001',
  threadTs: null,
  mode: 'default',
  target: 'channel',
  model: { type: 'default' },
  runAllowlist: [],
  createdAt: Date.parse('2026-10-01T00:00:00Z'),
  scheduleChangedAt: null,
  lastRunAt: null,
  nextRunAt: Date.parse('2026-11-09T09:00:00Z'),
};
const FACT_ENV = {
  cronScheduleLabel: () => '평일 18:00',
  capClockLabel: () => '18:00',
  cronCountdownHtml: () => '<ui-elapsed></ui-elapsed>',
  cronRunWhen: () => '11/8 18:00 · 1일 전',
};
const OWNER = { currentUserId: 'U_OWNER' };
const ADMIN_ON = { currentUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => true };
const ADMIN_OFF = { currentUserId: 'U_ADMIN', _viewerIsAdmin: true, _isAdminModeOn: () => false };

const META_FNS = [
  'esc',
  'escAttr',
  'cronDetailAllowed',
  'cronDetailGate',
  'cronDetailWhen',
  'cronActionBar',
  'cronArmed',
  'renderCronDetail',
  'renderCronDrawerMeta',
];
const META_VARS = [
  '_cronDetail',
  'CRON_MODE_LABEL',
  'CRON_TARGET_LABEL',
  'CRON_MODEL_LABEL',
  'CRON_ACT_LABEL',
  'CRON_ARMED_SAID',
  'CRON_NOTE_OTHERS',
];

/** The row's buttons, in order, as [act, label]. */
function bar(html: string): Array<[string, string]> {
  const row = html.match(/<div class="cron-actions"[^>]*>([\s\S]*?)<\/div>/);
  if (!row) return [];
  return [...row[1].matchAll(/data-cron-act="([^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);
}

describe('bar — 지금 실행 · 편집 · 삭제 above the facts, for whoever may manage the job', () => {
  type Meta = { renderCronDrawerMeta(g: unknown, now: number): string; __setState(v: unknown): void };
  const meta = (viewer: Record<string, unknown>) => load<Meta>(META_FNS, META_VARS, { ...FACT_ENV, ...viewer });

  it('the owner and an admin in 관리자 모드 get the row first, 삭제 last and apart, in the danger tone', () => {
    for (const viewer of [OWNER, ADMIN_ON]) {
      const html = meta(viewer).renderCronDrawerMeta(GROUP, T0);
      expect(bar(html)).toEqual([
        ['run', '지금 실행'],
        ['edit', '편집'],
        ['delete', '삭제'],
      ]);
      // Above the facts: the row opens the meta.
      expect(html.indexOf('class="cron-actions"')).toBeLessThan(html.indexOf('<dl class="ui-dl">'));
      expect(html).toMatch(/<button type="button" class="ui-btn is-sm is-danger cron-act-end" data-cron-act="delete"/);
      // 내용 보기 stays under the short facts.
      expect(html).toContain('data-cron-act="detail"');
    }
  });

  it('the whole job keeps the same row on top; its foot keeps only 접기', () => {
    const f = meta(OWNER);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: null });
    const html = f.renderCronDrawerMeta(GROUP, T0);
    expect(bar(html).map(([a]) => a)).toEqual(['run', 'edit', 'delete']);
    expect(html.indexOf('class="cron-actions"')).toBeLessThan(html.indexOf('<dl class="ui-dl">'));
    expect(html.match(/data-cron-act="edit"/g)).toHaveLength(1);
    expect(html).toContain('data-cron-act="hide"');
  });

  it('nobody else gets a control — an admin with 관리자 모드 off neither; the line says who may', () => {
    for (const viewer of [{ currentUserId: 'U_STRANGER' }, ADMIN_OFF]) {
      const html = meta(viewer).renderCronDrawerMeta(GROUP, T0);
      expect(html).not.toContain('data-cron-act');
      expect(html).not.toContain('cron-actions');
      expect(html).toContain('<p class="cron-detail-note">');
      expect(html).toContain('실행·편집·삭제');
    }
  });

  it('an armed 지금 실행 reads 한 번 더 눌러 실행 and turns primary', () => {
    const f = meta(OWNER);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, armed: 'run', armSince: Date.now() });
    const html = f.renderCronDrawerMeta(GROUP, T0);
    expect(bar(html)).toEqual([
      ['run', '한 번 더 눌러 실행'],
      ['edit', '편집'],
      ['delete', '삭제'],
    ]);
    expect(html).toMatch(
      /class="ui-btn is-sm is-primary" data-cron-act="run" data-armed aria-describedby="cron-armed-hint"/,
    );
  });

  it('an armed 삭제 reads 한 번 더 눌러 삭제 (data-armed); a request in flight is busy and the others wait', () => {
    const f = meta(OWNER);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, armed: 'delete', armSince: Date.now() });
    expect(bar(f.renderCronDrawerMeta(GROUP, T0))).toContainEqual(['delete', '한 번 더 눌러 삭제']);
    expect(f.renderCronDrawerMeta(GROUP, T0)).toMatch(
      /data-cron-act="delete" data-armed aria-describedby="cron-armed-hint"/,
    );
    // An arm older than 4 s is spent.
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, armed: 'delete', armSince: Date.now() - 5000 });
    expect(bar(f.renderCronDrawerMeta(GROUP, T0))).toContainEqual(['delete', '삭제']);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, busy: 'run' });
    const busy = f.renderCronDrawerMeta(GROUP, T0);
    expect(busy).toMatch(/data-cron-act="run" aria-busy="true" aria-disabled="true"/);
    expect(busy).toMatch(/data-cron-act="edit" aria-disabled="true"/);
    expect(busy).toMatch(/data-cron-act="delete" aria-disabled="true"/);
  });
});

/** The drawer's request functions with a scripted fetch. */
function actor(answers: Array<{ status: number; body: unknown } | 'offline'>, viewer: Record<string, unknown> = OWNER) {
  const status = fakeEl('cron-detail-status');
  const buttons: Record<string, any> = {
    '[data-cron-act="run"]': fakeEl('run'),
    '[data-cron-act="edit"]': fakeEl('edit'),
    '[data-cron-act="delete"]': fakeEl('delete'),
    '#cron-edit-name': fakeEl('cron-edit-name'),
  };
  const metaEl = fakeEl('cron-drawer-meta', buttons);
  const queue = [...answers];
  const fetch = vi.fn(async (_url: string, _init?: any) => {
    const a = queue.shift();
    if (!a || a === 'offline') throw new Error('offline');
    return {
      ok: a.status < 300,
      status: a.status,
      json: async () => a.body,
      clone: () => ({ json: async () => a.body }),
    };
  });
  const doc: any = fakeDoc({ 'cron-detail-status': status, 'cron-drawer-meta': metaEl });
  const paintCronDrawer = vi.fn();
  const loadCronJobs = vi.fn();
  const closeCronDrawer = vi.fn();
  const dashToast = vi.fn();
  const refreshCsrfToken = vi.fn(async () => {});
  const timers: Array<() => void> = [];
  const f = load<any>(
    [
      'esc',
      'escAttr',
      'cronDrawerGroup',
      'cronDetailAllowed',
      'cronDetailStatus',
      'cronDetailFocus',
      'cronDetailError',
      'cronDetailState',
      'cronArmed',
      'cronConfirmPress',
      'cronDetailHasFocus',
      'cronDetailWrite',
      'cronDraftOf',
      'cronEditOptions',
      'renderCronEditForm',
      'cronDetailLoad',
      'cronDetailEdit',
      'cronDetailRun',
      'cronDetailDelete',
    ],
    [
      '_cronDetail',
      '_cronJobs',
      '_cronJobsRev',
      'CRON_MODE_LABEL',
      'CRON_TARGET_LABEL',
      'CRON_MODEL_LABEL',
      'CRON_RUN_SAID',
      'CRON_ARMED_SAID',
    ],
    {
      ...viewer,
      fetch,
      paintCronDrawer,
      loadCronJobs,
      closeCronDrawer,
      dashToast,
      refreshCsrfToken,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      _csrfToken: 'tok-1',
      document: doc,
      _cronPlan: { groups: [GROUP] },
      _cronDrawerKey: GROUP.key,
    },
  );
  f.__setActive = (el: unknown) => {
    doc.activeElement = el;
  };
  return {
    f,
    fetch,
    paintCronDrawer,
    loadCronJobs,
    closeCronDrawer,
    dashToast,
    refreshCsrfToken,
    status,
    buttons,
    metaEl,
    timers,
  };
}
/** The state after a first press a second ago: the next press is the decision. */
function armedFor(a: ReturnType<typeof actor>, act: 'run' | 'delete', extra: Record<string, unknown> = {}) {
  a.f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, armed: act, armSince: Date.now() - 1000, ...extra });
}

describe('confirm — 지금 실행 and 삭제 ask once', () => {
  for (const [act, fn, label, said] of [
    ['run', 'cronDetailRun', '한 번 더 눌러 실행', '한 번 더 누르면 지금 바로 실행해요 — 다음 예약 실행은 그대로예요'],
    ['delete', 'cronDetailDelete', '한 번 더 눌러 삭제', '한 번 더 누르면 이 잡을 지워요 — 되돌릴 수 없어요'],
  ] as const) {
    it(`${act}: the first press arms it and sends nothing; an earlier result leaves the status line`, async () => {
      const a = actor([]);
      a.f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, say: '저장했어요', tone: 'done' });
      await a.f[fn]();
      expect(a.fetch).not.toHaveBeenCalled();
      expect(a.f.__state()).toMatchObject({ armed: act });
      expect(a.status.textContent).toBe('');
      expect(a.paintCronDrawer).toHaveBeenCalled();
      expect(a.buttons[`[data-cron-act="${act}"]`].focus).toHaveBeenCalled();
      expect(label).toMatch(/한 번 더/);
    });

    it(`${act}: armed, a line under the row says what the second press does, and describes the button`, () => {
      const f = load<any>(META_FNS, META_VARS, { ...FACT_ENV, ...OWNER });
      f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, armed: act, armSince: Date.now() });
      const html: string = f.renderCronDrawerMeta(GROUP, T0);
      expect(html).toContain(`data-cron-act="${act}" data-armed aria-describedby="cron-armed-hint">${label}<`);
      expect(html).toContain(`</div><p class="cron-actions-hint" id="cron-armed-hint">${said}</p>`);
      expect(html.indexOf('cron-armed-hint">')).toBeLessThan(html.indexOf('<dl class="ui-dl">'));
      // Not armed: no line.
      f.__setState({ key: GROUP.key, jobId: 'job-1', job: null });
      expect(f.renderCronDrawerMeta(GROUP, T0)).not.toContain('cron-actions-hint');
    });

    it(`${act}: a second press under 0.4 s is the same click doubled — nothing is sent, it stays armed`, async () => {
      const a = actor([{ status: 200, body: { ok: true } }]);
      await a.f[fn]();
      await a.f[fn]();
      expect(a.fetch).not.toHaveBeenCalled();
      expect(a.f.__state().armed).toBe(act);
    });

    it(`${act}: the arm is spent after 4 s — the label and the line go back`, async () => {
      const a = actor([]);
      await a.f[fn]();
      a.f.__state().armSince -= 5000;
      const paints = a.paintCronDrawer.mock.calls.length;
      a.timers[0]();
      expect(a.f.__state().armed).toBe('');
      expect(a.paintCronDrawer.mock.calls.length).toBe(paints + 1);
    });
  }

  it('the other button re-arms: a pending 지금 실행 does not carry over to 삭제', async () => {
    const a = actor([]);
    armedFor(a, 'run');
    await a.f.cronDetailDelete();
    expect(a.fetch).not.toHaveBeenCalled();
    expect(a.f.__state().armed).toBe('delete');
  });
});

describe('busy — a run or a delete in flight holds the whole drawer, so its answer lands where it was asked', () => {
  type Meta = { renderCronDrawerMeta(g: unknown, now: number): string; __setState(v: unknown): void };
  it('내용 보기 and 접기 are held (aria-disabled) while busy, live otherwise', () => {
    const f = load<Meta>(META_FNS, META_VARS, { ...FACT_ENV, ...OWNER });
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: null, busy: 'run' });
    expect(f.renderCronDrawerMeta(GROUP, T0)).toMatch(/data-cron-act="detail" aria-disabled="true"/);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, busy: 'delete' });
    expect(f.renderCronDrawerMeta(GROUP, T0)).toMatch(/data-cron-act="hide" aria-disabled="true"/);
    f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL });
    expect(f.renderCronDrawerMeta(GROUP, T0)).not.toMatch(/aria-disabled/);
  });

  it('a 내용 보기 or 접기 that slips through while busy does nothing — the run’s answer still reaches the drawer', async () => {
    const a = actor([{ status: 502, body: { error: 'delivery failed (dm)' } }]);
    const loadEnv = load<any>(
      ['cronDrawerGroup', 'cronDetailAllowed', 'cronDetailLoad', 'cronDetailHide'],
      ['_cronDetail'],
      {
        ...OWNER,
        fetch: a.fetch,
        paintCronDrawer: vi.fn(),
        cronDetailStatus: vi.fn(),
        cronDetailFocus: vi.fn(),
        cronDetailError: vi.fn(),
        cronDetailEdit: vi.fn(),
        _isAdminModeOn: () => false,
        _cronPlan: { groups: [GROUP] },
        _cronDrawerKey: GROUP.key,
      },
    );
    const busy = { key: GROUP.key, jobId: 'job-1', job: null, busy: 'run' };
    loadEnv.__setState(busy);
    await loadEnv.cronDetailLoad();
    loadEnv.cronDetailHide();
    expect(loadEnv.__state()).toBe(busy);
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it('focus follows the pressed button through the busy repaint and back after a spent arm', async () => {
    const a = actor([{ status: 202, body: { ok: true, started: true } }]);
    armedFor(a, 'run');
    const run = a.f.cronDetailRun();
    expect(a.buttons['[data-cron-act="run"]'].focus).toHaveBeenCalledTimes(1); // right after the busy repaint
    await run;
    // A spent arm repaints the row; whoever had focus on that button gets the new one.
    const b = actor([]);
    await b.f.cronDetailDelete();
    const focused = b.buttons['[data-cron-act="delete"]'];
    focused.setAttribute('data-cron-act', 'delete');
    focused.focus.mockClear();
    b.f.__state().armSince -= 5000;
    b.f.__setActive(focused);
    b.timers[0]();
    expect(focused.focus).toHaveBeenCalledTimes(1);
    // Focus elsewhere (the user moved on): the spent arm does not pull it back.
    const c = actor([]);
    await c.f.cronDetailDelete();
    const other = c.buttons['[data-cron-act="delete"]'];
    other.focus.mockClear();
    c.f.__state().armSince -= 5000;
    c.f.__setActive(c.buttons['#cron-edit-name']);
    c.timers[0]();
    expect(other.focus).not.toHaveBeenCalled();
  });
});

describe('edit — one press from anywhere in the drawer', () => {
  it('from the short facts: loads the job, then opens the form on 이름', async () => {
    const a = actor([{ status: 200, body: { job: DETAIL } }]);
    await a.f.cronDetailEdit();
    expect(a.fetch).toHaveBeenCalledWith('/api/dashboard/cron/job-1', { headers: { 'X-Admin-Mode': 'off' } });
    expect(a.f.__state()).toMatchObject({ job: DETAIL, draft: expect.objectContaining({ name: 'nightly-qa' }) });
    expect(a.metaEl.innerHTML).toContain('id="cron-edit-name"');
    expect(a.buttons['#cron-edit-name'].focus).toHaveBeenCalled();
  });

  it('with the job already shown: no request, the form at once', async () => {
    const a = actor([]);
    a.f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: null });
    await a.f.cronDetailEdit();
    expect(a.fetch).not.toHaveBeenCalled();
    expect(a.f.__state().draft).toEqual(expect.objectContaining({ name: 'nightly-qa' }));
  });

  it('a refused load opens no form and says why', async () => {
    const a = actor([{ status: 403, body: { error: 'Forbidden' } }]);
    await a.f.cronDetailEdit();
    expect(a.f.__state().draft).toBeFalsy();
    expect(a.status.textContent).toBe('소유자나 관리자 모드를 켠 관리자만 할 수 있어요');
  });
});

describe('run — 지금 실행', () => {
  it('the second press POSTs …/run with the CSRF token; a started fire says so, the lane reloads, focus stays', async () => {
    const a = actor([{ status: 202, body: { ok: true, started: true } }]);
    armedFor(a, 'run');
    await a.f.cronDetailRun();
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/cron/job-1/run');
    expect(init.method).toBe('POST');
    expect(init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(a.status.textContent).toBe('실행을 시작했어요 — 실행은 보드와 아래 기록에 나타나요');
    expect(a.status.getAttribute('data-tone')).toBe('done');
    expect(a.f.__state().busy).toBe('');
    expect(a.loadCronJobs).toHaveBeenCalledTimes(1);
    expect(a.buttons['[data-cron-act="run"]'].focus).toHaveBeenCalled();
  });

  it('says what the scheduler did when it answered in time', async () => {
    for (const [detail, said] of [
      ['busy_queue', '잡의 세션이 일하는 중이라, 끝나면 실행해요'],
      ['dm', 'DM으로 보냈어요'],
      ['thread_reply', '스레드에 답글로 올렸어요'],
      ['idle_inject', '실행을 시작했어요 — 실행은 보드와 아래 기록에 나타나요'],
    ] as const) {
      const a = actor([{ status: 200, body: { ok: true, detail } }]);
      armedFor(a, 'run');
      await a.f.cronDetailRun();
      expect(a.status.textContent, detail).toBe(said);
    }
  });

  it('while it is in flight the row is busy and a second press sends nothing', async () => {
    const a = actor([{ status: 202, body: { ok: true, started: true } }]);
    armedFor(a, 'run');
    const first = a.f.cronDetailRun();
    expect(a.f.__state().busy).toBe('run');
    expect(a.status.textContent).toBe('실행을 요청하는 중…');
    await a.f.cronDetailRun();
    await first;
    expect(a.fetch).toHaveBeenCalledTimes(1);
  });

  it('a refusal or a failed fire says why in the drawer, in the fail tone; the lane is not reloaded', async () => {
    const forbidden = actor([{ status: 403, body: { error: 'Forbidden' } }]);
    armedFor(forbidden, 'run');
    await forbidden.f.cronDetailRun();
    expect(forbidden.status.textContent).toBe('소유자나 관리자 모드를 켠 관리자만 할 수 있어요');
    expect(forbidden.status.getAttribute('data-tone')).toBe('fail');
    const failed = actor([{ status: 502, body: { error: 'delivery failed (dm)' } }]);
    armedFor(failed, 'run');
    await failed.f.cronDetailRun();
    expect(failed.status.textContent).toBe('delivery failed (dm)');
    expect(failed.loadCronJobs).not.toHaveBeenCalled();
    const offline = actor(['offline']);
    armedFor(offline, 'run');
    await offline.f.cronDetailRun();
    expect(offline.status.textContent).toBe('실행하지 못했어요');
  });

  it('a stale CSRF token is refreshed and the request sent once more', async () => {
    const a = actor([
      { status: 403, body: { error: 'CSRF token validation failed', code: 'csrf_failed' } },
      { status: 202, body: { ok: true, started: true } },
    ]);
    armedFor(a, 'run');
    await a.f.cronDetailRun();
    expect(a.refreshCsrfToken).toHaveBeenCalledTimes(1);
    expect(a.fetch).toHaveBeenCalledTimes(2);
    expect(a.status.getAttribute('data-tone')).toBe('done');
  });

  it('asks nothing for a viewer who may not manage the job', async () => {
    const a = actor([{ status: 202, body: { ok: true, started: true } }], ADMIN_OFF);
    armedFor(a, 'run');
    await a.f.cronDetailRun();
    expect(a.fetch).not.toHaveBeenCalled();
  });
});

describe('delete — the second press removes', () => {
  it('the second press within 4 s DELETEs with the token; the job leaves the lane, the drawer closes, a toast says so', async () => {
    const a = actor([{ status: 200, body: { ok: true } }]);
    armedFor(a, 'delete');
    // _cronJobs is the page's list: seed it through the lane's own shape.
    a.f.__jobs().push(LANE_JOB, { ...LANE_JOB, id: 'job-2', name: 'other' });
    await a.f.cronDetailDelete();
    const [url, init] = a.fetch.mock.calls[0];
    expect(url).toBe('/api/dashboard/cron/job-1');
    expect(init.method).toBe('DELETE');
    expect(init.headers['X-CSRF-Token']).toBe('tok-1');
    expect(a.f.__jobs().map((j: { id: string }) => j.id)).toEqual(['job-2']);
    expect(a.closeCronDrawer).toHaveBeenCalledTimes(1);
    expect(a.dashToast).toHaveBeenCalledWith({
      title: '크론 잡을 지웠어요',
      description: 'nightly-qa',
      tone: 'success',
    });
    expect(a.loadCronJobs).toHaveBeenCalledTimes(1);
  });

  it('a refusal keeps the drawer and the job, and says why', async () => {
    const a = actor([{ status: 404, body: { error: '크론 잡을 찾을 수 없어요 (지워졌을 수 있어요)' } }]);
    armedFor(a, 'delete');
    await a.f.cronDetailDelete();
    expect(a.closeCronDrawer).not.toHaveBeenCalled();
    expect(a.dashToast).not.toHaveBeenCalled();
    expect(a.status.textContent).toBe('크론 잡을 찾을 수 없어요 (지워졌을 수 있어요)');
    expect(a.status.getAttribute('data-tone')).toBe('fail');
    expect(a.f.__state()).toMatchObject({ armed: '', busy: '' });
  });

  it('an open form is not deleted from under the typing: 삭제 waits for 취소 or 저장', async () => {
    const a = actor([]);
    a.f.__setState({ key: GROUP.key, jobId: 'job-1', job: DETAIL, draft: { name: 'typed' } });
    await a.f.cronDetailDelete();
    expect(a.f.__state().armed).toBeFalsy();
    expect(a.fetch).not.toHaveBeenCalled();
  });
});

describe('history — a run by hand reads 수동 실행, the owner’s press too', () => {
  it('the row’s label: who pressed it, else 수동 실행 when by hand, else 예약 실행', () => {
    const f = load<{ renderCronRunRow(run: unknown, g: unknown, now: number): string }>(
      ['esc', 'escAttr', 'renderCronRunRow'],
      [],
      {
        cronRunGlyph: () => ({ glyph: 'ok', label: '성공', tone: 'ok' }),
        CRON_RUN_GLYPHS: { ok: '' },
        cronRunWhen: () => '11/13 18:00',
        formatNmSSs: () => '',
        formatTokens: () => '',
        safeHref: (u: string) => u,
        _sessionCache: {},
      },
    );
    const row = (over: Record<string, unknown>) =>
      f.renderCronRunRow({ executedAt: T0, status: 'success', executionPath: 'dm', ...over }, GROUP, T0);
    expect(row({ triggeredBy: 'U_ADMIN', manual: true })).toContain('수동 실행 (U_ADMIN)');
    expect(row({ manual: true })).toContain('<span aria-hidden="true"> · </span>수동 실행');
    expect(row({})).toContain('예약 실행');
    expect(row({})).not.toContain('수동 실행');
  });
});

describe('page wiring', () => {
  it('the buttons route by their action', () => {
    const calls: string[] = [];
    const f = load<{ onCronDetailClick(e: unknown): void }>(['onCronDetailClick'], [], {
      cronDetailLoad: () => calls.push('load'),
      cronDetailEdit: () => calls.push('edit'),
      cronDetailCancel: () => calls.push('cancel'),
      cronDetailHide: () => calls.push('hide'),
      cronDetailRun: () => calls.push('run'),
      cronDetailDelete: () => calls.push('delete'),
    });
    for (const act of ['run', 'edit', 'delete', 'detail', 'cancel', 'hide', 'other']) {
      const b = fakeEl();
      b.setAttribute('data-cron-act', act);
      f.onCronDetailClick({ target: { closest: (sel: string) => (sel === '[data-cron-act]' ? b : null) } });
    }
    // A control that says it is disabled does nothing.
    const off = fakeEl();
    off.setAttribute('data-cron-act', 'run');
    off.setAttribute('aria-disabled', 'true');
    f.onCronDetailClick({ target: { closest: () => off } });
    expect(calls).toEqual(['run', 'edit', 'delete', 'load', 'cancel', 'hide']);
  });

  it('an English viewer reads every word of the drawer: the page scanner finds an entry for each Korean string', () => {
    // What the translator actually looks up (scanPage), not bare words: a Korean phrase inside an HTML fragment
    // literal is a key of its own, so a label must reach the markup through a variable.
    registerPageCatalog(
      JSON.parse(
        readFileSync(
          join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-page.json'),
          'utf-8',
        ),
      ),
    );
    const vars = ['CRON_ACT_LABEL', 'CRON_NOTE_OTHERS', 'CRON_ARMED_SAID', 'CRON_RUN_SAID'];
    const fns = [
      'cronActionBar',
      'cronConfirmPress',
      'cronDetailGate',
      'renderCronDetail',
      'renderCronDrawerMeta',
      'cronDetailLoad',
      'cronDetailEdit',
      'cronDetailRun',
      'cronDetailDelete',
      'cronDetailError',
    ];
    const script = `<script>\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\n</script>`;
    const segs = scanPage(script).filter((seg) => !seg.skip);
    expect(segs.length).toBeGreaterThan(15);
    expect(segs.filter((seg) => pageText(seg.key) === undefined).map((seg) => seg.key)).toEqual([]);
  });

  it('the server’s refusals have their English too', () => {
    const en = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-text.json'),
        'utf-8',
      ),
    );
    const said = [
      ...DASHBOARD_TS.slice(DASHBOARD_TS.indexOf("'/api/dashboard/cron/:id/run'"))
        .slice(0, 6000)
        .matchAll(/\bt\('([^']+)'\)/g),
    ].map((m) => m[1]);
    expect(said.length).toBeGreaterThanOrEqual(4);
    for (const ko of said) expect(en[ko], ko).toMatch(/\S/);
  });
});
