/**
 * SSOT 2026-11-12 — a message sent while a turn works shows in 지시와 답변 at once, under what is
 * happening to it, and says so when the running turn took it in.
 *
 * Before: such a message showed in the composer's queue only. The chat said nothing until the model
 * answered; a `Send now` that took a minute (the running turn is stopped and a new one started) read
 * as a lost press — "언제 되는지도 모르겠고".
 *
 *   sent ─► [나] 보내는 중…            (this browser's own turn, at the press)
 *        ─► 대기 중 / 처리 중 …        (the queue lists it: its state, above its words)
 *        ─► 반영됨 …                    (the running turn read it — the recorded turn says so for good)
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked
 * exactly as the browser receives it — the harness of dashboard-system-turns-client.test.ts).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextActionSeams } from '../__fixtures__/viewer-scope';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  inject = { ...nextActionSeams(fns, inject), ...inject };
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

type Turn = Record<string, unknown> & { id: string; role: string };
type Row = {
  id: string;
  text: string;
  files: string[];
  enqueuedAt: number;
  state: string;
  epoch: number;
  editable: boolean;
  authorId?: string;
  author?: string;
  clientRef?: string;
};
type Settled = Row & { outcome: 'consumed' | 'cancelled' };
type Queue = { turnEpoch: number; items: Row[]; settled?: Settled[] };
type QueueTurns = {
  chips: Record<string, string>;
  extra: Turn[];
  seen: string[];
  drop: string[];
  edits: Record<string, { rawContent: string; sent: string; files: number }>;
};

const T0 = 1_794_000_000_000;
const VIEWER = 'U_Z';

const QUEUE_FNS = ['toNum', 'decodeSlackEntities', 'ptSentKey', 'ptSameSend', 'ptRecorded', 'convQueueTurns'];
const QUEUE_VARS = ['STEER_STATE', 'STEER_CHIP_OF'];

function queueApi(viewer = VIEWER) {
  return load<{ convQueueTurns(list: Turn[], fu: Queue | undefined, ownerName?: string): QueueTurns }>(
    QUEUE_FNS,
    QUEUE_VARS,
    { _viewerUserId: viewer },
  );
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 'k#7',
  text: '테스트도 같이 돌려줘',
  files: [],
  enqueuedAt: T0 + 5_000,
  state: 'queued',
  epoch: 1,
  editable: true,
  authorId: VIEWER,
  ...over,
});
const opening: Turn = {
  id: 'srv-1',
  role: 'user',
  timestamp: T0,
  userName: 'Z',
  userId: VIEWER,
  rawContent: '배포 스크립트 고쳐줘',
  origin: { by: 'user' },
};
const optimistic = (over: Record<string, unknown> = {}): Turn => ({
  id: 'optimistic-1-abc',
  role: 'user',
  timestamp: T0 + 5_000,
  userName: '나',
  rawContent: '테스트도 같이 돌려줘',
  origin: { by: 'user' },
  _optimistic: true,
  _sent: '테스트도 같이 돌려줘',
  _files: 0,
  _by: VIEWER,
  _running: true,
  ...over,
});

describe('the queue as turns of the chat (convQueueTurns)', () => {
  it('a message the queue holds is a turn of the chat, under what is happening to it', () => {
    const q = queueApi().convQueueTurns([opening], {
      turnEpoch: 3,
      items: [
        row({ id: 'k#7', state: 'queued' }),
        row({ id: 'k#8', state: 'steered', text: '로그도 &lt;남겨줘&gt;', files: ['shot.png'] }),
        row({ id: 'k#9', state: 'reserved', text: '이걸 먼저 해줘' }),
      ],
    });
    expect(q.extra.map((t) => t.id)).toEqual(['queue-k#7', 'queue-k#8', 'queue-k#9']);
    expect(q.chips).toEqual({ 'queue-k#7': 'queued', 'queue-k#8': 'steered', 'queue-k#9': 'starting' });
    // A person's turn, the viewer's own as 나; its files by name under its words (as stored: the turn decodes them).
    expect(q.extra[1]).toMatchObject({
      role: 'user',
      userName: '나',
      rawContent: '로그도 &lt;남겨줘&gt;\n📎 shot.png',
      origin: { by: 'user' },
      timestamp: T0 + 5_000,
    });
  });

  it('claimed and dispatched read as starting too; someone else’s message carries their name', () => {
    const q = queueApi().convQueueTurns(
      [opening],
      {
        turnEpoch: 3,
        items: [
          row({ id: 'k#1', state: 'claimed', authorId: 'U_OTHER', author: 'Mina' }),
          row({ id: 'k#2', state: 'dispatched', authorId: 'U_OWNER' }),
          row({ id: 'k#3', state: 'paused' }),
        ],
      },
      'Owner',
    );
    expect(q.chips).toEqual({ 'queue-k#1': 'starting', 'queue-k#2': 'starting', 'queue-k#3': 'queued' });
    expect(q.extra.map((t) => t.userName)).toEqual(['Mina', 'Owner', '나']);
  });

  it('this browser’s own turn carries the state — never a second copy beside it', () => {
    const mine = optimistic();
    const q = queueApi().convQueueTurns([opening, mine], {
      turnEpoch: 3,
      items: [row({ state: 'steered', clientRef: 'optimistic-1-abc' })],
    });
    expect(q.extra).toEqual([]);
    expect(q.chips).toEqual({ 'optimistic-1-abc': 'steered' });
    expect(q.seen).toEqual(['optimistic-1-abc']);
  });

  it('sent while a turn runs and not listed yet: 보내는 중; once listed and off the list again: no state', () => {
    const api = queueApi();
    const fresh = optimistic();
    expect(api.convQueueTurns([opening, fresh], undefined).chips).toEqual({ 'optimistic-1-abc': 'sending' });
    // The queue listed it once (convPaint marked it), and no longer does: its recorded turn is on the way.
    const listed = optimistic({ _rowSeen: true });
    expect(api.convQueueTurns([opening, listed], { turnEpoch: 3, items: [] }).chips).toEqual({});
    // A turn sent while idle starts its own turn: it never read 보내는 중.
    const idle = optimistic({ _running: false });
    expect(api.convQueueTurns([opening, idle], undefined).chips).toEqual({});
  });

  it('a message already recorded as a turn is not shown twice', () => {
    const api = queueApi();
    // By its ref (a dashboard send dispatched as its own turn: recorded at the start, still listed until it reaches the model).
    const byRef: Turn = {
      ...opening,
      id: 'srv-2',
      timestamp: T0 + 6_000,
      rawContent: '다른 말',
      clientRef: 'optimistic-9',
    };
    expect(
      api.convQueueTurns([opening, byRef], {
        turnEpoch: 3,
        items: [row({ state: 'dispatched', clientRef: 'optimistic-9' })],
      }).extra,
    ).toEqual([]);
    // By its words and sender (sent in Slack: no ref).
    const byWords: Turn = { ...opening, id: 'srv-3', timestamp: T0 + 5_500, rawContent: '테스트도 같이 돌려줘' };
    expect(
      api.convQueueTurns([opening, byWords], { turnEpoch: 3, items: [row({ state: 'dispatched' })] }).extra,
    ).toEqual([]);
    // One recorded turn records one message: the second "계속" still shows.
    const again = api.convQueueTurns([opening, byWords], {
      turnEpoch: 3,
      items: [row({ id: 'k#7', state: 'dispatched' }), row({ id: 'k#8', state: 'queued' })],
    });
    expect(again.extra.map((t) => t.id)).toEqual(['queue-k#8']);
  });

  it('an old failure stays the queue’s (Retry and Cancel are there); this browser’s own failed send says so', () => {
    const api = queueApi();
    const old = api.convQueueTurns([opening], {
      turnEpoch: 3,
      items: [row({ state: 'failed' }), row({ id: 'k#8', state: 'uncertain' })],
    });
    expect(old.extra).toEqual([]);
    expect(old.chips).toEqual({});
    const mine = api.convQueueTurns([opening, optimistic()], {
      turnEpoch: 3,
      items: [row({ state: 'failed', clientRef: 'optimistic-1-abc' })],
    });
    expect(mine.chips).toEqual({ 'optimistic-1-abc': 'failed' });
  });

  it('read by the running turn: 반영됨 until the recorded turn takes its place', () => {
    const api = queueApi();
    const settled = [{ ...row({ state: 'resolved' }), outcome: 'consumed' as const }];
    // Sent elsewhere: the message stays in the chat as taken in.
    const elsewhere = api.convQueueTurns([opening], { turnEpoch: 3, items: [], settled });
    expect(elsewhere.extra.map((t) => t.id)).toEqual(['queue-k#7']);
    expect(elsewhere.chips).toEqual({ 'queue-k#7': 'applied' });
    // This browser's turn: the same, on its own turn.
    const mine = api.convQueueTurns([opening, optimistic({ _rowSeen: true })], {
      turnEpoch: 3,
      items: [],
      settled: [{ ...settled[0], clientRef: 'optimistic-1-abc' }],
    });
    expect(mine.extra).toEqual([]);
    expect(mine.chips).toEqual({ 'optimistic-1-abc': 'applied' });
    // Recorded: the turn itself says it (origin.steered) — the queue adds nothing.
    const recorded: Turn = {
      ...opening,
      id: 'srv-4',
      timestamp: T0 + 4_900,
      rawContent: '테스트도 같이 돌려줘',
      origin: { by: 'user', steered: true },
    };
    const after = api.convQueueTurns([opening, recorded], { turnEpoch: 3, items: [], settled });
    expect(after.extra).toEqual([]);
    expect(after.chips).toEqual({});
  });

  it('cancelled: this browser’s turn leaves the chat; nothing is shown for one sent elsewhere', () => {
    const api = queueApi();
    const cancelled = { ...row({ state: 'cancelled', clientRef: 'optimistic-1-abc' }), outcome: 'cancelled' as const };
    const q = api.convQueueTurns([opening, optimistic()], { turnEpoch: 3, items: [], settled: [cancelled] });
    expect(q.drop).toEqual(['optimistic-1-abc']);
    expect(q.chips).toEqual({});
    expect(q.extra).toEqual([]);
    const other = api.convQueueTurns([opening], { turnEpoch: 3, items: [], settled: [cancelled] });
    expect(other).toEqual({ chips: {}, extra: [], seen: [], drop: [], edits: {} });
  });

  // PR #1227 review: a queued message can be edited in the queue. The chat's turn follows the words that will run.
  it('this browser’s turn follows an edit of its queued message', () => {
    const api = queueApi();
    const same = api.convQueueTurns([opening, optimistic()], {
      turnEpoch: 3,
      items: [row({ clientRef: 'optimistic-1-abc' })],
    });
    expect(same.edits).toEqual({});
    const edited = api.convQueueTurns([opening, optimistic()], {
      turnEpoch: 3,
      items: [row({ clientRef: 'optimistic-1-abc', text: '테스트는 &lt;통합&gt;만 돌려줘', files: ['a.png'] })],
    });
    expect(edited.edits).toEqual({
      'optimistic-1-abc': {
        rawContent: '테스트는 &lt;통합&gt;만 돌려줘\n📎 a.png',
        sent: '테스트는 &lt;통합&gt;만 돌려줘',
        files: 1,
      },
    });
    expect(edited.chips).toEqual({ 'optimistic-1-abc': 'queued' });
  });

  // PR #1227 review: a message that was read keeps its recorded turn; the same words queued again right after
  // are a new message and still show as waiting.
  it('a read message claims its recorded turn before a newer message with the same words', () => {
    const recorded: Turn = { ...opening, id: 'srv-5', timestamp: T0 + 4_900, rawContent: '계속' };
    const q = queueApi().convQueueTurns([opening, recorded], {
      turnEpoch: 3,
      items: [row({ id: 'k#8', text: '계속', enqueuedAt: T0 + 20_000 })],
      settled: [{ ...row({ id: 'k#7', text: '계속', state: 'resolved' }), outcome: 'consumed' as const }],
    });
    expect(q.extra.map((t) => t.id)).toEqual(['queue-k#8']);
    expect(q.chips).toEqual({ 'queue-k#8': 'queued' });
  });

  it('no queue, nothing to add', () => {
    expect(queueApi().convQueueTurns([opening], undefined)).toEqual({
      chips: {},
      extra: [],
      seen: [],
      drop: [],
      edits: {},
    });
  });
});

describe('what is happening to a message, above its words', () => {
  const CHIP_VARS = [
    'STEER_CHIP_SENDING',
    'STEER_CHIP_QUEUED',
    'STEER_CHIP_STEERED',
    'STEER_CHIP_STARTING',
    'STEER_CHIP_FAILED',
    'STEER_CHIP_APPLIED',
    'STEER_CHIP',
  ];
  const chips = () => load<{ steerChipHtml(kind: string): string }>(['esc', 'steerChipHtml'], CHIP_VARS);

  it('every state has its own words and tone; an unknown one draws nothing', () => {
    const { steerChipHtml } = chips();
    const tone = (kind: string) => /cv-steer-(\w+)/.exec(steerChipHtml(kind))?.[1];
    expect(steerChipHtml('sending')).toContain('보내는 중');
    expect(steerChipHtml('queued')).toContain('대기 중');
    expect(steerChipHtml('steered')).toContain('처리 중');
    expect(steerChipHtml('starting')).toContain('처리 중');
    expect(steerChipHtml('failed')).toContain('보내지 못했어요');
    expect(steerChipHtml('applied')).toContain('반영됨');
    expect(['sending', 'queued', 'steered', 'starting', 'failed', 'applied'].map(tone)).toEqual([
      'wait',
      'wait',
      'work',
      'work',
      'fail',
      'done',
    ]);
    // A state a screen reader is told about.
    expect(steerChipHtml('steered')).toContain('role="status"');
    expect(steerChipHtml('nope')).toBe('');
    expect(steerChipHtml('')).toBe('');
  });

  const TURN_FNS = [
    'esc',
    'escAttr',
    'escJs',
    'toNum',
    'decodeSlackEntities',
    'formatTokens',
    'formatDuration',
    'sysOneLine',
    'sysBetween',
    'sysResumeContext',
    'sysTurnInfo',
    'estimateTokens',
    'splitInvokedSkills',
    'ansCacheKey',
    'artInTurn',
    'convSummaryOf',
    'convTurnsOf',
  ];
  const TURN_VARS = ['SYS_RESTART_HEADS', 'SYS_RESUME_CONTEXT', 'SYS_RETRY_MARK', '_skillBodies', '_skillSeq'];
  type Built = { turns: Turn[]; slots: { name: string; kind: string; list: unknown[]; chip?: string }[] };
  const conv = (list: Turn[], c: Record<string, unknown> = {}) =>
    load<{ convTurnsOf(list: Turn[], c: Record<string, unknown>): Built }>(TURN_FNS, TURN_VARS, {
      STRINGS: { summaryFailed: '요약 실패', summaryPending: '요약 만드는 중…' },
      convSysTurn: () => ({}),
    }).convTurnsOf(list, { cid: 'c', bot: 'Soma', now: T0, working: true, answers: {}, failed: {}, arts: [], ...c });

  it('a turn with a state asks for its slot — the element puts it above the words', () => {
    const built = conv([opening, optimistic()], { chips: { 'optimistic-1-abc': 'steered' } });
    expect(built.turns[0]).not.toHaveProperty('media');
    expect(built.turns[1]).toMatchObject({ id: 'optimistic-1-abc', role: 'user', media: true });
    expect(built.slots).toEqual([
      expect.objectContaining({ name: 'media-optimistic-1-abc', kind: 'media', list: [], chip: 'steered' }),
    ]);
  });

  it('a recorded turn the running turn took in says 반영됨 for good', () => {
    const steered: Turn = { ...opening, id: 'srv-9', origin: { by: 'user', steered: true } };
    const built = conv([opening, steered]);
    expect(built.slots).toEqual([expect.objectContaining({ name: 'media-srv-9', chip: 'applied' })]);
    // A turn that opened its own turn says nothing.
    expect(conv([opening]).slots).toEqual([]);
  });
});

// PR #1227 review: the paint itself, with the real queue helper — what the pure function returns must reach
// the turns the element is handed.
describe('the chat as painted (convPaint with the real convQueueTurns)', () => {
  function painter(list: Turn[], session: Record<string, unknown>) {
    const sets: { turns: { id: string; text?: string }[] }[] = [];
    const m = load<{ convPaint(): void }>(
      ['toNum', 'decodeSlackEntities', 'ptSentKey', 'ptSameSend', 'ptRecorded', 'convQueueTurns', 'convPaint'],
      ['STEER_STATE', 'STEER_CHIP_OF', 'CONV_EMPTY', '_resumSent'],
      {
        _viewerUserId: VIEWER,
        convEl: () => ({}),
        _psec: 'conv',
        _panelAgent: '',
        panelSessionKey: 'k',
        _sessionCache: { k: session },
        panelConvId: 'c',
        _panelTurnsCid: 'c',
        _panelTurnsList: list,
        _panelTurnsMsg: '',
        _panelTurnsHasMore: false,
        _panelTurnsLoading: false,
        _panelTurnsWhy: '',
        _panelOlderWhy: '',
        _panelDetail: false,
        _rawLoadedCache: {},
        _ansFailed: {},
        _artCache: {},
        botNameOf: () => 'Soma',
        ansLinkTitles: () => ({}),
        ansSession: () => null,
        ansPendingShow: () => false,
        convTurnsOf: (turns: Turn[], c: { chips: Record<string, string> }) => ({
          turns: turns.map((t) => ({ id: t.id, text: String(t.rawContent), chip: c.chips[t.id] })),
          slots: [],
        }),
        convSlots: () => {},
        convSetData: (_el: unknown, d: { turns: { id: string }[] }) => sets.push(d),
        rbIndex: () => null,
        rewindSpansOf: () => null,
      },
    );
    return { paint: () => m.convPaint(), last: () => sets[sets.length - 1].turns };
  }

  it('a listed send shows its state; cancelled, its turn is gone from the chat and from the panel’s list', () => {
    const list: Turn[] = [opening, optimistic()];
    const session: Record<string, unknown> = {
      activityState: 'working',
      ownerName: 'Z',
      followups: { turnEpoch: 3, items: [row({ clientRef: 'optimistic-1-abc' })] },
    };
    const p = painter(list, session);
    p.paint();
    expect(p.last()).toEqual([
      expect.objectContaining({ id: 'srv-1' }),
      expect.objectContaining({ id: 'optimistic-1-abc', chip: 'queued' }),
    ]);
    expect(list[1]._rowSeen).toBe(true);

    session.followups = {
      turnEpoch: 3,
      items: [],
      settled: [{ ...row({ state: 'cancelled', clientRef: 'optimistic-1-abc' }), outcome: 'cancelled' }],
    };
    p.paint();
    expect(p.last().map((t) => t.id)).toEqual(['srv-1']);
    expect(list.map((t) => t.id)).toEqual(['srv-1']);
  });

  it('an edit of the queued message reaches the painted turn', () => {
    const list: Turn[] = [opening, optimistic()];
    const p = painter(list, {
      activityState: 'working',
      followups: { turnEpoch: 3, items: [row({ clientRef: 'optimistic-1-abc', text: '통합 테스트만 돌려줘' })] },
    });
    p.paint();
    expect(p.last()[1]).toMatchObject({ id: 'optimistic-1-abc', text: '통합 테스트만 돌려줘', chip: 'queued' });
    expect(list[1]._sent).toBe('통합 테스트만 돌려줘');
  });

  it('a message sent elsewhere is painted after the turns the panel holds', () => {
    const p = painter([opening], {
      activityState: 'working',
      ownerName: 'Z',
      followups: { turnEpoch: 3, items: [row({ state: 'steered' })] },
    });
    p.paint();
    expect(p.last()).toEqual([
      expect.objectContaining({ id: 'srv-1' }),
      expect.objectContaining({ id: 'queue-k#7', chip: 'steered' }),
    ]);
  });
});
