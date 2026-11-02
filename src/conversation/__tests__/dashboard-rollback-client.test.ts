/**
 * #744 — the dashboard's context rollback picker, client half. Executes the
 * shipped client code (cut out of renderDashboardPage()'s template literal and
 * cooked as the browser receives it, the dashboard-goal-client harness): what
 * the picker lists, what a row's button sends, and the one-gate refusal shown.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}

const FNS = [
  'setRollbackStatus',
  'closeRollbackDialog',
  'openRollbackDialog',
  'loadRollbackPoints',
  'rollbackSectionHtml',
  'onRollbackClick',
  'sendRollback',
];

function el() {
  const attrs: Record<string, string> = {};
  return {
    innerHTML: '',
    textContent: '',
    _points: undefined as unknown,
    _locked: false,
    shown: false,
    show() {
      this.shown = true;
    },
    hide() {
      this.shown = false;
    },
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    removeAttribute: (k: string) => {
      delete attrs[k];
    },
    attrs,
  };
}

function setup(
  points: unknown,
  post: (body: any) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } }),
) {
  const nodes: Record<string, ReturnType<typeof el>> = {
    'rollback-dialog': el(),
    'rollback-body': el(),
    'rollback-status': el(),
  };
  const posts: any[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      posts.push({ url, body });
      const r = post(body);
      return { ok: r.status < 300, status: r.status, json: async () => r.body };
    }
    return { ok: true, status: 200, json: async () => points };
  });
  const inject: Record<string, unknown> = {
    document: { getElementById: (id: string) => nodes[id] ?? null },
    window: {},
    fetch: fetchMock,
    esc: (t: string) => String(t),
    escAttr: (t: string) => String(t),
    formatTaskTime: (ms: number) => `t${ms}`,
    dashToast: vi.fn(),
    loadSessions: vi.fn(async () => undefined),
    refreshCsrfToken: vi.fn(async () => undefined),
    _csrfToken: 'csrf',
  };
  const names = Object.keys(inject);
  const body = `var _rollbackKey = null;\n${FNS.map(clientFn).join('\n')}\nreturn { ${FNS.join(', ')} };`;
  const mod = new Function(...names, body)(...names.map((n) => inject[n])) as Record<string, (...a: any[]) => any>;
  return { mod, nodes, posts, inject };
}

const POINTS = {
  inputs: [
    { anchor: 'sid~0~a', label: '입력 직전: 배포해', at: 1 },
    { anchor: 'sid~0~b', label: '입력 직전: 테스트 다시', at: 2 },
  ],
  worklog: [{ anchor: 'sid~0~c', label: '툴 결과까지: ok', at: 3, kind: 'tool_result' }],
};

function button(attrs: Record<string, string>) {
  return {
    disabled: false,
    textContent: '되돌리기',
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => {
      attrs[k] = v;
    },
    closest: function () {
      return this;
    },
  };
}

describe('dashboard rollback picker (client)', () => {
  it('opens and lists both kinds of points, newest first', async () => {
    const { mod, nodes } = setup(POINTS);
    await mod.openRollbackDialog('C1:T1');
    expect(nodes['rollback-dialog'].shown).toBe(true);
    const html = nodes['rollback-body'].innerHTML;
    expect(html.indexOf('테스트 다시')).toBeLessThan(html.indexOf('배포해'));
    expect(html).toContain('툴 결과까지: ok');
    expect(html).toContain('data-rb-source="worklog" data-rb-index="0"');
  });

  it('a row sends its anchor, label and source on the second press (the first arms it — no confirm())', async () => {
    const { mod, nodes, posts } = setup(POINTS);
    await mod.openRollbackDialog('C1:T1');
    const row = button({ 'data-rb-source': 'input', 'data-rb-index': '0' });
    mod.onRollbackClick({ target: row });
    expect(posts).toHaveLength(0);
    expect(row.textContent).toBe('한 번 더 눌러 확인');
    expect(nodes['rollback-status'].textContent).toContain('입력 직전: 배포해');
    // Another row re-arms; it does not send.
    mod.onRollbackClick({ target: button({ 'data-rb-source': 'worklog', 'data-rb-index': '0' }) });
    expect(posts).toHaveLength(0);
    mod.onRollbackClick({ target: row });
    expect(posts).toHaveLength(0);
    mod.onRollbackClick({ target: row });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toBe('/api/dashboard/session/C1%3AT1/rollback');
    expect(posts[0].body).toEqual({ anchor: 'sid~0~a', label: '입력 직전: 배포해', source: 'input' });
  });

  it('a refusal locks the rows and says why; a waiting rollback can be cancelled', async () => {
    const { mod, nodes, posts } = setup({
      ...POINTS,
      refusal: 'busy',
      refusalText: '작업이 진행 중이라 지금은 되돌릴 수 없습니다.',
      pending: { label: '입력 직전: 배포해', requestedAt: 1 },
    });
    await mod.openRollbackDialog('C1:T1');
    expect(nodes['rollback-body'].innerHTML).toContain(' disabled>되돌리기');
    expect(nodes['rollback-status'].textContent).toContain('진행 중');
    // Locked: no cancel button either.
    expect(nodes['rollback-body'].innerHTML).not.toContain('data-rb-cancel');
    expect(posts).toHaveLength(0);
  });

  it('cancel sends { cancel: true }', async () => {
    const { mod, posts } = setup({ ...POINTS, pending: { label: 'x', requestedAt: 1 } });
    await mod.openRollbackDialog('C1:T1');
    mod.onRollbackClick({ target: button({ 'data-rb-cancel': '1' }) });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ cancel: true });
  });

  it('a server refusal is shown in the status line', async () => {
    const { mod, nodes } = setup(POINTS, () => ({
      status: 422,
      body: { error: '이 지점 뒤에 문맥 압축(/compact)이 있어 되돌릴 수 없습니다.' },
    }));
    await mod.openRollbackDialog('C1:T1');
    await mod.sendRollback('C1:T1', { anchor: 'x', label: 'y', source: 'input' }, 'done');
    expect(nodes['rollback-status'].textContent).toContain('/compact');
  });
});
