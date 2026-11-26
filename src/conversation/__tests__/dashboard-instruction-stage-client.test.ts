/**
 * #1466 (Z 2026-11-26) — an instruction sent from the detail card says where it really is.
 *
 *   "응답 작성중이 아니라 내가 지시한 내용이 어떻게 처리됐는지 실제가 궁금한거라고, 큐에 들어갔는지 대기중인지 모델이
 *    받았는지 명확하게 구분해서 표시해줘"
 *
 *   sent ─► 보내는 중…          (this browser, before the server said anything about it)
 *        ─► 접수됨              (the route took it)          ─┐
 *        ─► 승인 대기 / 작업 큐 대기 · N번째 / 시작 안 함       ├ the server's stages (s.instructionProgress, by ref)
 *        ─► 처리 중 · 새 작업을 시작하고 있어요                 │
 *        ─► 모델이 받았어요      (the turn's first SDK event) ─┘
 *        ─► the answer          (the chip goes; 응답 작성 중 shows only once the model has it)
 *
 * Executes the shipped page code (cut out of renderDashboardPage()'s template literal and cooked exactly as the
 * browser receives it — the harness of dashboard-steer-chat-client.test.ts).
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
type Progress = { ref: string; stage: string; at: number };

const T0 = 1_795_680_000_000;
const REF = 'optimistic-1795680000000-abc123';
const earlier: Turn = { id: 'srv-1', role: 'user', timestamp: T0 - 60_000, rawContent: '리포트 형식 확인해줘' };
const answered: Turn = { id: 'srv-2', role: 'assistant', timestamp: T0 - 30_000, summaryTitle: '확인했어요' };
const optimistic: Turn = {
  id: REF,
  role: 'user',
  timestamp: T0,
  rawContent: 'stage0 리포트에도 적용해줘',
  _optimistic: true,
};
const recorded: Turn = {
  id: 'srv-3',
  role: 'user',
  timestamp: T0,
  rawContent: 'stage0 리포트에도 적용해줘',
  clientRef: REF,
};
const answer: Turn = { id: 'srv-4', role: 'assistant', timestamp: T0 + 90_000, summaryTitle: '적용했어요' };
const at = (stage: string): Progress => ({ ref: REF, stage, at: T0 + 1_000 });

const CHIP_VARS = [
  'STEER_CHIP_SENDING',
  'STEER_CHIP_QUEUED',
  'STEER_CHIP_STEERED',
  'STEER_CHIP_STARTING',
  'STEER_CHIP_FAILED',
  'STEER_CHIP_APPLIED',
  'STEER_CHIP_RECEIVED',
  'STEER_CHIP_APPROVAL',
  'STEER_CHIP_USERQUEUE',
  'STEER_CHIP_USERQUEUE_AT',
  'STEER_CHIP_SAMEWORK',
  'STEER_CHIP_DELIVERED',
  'STEER_CHIP',
];

describe('the stage the server reported, on that instruction (convProgressChip)', () => {
  const { convProgressChip } = load<{
    convProgressChip(list: Turn[], s: unknown): { id: string; kind: string } | null;
  }>(['convProgressChip'], ['PROGRESS_CHIP']);

  it('each server stage has its chip — on this browser’s own turn, then on the recorded turn that keeps its ref', () => {
    const list = [earlier, answered, optimistic];
    expect(convProgressChip(list, { instructionProgress: at('received') })).toEqual({ id: REF, kind: 'received' });
    expect(convProgressChip(list, { instructionProgress: at('approval') })).toEqual({ id: REF, kind: 'approval' });
    expect(convProgressChip(list, { instructionProgress: at('queued') })).toEqual({ id: REF, kind: 'userqueue' });
    expect(convProgressChip(list, { instructionProgress: at('same-work') })).toEqual({ id: REF, kind: 'samework' });
    expect(convProgressChip(list, { instructionProgress: at('starting') })).toEqual({ id: REF, kind: 'starting' });
    expect(convProgressChip(list, { instructionProgress: at('delivered') })).toEqual({ id: REF, kind: 'delivered' });
    // The recorded turn took the optimistic one's place: same ref, its own id.
    expect(convProgressChip([earlier, answered, recorded], { instructionProgress: at('delivered') })).toEqual({
      id: 'srv-3',
      kind: 'delivered',
    });
  });

  it('waiting in the person’s task queue: its place in line, from the card', () => {
    const s = {
      instructionProgress: at('queued'),
      userQueue: { entryId: 'e1', kind: 'request', position: 2, since: T0 },
    };
    expect(convProgressChip([earlier, answered, recorded], s)).toEqual({ id: 'srv-3', kind: 'userqueue:2' });
  });

  it('nothing the server did not report: no record, an unknown stage, another instruction, or an answer after it', () => {
    expect(convProgressChip([earlier, optimistic], {})).toBeNull();
    expect(convProgressChip([earlier, optimistic], null)).toBeNull();
    expect(convProgressChip([earlier, optimistic], { instructionProgress: at('thinking') })).toBeNull();
    expect(
      convProgressChip([earlier, optimistic], { instructionProgress: { ...at('starting'), ref: 'optimistic-2-zzz' } }),
    ).toBeNull();
    // Answered: its stage is history.
    expect(convProgressChip([earlier, recorded, answer], { instructionProgress: at('delivered') })).toBeNull();
  });
});

describe('the chips’ words and tones', () => {
  const { steerChipHtml } = load<{ steerChipHtml(kind: string): string }>(
    ['esc', 'adminFmt', 'steerChipHtml'],
    CHIP_VARS,
  );
  const tone = (kind: string) => /cv-steer-(\w+)/.exec(steerChipHtml(kind))?.[1];

  it('says which stage it is, plainly, with a tone: waiting · working · not started', () => {
    expect(steerChipHtml('sending')).toContain('보내는 중');
    expect(steerChipHtml('received')).toContain('접수됨 · 서버가 받았어요');
    expect(steerChipHtml('approval')).toContain('승인 대기');
    expect(steerChipHtml('userqueue')).toContain('작업 큐 대기 · 내 다른 작업이 끝나면 시작해요');
    expect(steerChipHtml('userqueue:3')).toContain('작업 큐 대기 · 3번째 — 내 다른 작업이 끝나면 시작해요');
    expect(steerChipHtml('samework')).toContain('시작 안 함 · 같은 작업이 다른 스레드에서 이미 진행 중이에요');
    expect(steerChipHtml('starting')).toContain('새 작업을 시작하고 있어요');
    expect(steerChipHtml('delivered')).toContain('모델이 받았어요');
    expect(['received', 'approval', 'userqueue:3', 'samework', 'starting', 'delivered'].map(tone)).toEqual([
      'wait',
      'wait',
      'wait',
      'fail',
      'work',
      'work',
    ]);
    expect(steerChipHtml('delivered')).toContain('role="status"');
    expect(steerChipHtml('thinking')).toBe('');
  });
});

describe('the chat: the chip on the instruction, and 응답 작성 중 only once the model has it (convPaint)', () => {
  type Env = Record<string, unknown>;
  function paint(session: Env, list: Turn[]) {
    const sets: Record<string, unknown>[] = [];
    const chips: Record<string, string>[] = [];
    const el = { data: undefined };
    const m = load<{ convPaint(): void }>(
      ['botNameOf', 'ansLinkTitles', 'ansSession', 'ansPendingShow', 'convProgressChip', 'convPaint'],
      ['CONV_EMPTY', '_resumSent', 'PROGRESS_CHIP'],
      {
        convEl: () => el,
        _psec: 'conv',
        _panelAgent: '',
        renderAgentConv: () => {},
        BOT_NAME: 'Soma (Dev)',
        panelSessionKey: 'k',
        panelConvId: 'conv-run',
        _sessionCache: { k: { conversationId: 'conv-run', ...session } },
        _panelTurnsCid: 'conv-run',
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
        convTurnsOf: (l: unknown[], c: Env) => {
          chips.push({ ...(c.chips as Record<string, string>) });
          return { turns: l, slots: [] };
        },
        convSlots: () => {},
        convSetData: (_el: unknown, d: Record<string, unknown>) => sets.push(d),
        onRbTurnClick: () => {},
        rbIndex: () => null,
        rewindSpansOf: () => null,
      },
    );
    m.convPaint();
    return { data: sets[sets.length - 1], chips: chips[chips.length - 1] };
  }

  it('working but not yet the model’s: the instruction says where it is, and no 응답 작성 중', () => {
    const r = paint({ activityState: 'working', instructionProgress: at('starting') }, [earlier, answered, recorded]);
    expect(r.chips).toEqual({ 'srv-3': 'starting' });
    expect(r.data.pending).toBe(false);
  });

  it('the model has it: 모델이 받았어요 on the instruction, and the writing row under it', () => {
    const r = paint({ activityState: 'working', instructionProgress: at('delivered') }, [earlier, answered, recorded]);
    expect(r.chips).toEqual({ 'srv-3': 'delivered' });
    expect(r.data.pending).toBe(true);
  });

  it('idle in the task queue: its place in line; nothing is written yet', () => {
    const r = paint(
      {
        activityState: 'idle',
        instructionProgress: at('queued'),
        userQueue: { entryId: 'e1', kind: 'request', position: 1, since: T0 },
      },
      [earlier, answered, optimistic],
    );
    expect(r.chips).toEqual({ [REF]: 'userqueue:1' });
    expect(r.data.pending).toBe(false);
  });

  it('a message from Slack (no stage recorded): the writing row follows the session as before', () => {
    const r = paint({ activityState: 'working' }, [earlier, answered, { ...recorded, clientRef: undefined }]);
    expect(r.chips).toEqual({});
    expect(r.data.pending).toBe(true);
  });
});
