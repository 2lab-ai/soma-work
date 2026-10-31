/**
 * Dashboard batch 2 — the panel composer and the session's follow-up queue on @2lab.ai/ui
 * <ui-agent-steering>. Executes the shipped client code cut out of renderDashboardPage()'s template
 * literal, cooked as the browser receives it (the harness of dashboard-affectui-batch1-client.test.ts),
 * with injected fakes — no DOM.
 *
 *   steeringData   KanbanSession.followups + the panel's mode → the element's data
 *   pcInit         the element's events (they bubble, composed) → the page's handlers on #panel-command
 *   steerAct       ui-promote / ui-cancel / ui-edit → the owner-only queue route, with the generation the
 *                  panel showed; a refusal rolls the note back (setItemState) and says it in a toast
 *   the page       the module script and its served file
 *
 * The element's own behaviour (keys, IME, optimistic rows, Retry, the edit box) is the library's:
 * ui/src/components/agent-steering/agent-steering.test.ts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_LIB_FILE, uiLibDistDir } from '../dashboard';

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
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}
const HEAD = TEMPLATE.slice(0, TEMPLATE.indexOf('<style>'));

const KEY = 'inst::C1:t1';
const item = (over: Record<string, unknown> = {}) => ({
  id: `${KEY}#1`,
  text: 'also check the logs',
  files: [],
  enqueuedAt: 1_700_000_000_000,
  state: 'queued',
  epoch: 3,
  editable: true,
  ...over,
});

describe('steeringData — the session payload as the element’s data', () => {
  const data = load<{ steeringData(s: unknown, mode: string): Record<string, any> }>(
    ['steeringData'],
    ['STEER_STATE'],
  ).steeringData;

  it('the queue’s ten states fold to the element’s five; history and id-less rows are not shown', () => {
    const states = [
      'queued',
      'paused',
      'steered',
      'reserved',
      'claimed',
      'dispatched',
      'failed',
      'uncertain',
      'resolved',
      'cancelled',
    ];
    const s = {
      activityState: 'working',
      followups: {
        turnEpoch: 7,
        items: [...states.map((st, i) => item({ id: `k#${i}`, state: st })), item({ id: '' })],
      },
    };
    expect(data(s, 'open').items.map((it: { id: string; state: string }) => [it.id, it.state])).toEqual([
      ['k#0', 'queued'],
      ['k#1', 'queued'], // paused: Send now runs it
      ['k#2', 'steered'],
      ['k#3', 'sending'],
      ['k#4', 'sending'],
      ['k#5', 'sending'],
      ['k#6', 'failed'],
      ['k#7', 'failed'], // uncertain: Retry
    ]);
  });

  it('a note carries its text, time, author, reason and files; Edit only where the server offers it', () => {
    const s = {
      activityState: 'working',
      followups: {
        turnEpoch: 7,
        items: [
          item(),
          item({ id: 'k#2', editable: false, author: 'Zhuge', stateReason: '편집됨', files: ['a.png', 'b.log'] }),
        ],
      },
    };
    expect(data(s, 'open').items).toEqual([
      { id: `${KEY}#1`, text: 'also check the logs', state: 'queued', canEdit: true, at: 1_700_000_000_000 },
      {
        id: 'k#2',
        text: 'also check the logs',
        state: 'queued',
        canEdit: false,
        at: 1_700_000_000_000,
        author: 'Zhuge',
        reason: '편집됨',
        files: ['a.png', 'b.log'],
      },
    ]);
  });

  it('running while a turn works (and not ended); canAct for the owner only; disabled once ended; no held files', () => {
    const s = { activityState: 'working' };
    // D4 E-30: the files of the next note are the slotted <ui-composer>'s — the page holds none (no attachments).
    expect(data(s, 'open')).toEqual({ running: true, canAct: true, disabled: false, items: [] });
    expect(data({ activityState: 'idle' }, 'open')).toMatchObject({ running: false });
    // Someone else's session: the queue shows, nothing can be done (the element: read-only placeholder, no buttons).
    expect(data(s, 'readonly')).toMatchObject({ canAct: false, disabled: false });
    expect(data(s, 'closed')).toMatchObject({ running: false, canAct: true, disabled: true });
  });
});

describe('pcInit — the element’s events reach the page’s handlers on #panel-command', () => {
  it('ui-promote / ui-cancel / ui-edit → steerAct with the note’s id (and the edit’s text); ui-submit → pcOnSubmit', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    const host = {
      _mode: 'open',
      classList: { add() {}, remove() {} },
      addEventListener: (ev: string, fn: (e: unknown) => void) => (listeners[ev] = fn),
    };
    const acts: unknown[][] = [];
    const submits: unknown[] = [];
    // The slotted composer gets the panel's limits; a cancelled note forgets the files kept for its Retry.
    const composer: { data: Record<string, unknown> } = { data: { lang: 'ko' } };
    const noteFiles: Record<string, unknown> = { 'k#2': ['a.png'], 'k#9': ['b.png'] };
    load<{ pcInit(): void }>(['pcComposerData', 'pcComposerSetup', 'pcInit'], ['PC_LIMITS'], {
      document: {
        getElementById: (id: string) => (id === 'panel-command' ? host : id === 'pc-composer' ? composer : null),
      },
      steerAct: (...a: unknown[]) => acts.push(a),
      pcOnSubmit: (e: unknown) => submits.push(e),
      pcOnReject: () => {},
      _pcNoteFiles: noteFiles,
    }).pcInit();
    expect(composer.data).toEqual({
      lang: 'ko',
      maxFiles: 10,
      maxFileSize: 20971520,
      maxTotalBytes: 31457280,
      minRows: 1,
      maxRows: 8,
    });
    // No paste / drag / drop of the page's own: the composer takes them.
    // (ui-reject: a file a task card refuses says why — merge review P3.)
    expect(Object.keys(listeners).sort()).toEqual(['ui-cancel', 'ui-edit', 'ui-promote', 'ui-reject', 'ui-submit']);
    listeners['ui-promote']({ detail: { id: 'k#1' } });
    listeners['ui-cancel']({ detail: { id: 'k#2' } });
    listeners['ui-edit']({ detail: { id: 'k#3', text: '고친 내용' } });
    listeners['ui-promote']({}); // no detail: nothing
    expect(acts).toEqual([
      ['promote', 'k#1'],
      ['cancel', 'k#2'],
      ['edit', 'k#3', '고친 내용'],
    ]);
    expect(noteFiles).toEqual({ 'k#9': ['b.png'] });
    const e = { detail: { text: 'go', mode: 'queue', ref: 'r1' } };
    listeners['ui-submit'](e);
    expect(submits).toEqual([e]);
  });

  it('pcOnSubmit: the open composer sends the note with its ref; a closed one, or a send already reading files, cancels it', () => {
    const sent: unknown[][] = [];
    const host = { _mode: 'open' };
    const env = { sending: false };
    const make = () =>
      load<{ pcOnSubmit(e: unknown): void }>(['pcOnSubmit'], [], {
        document: { getElementById: () => host },
        panelSessionKey: KEY,
        _pcSending: env.sending,
        sendCommand: (...a: unknown[]) => sent.push(a),
      }).pcOnSubmit;
    const file = { name: 'shot.png' };
    const ev = (files?: unknown[]) => ({
      detail: { text: 'go on', mode: 'steer', ref: 'r1', ...(files ? { files } : {}) },
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    });
    const a = ev();
    make()(a);
    expect(sent).toEqual([['go on', 'r1', []]]);
    expect(a.prevented).toBe(false);
    // The slotted composer's files ride along (D4 E-30).
    const f = ev([file]);
    make()(f);
    expect(sent[1]).toEqual(['go on', 'r1', [file]]);
    sent.length = 1;
    host._mode = 'closed';
    const b = ev();
    make()(b);
    expect(b.prevented).toBe(true); // the element keeps the text (library: "a cancelled ui-submit keeps the text")
    host._mode = 'open';
    env.sending = true;
    const c = ev();
    make()(c);
    expect(c.prevented).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe('steerAct — Send now / Cancel / Edit → the queue route; a refusal rolls back with a toast', () => {
  function rig(
    res: { status: number; body?: unknown } | Error,
    opts: { followups?: unknown; switched?: boolean } = {},
  ) {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const rolled: unknown[][] = [];
    const toasts: unknown[] = [];
    const el = { setItemState: (...a: unknown[]) => rolled.push(a) };
    // Another card opened while the request was out: openPanel put a fresh element in (pcFreshSteer).
    const fresh = { setItemState: (...a: unknown[]) => rolled.push(['fresh', ...a]) };
    const state = { switched: false };
    const followups = opts.followups ?? {
      turnEpoch: 7,
      items: [item(), item({ id: `${KEY}#2`, state: 'failed', epoch: 9 })],
    };
    const m = load<{ steerAct(op: string, id: string, text?: string): Promise<void> }>(
      ['steerItemOf', 'acPost', 'steerAct'],
      ['STEER_STATE', 'STEER_FAIL'],
      {
        panelSessionKey: KEY,
        _sessionCache: { [KEY]: { key: KEY, followups } },
        document: { getElementById: (id: string) => (id === 'cmd-steer' ? (state.switched ? fresh : el) : null) },
        _csrfToken: 'csrf-1',
        refreshCsrfToken: async () => {},
        dashToast: (t: unknown) => toasts.push(t),
        fetch: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
          calls.push({ url, init });
          if (opts.switched) state.switched = true;
          if (res instanceof Error) throw res;
          return { ok: res.status < 400, status: res.status, json: async () => res.body ?? {} };
        },
      },
    );
    return { m, calls, rolled, toasts };
  }

  it('Send now: POST …/queue/<id>/promote with the note’s epoch and the session’s turnEpoch; the pushed list confirms it', async () => {
    const r = rig({ status: 200, body: { ok: true } });
    await r.m.steerAct('promote', `${KEY}#1`);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe(
      `/api/dashboard/session/${encodeURIComponent(KEY)}/queue/${encodeURIComponent(`${KEY}#1`)}/promote`,
    );
    expect(r.calls[0].init.method).toBe('POST');
    expect(r.calls[0].init.headers['X-CSRF-Token']).toBe('csrf-1');
    expect(JSON.parse(r.calls[0].init.body)).toEqual({ epoch: 3, turnEpoch: 7 });
    expect(r.rolled).toEqual([]);
    expect(r.toasts).toEqual([]); // Send now says nothing: its note moves
  });

  it('Edit carries the new text; Cancel’s receipt is a success toast', async () => {
    const e = rig({ status: 200, body: { ok: true } });
    await e.m.steerAct('edit', `${KEY}#1`, '고친 내용');
    expect(e.calls[0].url).toMatch(/\/queue\/[^/]+\/edit$/);
    expect(JSON.parse(e.calls[0].init.body)).toEqual({ epoch: 3, turnEpoch: 7, text: '고친 내용' });
    const c = rig({ status: 200, body: { ok: true, message: '취소했습니다.' } });
    await c.m.steerAct('cancel', `${KEY}#2`);
    expect(JSON.parse(c.calls[0].init.body)).toEqual({ epoch: 9, turnEpoch: 7 });
    expect(c.toasts).toEqual([{ title: '취소했습니다.', tone: 'success' }]);
  });

  it('a refusal (409 with the queue’s words) rolls the note back to its own state with them, and says so in a toast', async () => {
    const why = '이미 바뀐 항목입니다 — 목록을 최신 상태로 갱신했습니다. 다시 수정해 주세요.';
    const r = rig({ status: 409, body: { error: why } });
    await r.m.steerAct('edit', `${KEY}#1`, 'x');
    expect(r.rolled).toEqual([[`${KEY}#1`, 'queued', why]]);
    expect(r.toasts).toEqual([{ title: '수정하지 못했어요', description: why, tone: 'error' }]);
    // A failed note's refused Retry goes back to failed; someone else's session is a 403 with its words.
    const f = rig({ status: 403, body: { error: 'Only the session owner can perform this action' } });
    await f.m.steerAct('promote', `${KEY}#2`);
    expect(f.rolled).toEqual([[`${KEY}#2`, 'failed', 'Only the session owner can perform this action']]);
    expect(f.toasts).toEqual([
      { title: '지금 보내지 못했어요', description: 'Only the session owner can perform this action', tone: 'error' },
    ]);
  });

  it('a network error rolls back too; a body without words says the status', async () => {
    const n = rig(new Error('Failed to fetch'));
    await n.m.steerAct('cancel', `${KEY}#1`);
    expect(n.rolled).toEqual([[`${KEY}#1`, 'queued', 'Failed to fetch']]);
    expect(n.toasts).toEqual([{ title: '취소하지 못했어요', description: 'Failed to fetch', tone: 'error' }]);
    const b = rig({ status: 500, body: {} });
    await b.m.steerAct('promote', `${KEY}#1`);
    expect(b.rolled).toEqual([[`${KEY}#1`, 'queued', 'HTTP 500']]);
  });

  it('a row the queue does not have (a failed local send) asks nothing; a refusal for a panel switched meanwhile is only a toast', async () => {
    const local = rig({ status: 200 });
    await local.m.steerAct('cancel', 'r-local-1');
    expect(local.calls).toEqual([]);
    const moved = rig({ status: 409, body: { error: '이미 큐에 없는 항목입니다.' } }, { switched: true });
    await moved.m.steerAct('promote', `${KEY}#1`);
    expect(moved.rolled).toEqual([]);
    expect(moved.toasts).toEqual([
      { title: '지금 보내지 못했어요', description: '이미 큐에 없는 항목입니다.', tone: 'error' },
    ]);
  });
});

describe('the page loads <ui-agent-steering> from the dashboard origin', () => {
  it('a module script next to the batch-1 elements; the field is a <ui-composer slot="composer"> (D4 E-30)', () => {
    expect(HEAD).toContain('<script type="module" src="/dashboard/ui/agent-steering.js?v=${UI_LIB_VERSION}"></script>');
    expect(HEAD).toContain('<script type="module" src="/dashboard/ui/composer.js?v=${UI_LIB_VERSION}"></script>');
    const page = TEMPLATE.slice(TEMPLATE.indexOf('<div class="panel-command" id="panel-command">'));
    const steer = page.slice(page.indexOf('<ui-agent-steering id='), page.indexOf('</ui-agent-steering>'));
    expect(steer).toBe(
      '<ui-agent-steering id="cmd-steer" lang="ko"><ui-composer id="pc-composer" slot="composer" lang="ko"></ui-composer>',
    );
    // The page's own tools, chips, recorder and error line are gone with their code.
    for (const id of ['pc-attach', 'pc-image', 'pc-mic', 'pc-attachments', 'pc-recorder', 'pc-error', 'pc-file-input'])
      expect(TEMPLATE, id).not.toContain(`id="${id}"`);
    for (const gone of [
      'pcAddFiles',
      'pcAddBlob',
      'pcRemoveFile',
      'pcRenderFiles',
      'pcToggleRecording',
      'pcStopRecording',
      'pcFinishRecording',
      'pcHeldFiles',
      'pcSetError',
      'ntPickRecorderMime',
      'ntStamp',
    ])
      expect(declarationCount(gone), gone).toBe(0);
  });

  it('the installed @2lab.ai/ui carries agent-steering.js and its chunks (flat names the route serves)', () => {
    const dir = uiLibDistDir();
    expect(dir).toBeTruthy();
    const file = join(dir as string, 'agent-steering.js');
    expect(existsSync(file)).toBe(true);
    for (const imp of readFileSync(file, 'utf-8').match(/from\s*"\.\/([^"]+)"/g) ?? []) {
      const name = /"\.\/([^"]+)"/.exec(imp)?.[1] as string;
      expect(UI_LIB_FILE.test(name), name).toBe(true);
      expect(existsSync(join(dir as string, name)), name).toBe(true);
    }
  });

  it('the old composer is gone: no textarea, Send button, key handler or autosize of the page’s own', () => {
    for (const gone of ['pcKeydown', 'pcAutosize', 'pcEnterAction', 'sendRetry'])
      expect(declarationCount(gone), gone).toBe(0);
    expect(TEMPLATE).not.toMatch(/id="cmd-input"|id="cmd-send"|id="cmd-hint"|\.btn-send\b|\.panel-command-row\b/);
  });
});
