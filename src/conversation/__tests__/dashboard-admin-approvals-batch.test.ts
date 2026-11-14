/**
 * #1131 — "여러개가 모인경우 그 내용들을 한번에 어드민이 확인하고 한번에 수락할수 있는 ui … 로그인해 있는 어드민이
 * 있으면 즉시 알림이 가서 즉시 처리할 수 있도록".
 *
 * The shipped client functions of the 관리자 승인 drawer, cut out of the page by name: each pending card's line
 * (summary, risk, age, who asked), selection that survives a refresh, 전체 선택 that leaves high-risk
 * requests to be ticked one by one, the confirm sheet (every effect listed, each high-risk one ticked, one
 * confirm, the outcome per item), desktop alerts (asked for only from the toggle, only for a hidden tab, only
 * for requests never seen) and the pending count in the tab title.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}

const FNS = [
  'toNum',
  'esc',
  'escAttr',
  'agoHtml',
  'adminUserName',
  'adminApprovalTitle',
  'adminApprovalLock',
  'adminResolutionOf',
  'adminResolvedState',
  'adminApprovalData',
  'decisionLines',
  'applyAdminApprovals',
  'paintAdminInboxButton',
  'adminInboxAnnounce',
  'acPost',
  'adminFmt',
  'adminSummaryOf',
  'adminHasBatch',
  'adminCanBatch',
  'adminSafeIds',
  'adminSelectedIds',
  'adminPruneSelection',
  'toggleAdminSelect',
  'adminSelectAll',
  'adminBatchBarModel',
  'adminRiskChipHtml',
  'adminMetaHtml',
  'adminChoiceLabel',
  'adminBatchChoiceId',
  'adminBatchModel',
  'openAdminBatch',
  'tickAdminBatch',
  'adminBatchOutcome',
  'confirmAdminBatch',
  'closeAdminBatch',
  'adminNotifyPref',
  'adminSetNotifyPref',
  'adminNotifyState',
  'adminNotifyActive',
  'toggleAdminNotify',
  'adminNotifyArrivals',
  'adminTitleBadge',
] as const;

function loadClient(inject: Record<string, unknown>) {
  const names = Object.keys(inject);
  const body = `${clientVar('ADMIN_KIND_LABEL')}
${clientVar('ADMIN_RISK_LABEL')}
${clientVar('ADMIN_BATCH_REASON')}
${clientVar('ADMIN_NOTIFY_KEY')}
var _adminApprovals = { pending: [], resolved: [] };
var _adminKnown = null;
var _adminLast = Object.create(null);
var _adminKeep = Object.create(null);
var _adminState = Object.create(null);
var _adminSel = Object.create(null);
var _adminSeenEver = null;
var _adminBatch = null;
var _adminInboxOpen = false;
var _adminPushSeq = 0;
${FNS.map(clientFn).join('\n')}
return { ${FNS.join(', ')}, state: function() { return { _adminState: _adminState, _adminSel: _adminSel, _adminBatch: _adminBatch }; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as any;
}

function req(id: string, over: Record<string, unknown> = {}) {
  const [kind] = id.split(':');
  return {
    id,
    kind,
    card: 'permission',
    title: '새 사용자 접근 요청',
    summary: `${id} 요약`,
    risk: 'low',
    batch: { approve: 'approve', deny: 'deny' },
    requesterId: 'U0USER01',
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

const ENV = req('env_skill:r1', {
  card: 'question',
  title: '환경 스킬 `acme-env:post-deploy` 실행 요청',
  summary: '환경 스킬 `acme-env:post-deploy` 1회 실행 허용 — #C0CHAN01',
  risk: 'medium',
  choices: [
    { id: 'env_skill_once', label: '✅ 1회 허용 (이 스레드)' },
    { id: 'env_skill_deny', label: '❌ 거부' },
  ],
  batch: { approve: 'env_skill_once', deny: 'env_skill_deny' },
});
const USER = req('new_user:U0USER02');
const HIGH = req('mcp_grant:r9', { risk: 'high', summary: '`mcp__github` 쓰기 권한 부여 (24h) — #C0CHAN01' });
const QUESTION = req('session_question:C0CHAN01:t1~ts1', {
  card: 'question',
  title: '배포할까요?',
  summary: undefined,
  batch: undefined,
  choices: [{ id: 'a', label: '예' }],
});

function client(over: Record<string, unknown> = {}) {
  const toasts: any[] = [];
  const store: Record<string, string> = {};
  const doc: any = { getElementById: () => null, hidden: false, title: '대시보드' };
  const c = loadClient({
    document: doc,
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = String(v);
      },
    },
    window: { focus() {} },
    Notification: undefined,
    _sessionCache: { 'C1:t1': { ownerId: 'U0USER01', ownerName: '김민수' } },
    _viewerUserId: 'UADMIN01',
    _viewerIsAdmin: true,
    _isAdminModeOn: () => true,
    dashToast: (t: any) => toasts.push(t),
    paintAdminInbox: () => {},
    paintAdminBatch: () => {},
    paintAdminBatchBar: () => {},
    paintAdminNotifyToggle: () => {},
    adminInboxLoad: () => {},
    openAdminInbox: () => {},
    console: { error() {} },
    _csrfToken: 'x',
    refreshCsrfToken: async () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) }),
    ...over,
  });
  return { c, toasts, doc, store };
}

describe('dashboard admin approvals in one pass (#1131)', () => {
  describe('the card line', () => {
    it('shows the summary, the risk, who asked and how long ago — no countdown', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [{ ...ENV, expiresAt: 1_700_000_600_000 }], resolved: [] });
      const html = c.adminMetaHtml('env_skill:r1');
      expect(html).toContain('환경 스킬 `acme-env:post-deploy` 1회 실행 허용 — #C0CHAN01');
      expect(html).toContain('위험 중간');
      expect(html).toContain('data-risk="medium"');
      expect(html).toContain('김민수');
      expect(html).toContain('<ui-elapsed since="1700000000000" format="ago" lang="ko">');
      expect(html).not.toContain('대기열');
      // The card itself has no live expiry clock any more.
      expect(c.adminApprovalData('env_skill:r1').expiresAt).toBeUndefined();
    });

    it('falls back to the title; there is no 대기열 badge (the broker queue went with the broker, #1214)', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [{ ...USER, summary: undefined, queued: true }], resolved: [] });
      const html = c.adminMetaHtml('new_user:U0USER02');
      expect(html).toContain('새 사용자 접근 요청');
      expect(html).not.toContain('대기열');
    });

    it('a request that can be decided with others has a checkbox; a free question has none', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [USER, QUESTION], resolved: [] });
      expect(c.adminMetaHtml('new_user:U0USER02')).toContain('data-admin-sel="new_user:U0USER02"');
      expect(c.adminMetaHtml('session_question:C0CHAN01:t1~ts1')).not.toContain('type="checkbox"');
      c.toggleAdminSelect('new_user:U0USER02', true);
      expect(c.adminMetaHtml('new_user:U0USER02')).toMatch(/data-admin-sel="new_user:U0USER02"[^>]* checked/);
    });

    it('escapes what the request says', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [{ ...USER, summary: '<img src=x onerror=alert(1)>' }], resolved: [] });
      expect(c.adminMetaHtml('new_user:U0USER02')).not.toContain('<img');
    });
  });

  describe('selection', () => {
    it('전체 선택 takes every batchable request except a high-risk one; a free question is never selected', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV, USER, HIGH, QUESTION], resolved: [] });
      c.adminSelectAll();
      expect(c.adminSelectedIds()).toEqual(['env_skill:r1', 'new_user:U0USER02']);
      // A high-risk one is ticked on its own.
      c.toggleAdminSelect('mcp_grant:r9', true);
      expect(c.adminSelectedIds()).toEqual(['env_skill:r1', 'new_user:U0USER02', 'mcp_grant:r9']);
      c.toggleAdminSelect('session_question:C0CHAN01:t1~ts1', true);
      expect(c.adminSelectedIds()).not.toContain('session_question:C0CHAN01:t1~ts1');
    });

    it('with every safe one selected, the same button clears the selection', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV, USER], resolved: [] });
      c.adminSelectAll();
      expect(c.adminBatchBarModel().allLabel).toBe('선택 해제');
      c.adminSelectAll();
      expect(c.adminSelectedIds()).toEqual([]);
      expect(c.adminBatchBarModel().allLabel).toBe('전체 선택');
    });

    it('survives a refresh for the ids still pending; an id that left is dropped', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV, USER], resolved: [] });
      c.adminSelectAll();
      c.applyAdminApprovals({ pending: [req('bot_delete:b1'), ENV], resolved: [] });
      expect(c.adminSelectedIds()).toEqual(['env_skill:r1']);
      expect(Object.keys(c.state()._adminSel)).toEqual(['env_skill:r1']);
    });

    it('the toolbar: shown only with a batchable request, with the count on each action', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [QUESTION], resolved: [] });
      expect(c.adminBatchBarModel().show).toBe(false);
      c.applyAdminApprovals({ pending: [ENV, USER, QUESTION], resolved: [] });
      expect(c.adminBatchBarModel()).toMatchObject({
        show: true,
        count: 0,
        approveLabel: '선택 승인 (0)',
        denyLabel: '선택 거부 (0)',
        actDisabled: true,
      });
      c.adminSelectAll();
      expect(c.adminBatchBarModel()).toMatchObject({
        count: 2,
        countLabel: '2건 선택됨',
        approveLabel: '선택 승인 (2)',
        denyLabel: '선택 거부 (2)',
        actDisabled: false,
      });
    });

    it('the actions are locked while admin mode is off', () => {
      const { c } = client({ _isAdminModeOn: () => false });
      c.applyAdminApprovals({ pending: [ENV], resolved: [] });
      c.adminSelectAll();
      expect(c.adminBatchBarModel()).toMatchObject({
        actDisabled: true,
        lock: '관리자 모드를 켜면 응답할 수 있습니다',
      });
      expect(c.openAdminBatch('approve')).toBeNull();
    });
  });

  describe('the confirm sheet', () => {
    it('lists every selected request — its summary, risk and who asked — and the choice a question gets', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [ENV, USER, HIGH], resolved: [] });
      c.adminSelectAll();
      c.toggleAdminSelect('mcp_grant:r9', true);
      c.openAdminBatch('approve');
      const m = c.adminBatchModel();
      expect(m.rows.map((r: any) => r.summary)).toEqual([ENV.summary, USER.summary, HIGH.summary]);
      expect(m.rows.map((r: any) => r.riskLabel)).toEqual(['위험 중간', '위험 낮음', '위험 높음']);
      expect(m.rows[0].who).toBe('김민수');
      expect(m.rows[0].choice).toBe('✅ 1회 허용 (이 스레드)');
      expect(m.heading).toBe('선택한 요청 승인');
      expect(m.goLabel).toBe('3건 승인');
    });

    it('each high-risk request is ticked on its own before the one confirm unlocks', () => {
      const { c } = client();
      const HIGH2 = req('bot_delete:b2', { risk: 'high' });
      c.applyAdminApprovals({ pending: [USER, HIGH, HIGH2], resolved: [] });
      c.adminSelectAll();
      c.toggleAdminSelect('mcp_grant:r9', true);
      c.toggleAdminSelect('bot_delete:b2', true);
      c.openAdminBatch('approve');
      expect(c.adminBatchModel()).toMatchObject({ high: 2, unticked: 2, ready: false });
      c.tickAdminBatch('mcp_grant:r9', true);
      expect(c.adminBatchModel()).toMatchObject({ unticked: 1, ready: false });
      // A tick for a request that is not high-risk (or not in the sheet) changes nothing.
      c.tickAdminBatch('new_user:U0USER02', true);
      expect(c.adminBatchModel().ready).toBe(false);
      c.tickAdminBatch('bot_delete:b2', true);
      expect(c.adminBatchModel()).toMatchObject({ unticked: 0, ready: true });
    });

    it('a confirm sends every item with its kind’s approve choice, once — then shows each outcome', async () => {
      const calls: any[] = [];
      let release: (v: unknown) => void = () => {};
      const { c } = client({
        fetch: (url: string, init: any) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return new Promise((r) => {
            release = r;
          });
        },
      });
      const GONE = req('bot_delete:b3');
      const BAD = req('new_user:U0USER03');
      c.applyAdminApprovals({ pending: [ENV, USER, GONE, BAD], resolved: [] });
      c.adminSelectAll();
      c.openAdminBatch('approve');
      const first = c.confirmAdminBatch();
      // Double submit: a second confirm (a double click, Enter) while the first is in flight sends nothing.
      expect(await c.confirmAdminBatch()).toBeNull();
      expect(c.openAdminBatch('deny')).toBe(c.state()._adminBatch);
      expect(c.adminBatchModel()).toMatchObject({ ready: false, goLabel: '보내는 중…' });
      expect(c.state()._adminState['env_skill:r1']).toMatchObject({ status: 'sending', choiceId: 'env_skill_once' });
      release({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { id: 'env_skill:r1', ok: true, outcome: 'approved' },
            { id: 'new_user:U0USER02', ok: true, outcome: 'denied' },
            {
              id: 'bot_delete:b3',
              ok: false,
              reason: 'already_answered',
              resolution: { id: 'bot_delete:b3', outcome: 'denied', by: 'U0USER01', via: 'slack', at: 3 },
            },
            { id: 'new_user:U0USER03', ok: false, reason: 'not_found' },
          ],
        }),
      });
      await first;
      expect(calls).toEqual([
        {
          url: '/api/dashboard/admin-approvals/answer-batch',
          body: {
            items: [
              { id: 'env_skill:r1', choiceId: 'env_skill_once' },
              { id: 'new_user:U0USER02', choiceId: 'approve' },
              { id: 'bot_delete:b3', choiceId: 'approve' },
              { id: 'new_user:U0USER03', choiceId: 'approve' },
            ],
          },
        },
      ]);
      const m = c.adminBatchModel();
      expect(m.rows.map((r: any) => r.outcome.text)).toEqual([
        '승인됨',
        '거부됨',
        '이미 처리됨 — 김민수 · Slack',
        '실패 — 만료되었거나 더 이상 없는 요청입니다',
      ]);
      expect(m).toMatchObject({ done: true, ready: false });
      const st = c.state()._adminState;
      expect(st['env_skill:r1']).toMatchObject({ status: 'resolved', outcome: 'answered', choiceId: 'env_skill_once' });
      expect(st['new_user:U0USER02']).toMatchObject({ status: 'resolved', outcome: 'denied' });
      expect(st['bot_delete:b3']).toMatchObject({ status: 'resolved', outcome: 'denied' });
      expect(st['new_user:U0USER03']).toMatchObject({ status: 'error', retry: false });
      // Decided ones leave the selection; the one that failed stays for another try.
      expect(Object.keys(c.state()._adminSel)).toEqual(['new_user:U0USER03']);
      expect(calls).toHaveLength(1);
    });

    it('deny sends each kind’s deny choice and says so on the button', async () => {
      const calls: any[] = [];
      const { c } = client({
        fetch: async (_url: string, init: any) => {
          calls.push(JSON.parse(init.body));
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [{ id: 'env_skill:r1', ok: true, outcome: 'denied' }] }),
          };
        },
      });
      c.applyAdminApprovals({ pending: [ENV], resolved: [] });
      c.adminSelectAll();
      c.openAdminBatch('deny');
      expect(c.adminBatchModel()).toMatchObject({ heading: '선택한 요청 거부', goLabel: '1건 거부' });
      await c.confirmAdminBatch();
      expect(calls[0].items).toEqual([{ id: 'env_skill:r1', choiceId: 'env_skill_deny' }]);
      expect(c.adminBatchModel().rows[0].outcome.text).toBe('거부됨');
    });

    it('a batch the server refused decides nothing: the cards are answerable again and the confirm is offered again', async () => {
      const { c } = client({
        fetch: async () => ({
          ok: false,
          status: 403,
          json: async () => ({ error: '관리자 모드를 켜야 응답할 수 있습니다' }),
        }),
      });
      c.applyAdminApprovals({ pending: [USER], resolved: [] });
      c.adminSelectAll();
      c.openAdminBatch('approve');
      await c.confirmAdminBatch();
      expect(c.adminBatchModel()).toMatchObject({
        ready: true,
        done: false,
        error: '관리자 모드를 켜야 응답할 수 있습니다',
      });
      expect(c.state()._adminState['new_user:U0USER02']).toBeUndefined();
      expect(c.adminSelectedIds()).toEqual(['new_user:U0USER02']);
    });

    it('nothing selected: no sheet; closing it drops it', () => {
      const { c } = client();
      c.applyAdminApprovals({ pending: [USER], resolved: [] });
      expect(c.openAdminBatch('approve')).toBeNull();
      c.adminSelectAll();
      expect(c.openAdminBatch('approve')).not.toBeNull();
      c.closeAdminBatch();
      expect(c.state()._adminBatch).toBeNull();
      expect(c.adminBatchModel()).toBeNull();
    });
  });

  describe('desktop alerts', () => {
    function notifications(permission: string, answer = 'granted') {
      const made: any[] = [];
      const asked: number[] = [];
      function N(this: any, title: string, options: any) {
        made.push({ title, options });
        this.close = () => {};
      }
      (N as any).permission = permission;
      (N as any).requestPermission = (cb?: (p: string) => void) => {
        asked.push(1);
        (N as any).permission = answer;
        cb?.(answer);
        return Promise.resolve(answer);
      };
      return { N, made, asked };
    }

    it('permission is asked only from the toggle — never by an arriving request, never on load', async () => {
      const n = notifications('default');
      const { c, doc, store } = client({ Notification: n.N });
      store.soma_admin_notify = 'on';
      doc.hidden = true;
      c.applyAdminApprovals({ pending: [], resolved: [] });
      c.applyAdminApprovals({ pending: [USER], resolved: [] });
      expect(n.asked).toEqual([]);
      expect(n.made).toEqual([]);
      expect(c.adminNotifyState()).toBe('off');
      await c.toggleAdminNotify();
      expect(n.asked).toEqual([1]);
      expect(c.adminNotifyState()).toBe('on');
      expect(store.soma_admin_notify).toBe('on');
    });

    it('one alert for requests never seen, only while the tab is hidden: the count, the first summary and how many more', () => {
      const n = notifications('granted');
      const { c, doc, store } = client({ Notification: n.N });
      store.soma_admin_notify = 'on';
      doc.hidden = true;
      // The first load is the baseline: nothing.
      c.applyAdminApprovals({ pending: [ENV], resolved: [] });
      expect(n.made).toEqual([]);
      c.applyAdminApprovals({ pending: [USER, ENV], resolved: [] });
      expect(n.made).toEqual([
        {
          title: '관리자 승인 2건 대기',
          options: { body: `${USER.summary} 외 1건`, tag: 'soma-admin-approvals', renotify: true },
        },
      ]);
      // The same ids again (a refresh, an answer elsewhere coming back): no new alert.
      c.applyAdminApprovals({ pending: [USER, ENV], resolved: [] });
      c.applyAdminApprovals({ pending: [ENV], resolved: [] });
      c.applyAdminApprovals({ pending: [USER, ENV], resolved: [] });
      expect(n.made).toHaveLength(1);
      // A visible tab gets the in-page toast, not a desktop alert.
      doc.hidden = false;
      c.applyAdminApprovals({ pending: [HIGH, USER, ENV], resolved: [] });
      expect(n.made).toHaveLength(1);
    });

    it('off, or not granted: no alert', () => {
      const granted = notifications('granted');
      const off = client({ Notification: granted.N });
      off.doc.hidden = true;
      off.c.applyAdminApprovals({ pending: [], resolved: [] });
      off.c.applyAdminApprovals({ pending: [USER], resolved: [] });
      expect(granted.made).toEqual([]);
      const denied = notifications('denied');
      const on = client({ Notification: denied.N });
      on.store.soma_admin_notify = 'on';
      on.doc.hidden = true;
      on.c.applyAdminApprovals({ pending: [], resolved: [] });
      on.c.applyAdminApprovals({ pending: [USER], resolved: [] });
      expect(denied.made).toEqual([]);
    });

    it('a denied permission: the toggle says so and asks nothing; no Notification API: unsupported', async () => {
      const n = notifications('denied');
      const { c, store } = client({ Notification: n.N });
      expect(c.adminNotifyState()).toBe('denied');
      await c.toggleAdminNotify();
      expect(n.asked).toEqual([]);
      expect(store.soma_admin_notify).not.toBe('on');
      expect(client().c.adminNotifyState()).toBe('unsupported');
    });

    it('turned off from the toggle: the preference is kept off', async () => {
      const n = notifications('granted');
      const { c, store } = client({ Notification: n.N });
      await c.toggleAdminNotify();
      expect(c.adminNotifyState()).toBe('on');
      await c.toggleAdminNotify();
      expect(c.adminNotifyState()).toBe('off');
      expect(store.soma_admin_notify).toBe('off');
      expect(n.asked).toEqual([]);
    });

    it('a click on the alert brings the tab forward and opens the drawer', () => {
      const n = notifications('granted');
      const focused: number[] = [];
      const opened: any[] = [];
      const { c, doc, store } = client({
        Notification: n.N,
        window: { focus: () => focused.push(1) },
        openAdminInbox: (id: string) => opened.push(id),
      });
      store.soma_admin_notify = 'on';
      doc.hidden = true;
      c.applyAdminApprovals({ pending: [], resolved: [] });
      const alert = c.adminNotifyArrivals([USER], 1);
      expect(alert).not.toBeNull();
      alert.onclick();
      expect(focused).toEqual([1]);
      expect(opened).toEqual(['new_user:U0USER02']);
    });
  });

  describe('the tab title', () => {
    it('carries the pending count, never stacked, and goes back when none wait', () => {
      const { c, doc } = client();
      expect(c.adminTitleBadge('대시보드', 3)).toBe('(3) 대시보드');
      expect(c.adminTitleBadge('(3) 대시보드', 5)).toBe('(5) 대시보드');
      expect(c.adminTitleBadge('(5) 대시보드', 0)).toBe('대시보드');
      c.applyAdminApprovals({ pending: [USER, ENV], resolved: [] });
      expect(doc.title).toBe('(2) 대시보드');
      c.applyAdminApprovals({ pending: [USER], resolved: [] });
      expect(doc.title).toBe('(1) 대시보드');
      c.applyAdminApprovals({ pending: [], resolved: [] });
      expect(doc.title).toBe('대시보드');
    });
  });

  it('the page has the toggle, the toolbar and the confirm sheet', () => {
    expect(TEMPLATE).toContain('id="admin-notify-toggle"');
    expect(TEMPLATE).toContain('id="admin-batch-bar"');
    expect(TEMPLATE).toContain('id="admin-batch-dialog"');
    expect(TEMPLATE).toContain('id="admin-batch-go"');
    // The permission prompt is behind the toggle's click only.
    const asks = TEMPLATE.split('Notification.requestPermission(').length - 1;
    expect(asks).toBe(1);
    expect(clientFn('toggleAdminNotify')).toContain('Notification.requestPermission(');
  });
});
