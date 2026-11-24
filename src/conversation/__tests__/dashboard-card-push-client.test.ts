/**
 * The page side of a card push as its changed fields (card-push.ts, dashboard perf 2026-11-24): a `sessionPatch`
 * makes the card from this page's copy and goes down the same path as a whole `sessionUpdated`; a `task_update`
 * redraws the card from the list it carries instead of fetching the whole board.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// ── The shipped client code, cut out of renderDashboardPage()'s template literal ──
const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown>): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

describe('patchedSession — the card a patch makes of the copy this page holds', () => {
  const { patchedSession } = load<{ patchedSession: (held: any, msg: any) => any }>(['patchedSession'], {});

  it('sets the changed fields, removes the ones that left, keeps the rest — as a new object', () => {
    const held = { key: 'k', title: 'old', goal: { g: 1 }, earlierTasks: [{ id: 'T1' }] };
    const out = patchedSession(held, { key: 'k', set: { title: 'new' }, unset: ['goal'] });
    expect(out).toEqual({ key: 'k', title: 'new', earlierTasks: [{ id: 'T1' }] });
    expect(out).not.toBe(held);
    expect(held).toEqual({ key: 'k', title: 'old', goal: { g: 1 }, earlierTasks: [{ id: 'T1' }] });
  });

  it('no copy held: null (the next whole push or board poll brings the card)', () => {
    expect(patchedSession(undefined, { key: 'k', set: { title: 'x' } })).toBeNull();
  });
});

describe('the socket — sessionPatch goes down the sessionUpdated path; task_update polls nothing', () => {
  function page(cache: Record<string, any>) {
    let sock: any = null;
    const calls: string[] = [];
    class FakeWebSocket {
      onopen: any;
      onclose: any;
      onerror: any;
      onmessage: any;
      constructor() {
        sock = this;
      }
      close() {}
    }
    const inject: Record<string, unknown> = {
      WebSocket: FakeWebSocket,
      location: { protocol: 'https:', host: 'x' },
      ws: null,
      _sessionCache: cache,
      _cardHost: { k: {} },
      onServerBuild: () => false,
      followupReconcile: () => {},
      acEvict: () => {},
      patchLastBoard: (s: any) => calls.push(`patchLastBoard:${s.title}`),
      refreshCard: (key: string) => calls.push(`refreshCard:${key}`),
      autoOpenDecisions: () => {},
      applyEpicPush: () => {},
      epicChildOf: () => null,
      panelOpen: false,
      panelSessionKey: null,
      loadSessions: () => calls.push('loadSessions'),
      repaintPanelSession: () => calls.push('repaintPanelSession'),
    };
    const { connectWs } = load<{ connectWs: () => void }>(['patchedSession', 'connectWs'], inject);
    connectWs();
    const send = (msg: unknown) => sock.onmessage({ data: JSON.stringify(msg) });
    return { send, calls, cache };
  }

  it('a patch updates the cached card and redraws it like a whole push', () => {
    const { send, calls, cache } = page({ k: { key: 'k', title: 'old', earlierTasks: [1, 2] } });
    send({ type: 'sessionPatch', key: 'k', set: { title: 'new' } });
    expect(cache.k).toEqual({ key: 'k', title: 'new', earlierTasks: [1, 2] });
    expect(calls).toEqual(['patchLastBoard:new', 'refreshCard:k']);
  });

  it('a patch for a card this page does not hold is dropped', () => {
    const { send, calls, cache } = page({});
    send({ type: 'sessionPatch', key: 'k', set: { title: 'new' } });
    expect(cache.k).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('task_update redraws the card from the list it carries — no whole-board fetch', () => {
    const { send, calls, cache } = page({ k: { key: 'k', tasks: [] } });
    send({ type: 'task_update', sessionKey: 'k', tasks: [{ id: 'T1' }], earlierTasks: [] });
    expect(cache.k.tasks).toEqual([{ id: 'T1' }]);
    expect(calls).toEqual(['refreshCard:k']);
  });
});
