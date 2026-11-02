/**
 * SSOT 2026-11-02 T1 — an instruction sent from the open card shows once.
 *
 * The panel shows this browser's own instruction at once as an optimistic turn ('나'); the
 * recorded turn the server pushes (conversation_update) must take its place. Before this fix it
 * did so only within 10 s of the send and only on byte-equal text, and a page fetched while it was
 * out kept the optimistic turn beside the recorded one — the instruction showed twice ('나' + 'Z').
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it — the harness of dashboard-task-view-client.test.ts).
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
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

type Turn = {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  rawContent?: string;
  userName?: string;
  userId?: string;
  origin?: { by: string };
  _optimistic?: boolean;
  _sent?: string;
};

const T0 = 1_793_591_000_000;
const SAID =
  'prada에서 passkey 서비스를 접속하지말고, gucci_service에서 passkey서비스에서 필요한 api를 포워딩해서\n작업 계획까지 만든후에 & 컴펌받고 진행\n(이러면 도메인 연결 필요 없음)';
const optimistic = (sent: string, at = T0, id = `optimistic-${at}`): Turn => ({
  id,
  role: 'user',
  timestamp: at,
  userName: '나',
  rawContent: sent,
  origin: { by: 'user' },
  _optimistic: true,
  _sent: sent,
});
const recorded = (raw: string, at: number, extra: Partial<Turn> = {}): Turn => ({
  id: `srv-${at}`,
  role: 'user',
  timestamp: at,
  userName: 'Z',
  userId: 'U_Z',
  rawContent: raw,
  origin: { by: 'user' },
  ...extra,
});

const PURE = [
  'toNum',
  'decodeSlackEntities',
  'ptSentKey',
  'ptUpsert',
  'ptOptimisticFor',
  'ptRecorded',
  'ptMergeFetched',
];
type Pure = {
  ptSentKey(s: string): string;
  ptOptimisticFor(list: Turn[], turn: Turn, viewerId: string): string;
  ptMergeFetched(fetched: Turn[], pushed: Turn[]): Turn[];
};

/** The WS path: the turn pushed for the conversation open in the panel. */
function wsRig(list: Turn[], viewer = 'U_Z') {
  const painted: number[] = [];
  const m = load<{ onConversationTurn(cid: string, turn: Turn): void }>(
    [...PURE, 'appendTurnToPanel', 'onConversationTurn'],
    {
      panelOpen: true,
      panelConvId: 'C1',
      _panelTurnsList: list,
      _panelTurnsMsg: '',
      _psec: 'conv',
      _panelAgent: '',
      _viewerUserId: viewer,
      convPaint: () => painted.push(1),
      convEl: () => null,
      invalidateCardIo: () => {},
      umOnTurn: () => {},
    },
  );
  return { push: (t: Turn) => m.onConversationTurn('C1', t), names: () => list.map((t) => t.userName) };
}

describe('T1 — the recorded instruction takes the optimistic one’s place, however late it lands', () => {
  it('a recorded turn 15 s after the send replaces the optimistic one (no time window)', () => {
    const list: Turn[] = [optimistic(SAID)];
    const r = wsRig(list);
    r.push(recorded(SAID, T0 + 15_000));
    expect(r.names()).toEqual(['Z']);
    expect(list[0].id).toBe(`srv-${T0 + 15_000}`);
  });

  it('the server’s copy may differ in Slack entities, line ends and blanks — still the same instruction', () => {
    const list: Turn[] = [optimistic(SAID)];
    const r = wsRig(list);
    r.push(recorded(`  ${SAID.replace('&', '&amp;').replace(/\n/g, '\r\n')}  `, T0 + 2_000));
    expect(r.names()).toEqual(['Z']);
  });

  it('text the server changed beyond that: the viewer’s own next instruction still takes it over', () => {
    const list: Turn[] = [optimistic('배포해줘')];
    const r = wsRig(list);
    r.push(recorded('<@U_BOT> 배포해줘', T0 + 40_000));
    expect(r.names()).toEqual(['Z']);
  });

  it('someone else’s instruction, or a turn soma-work put there, never takes it', () => {
    const list: Turn[] = [optimistic('배포해줘')];
    const r = wsRig(list);
    r.push(recorded('다른 지시', T0 + 1_000, { id: 'other', userId: 'U_OTHER', userName: 'Chris' }));
    r.push(recorded('/compact', T0 + 2_000, { id: 'sys', origin: { by: 'system' } }));
    expect(r.names()).toEqual(['나', 'Chris', 'Z']);
  });

  it('a second push of a turn already shown is an update in place, not an adoption', () => {
    const first = recorded('먼저 한 지시', T0 - 60_000);
    const list: Turn[] = [first, optimistic('배포해줘')];
    const r = wsRig(list);
    r.push({ ...first, rawContent: '먼저 한 지시' });
    expect(list.map((t) => t.id)).toEqual([first.id, `optimistic-${T0}`]);
  });

  it('two sends in a row: each recorded turn takes its own', () => {
    const list: Turn[] = [optimistic('하나', T0, 'optimistic-1'), optimistic('둘', T0 + 500, 'optimistic-2')];
    const r = wsRig(list);
    r.push(recorded('둘', T0 + 20_000));
    r.push(recorded('하나', T0 + 21_000));
    expect(list.map((t) => t.rawContent)).toEqual(['하나', '둘']);
    expect(list.every((t) => !t._optimistic)).toBe(true);
  });
});

describe('T1 — a page fetched while the instruction was out drops the optimistic turn it already records', () => {
  const m = load<Pure>(PURE);

  it('the fetched page holds the recorded instruction: the optimistic one goes', () => {
    const page = [recorded('이전', T0 - 90_000), recorded(SAID, T0 + 30_000)];
    const merged = m.ptMergeFetched(page, [optimistic(SAID)]);
    expect(merged.map((t) => t.userName)).toEqual(['Z', 'Z']);
  });

  it('not recorded yet (or only an older turn with the same words): it stays, after the page', () => {
    const page = [recorded('계속', T0 - 600_000)];
    const merged = m.ptMergeFetched(page, [optimistic('계속')]);
    expect(merged.map((t) => t.userName)).toEqual(['Z', '나']);
  });

  it('the old 10 s window and byte-equal match are gone from the page', () => {
    expect(TEMPLATE).not.toContain('_lastSentContent');
    expect(TEMPLATE).not.toContain('(Date.now() - _lastSentTime) < 10000');
    expect(TEMPLATE).toContain('onConversationTurn(msg.conversationId, msg.turn)');
    expect(TEMPLATE).toContain('_panelTurnsList = ptMergeFetched(turns, _panelTurnsList)');
  });
});
