/**
 * Dashboard surface layouts (SSOT 2026-11-02, .prd/21) — what each surface shows, per user.
 *
 * Surfaces: the task card's face (`card`), the opened card (`open`), the detail card (`detail`) — for each of the
 * two modes (미니멀 · 어드밴스드) — and the Slack thread header (`thread`, "스레드 태스크 카드").
 *
 * Presets 1 · 2 · 3 are starting points the user edits (built-ins: .prd/20 §5). The task card (face + opened card)
 * and the detail card each use one preset — the user's default per surface (`active`), else the quick switch
 * (`dashboardPlan`), else 1. The thread card follows the task card (the default), keeps the server's Slack theme
 * (`config.json` `ui.threadheader`), or has its own lines.
 *
 * Every layout is an ordered list of items with an on/off switch, so a hidden item keeps its place (the editor
 * dims it). A list always holds every item of its catalog: an unknown id is dropped, a missing one is appended
 * off — a field added later shows up hidden, never in the way.
 *
 * Pure: no I/O. The dashboard and the settings page get BUILTIN_PRESETS and LAYOUT_CATALOG as JSON; the store
 * keeps `normalizeLayoutDoc`'s output; the Slack host maps a user's thread card with `threadCardLines`.
 */

import type { SurfaceLineConfig } from '@soma/slack/surface-config';

export type ViewMode = 'minimal' | 'advanced';
export type PresetId = '1' | '2' | '3';
export const PRESET_IDS: readonly PresetId[] = ['1', '2', '3'];
export const VIEW_MODES: readonly ViewMode[] = ['minimal', 'advanced'];

export const CARD_ROWS = ['summary', 'task', 'agents', 'usage', 'arts'] as const;
export const CARD_CHIPS = ['steps', 'ctx', 'media', 'pr', 'arts', 'cost', 'tokens', 'model'] as const;
export const OPEN_PARTS = ['tasks', 'agents', 'io', 'arts', 'goal', 'refs', 'model'] as const;
export const DETAIL_TOP = ['info', 'goal', 'needs', 'artifacts'] as const;
export const THREAD_INFO = ['owner', 'workflow', 'model', 'ctx', 'cost', 'tokens', 'task', 'steps'] as const;
export const THREAD_NAV = ['dashboardLink', 'linkhistory', 'links', 'status'] as const;

export type CardRowId = (typeof CARD_ROWS)[number];
export type CardChipId = (typeof CARD_CHIPS)[number];
export type OpenPartId = (typeof OPEN_PARTS)[number];
export type DetailTopId = (typeof DETAIL_TOP)[number];
export type ThreadInfoId = (typeof THREAD_INFO)[number];
export type ThreadNavId = (typeof THREAD_NAV)[number];

export interface LayoutItem<T extends string> {
  id: T;
  on: boolean;
  /** The item's option: the summary's rule (`all` · `asks`), the artifacts row's chip count (`1`–`4`). */
  opt?: string;
}

/** The card face: what leads the head, then its rows and its foot chips in order. Title and status always show. */
export interface FaceLayout {
  /** The kind mark (task · epic) instead of the ✦ on a plain card. */
  kind: boolean;
  /** The star toggle at the head's right end. */
  star: boolean;
  /** The owner's name pill (the All Users board). */
  owner: boolean;
  rows: LayoutItem<CardRowId>[];
  foot: LayoutItem<CardChipId>[];
}

/** The opened card: its ☆ button and its parts after the actions and what asks (always first). */
export interface OpenLayout {
  star: boolean;
  parts: LayoutItem<OpenPartId>[];
  /** A built-in's per-column order (the old body); an edit drops it — one order for every column. */
  byCol?: Partial<Record<'work' | 'wait' | 'done', OpenPartId[]>>;
}

export type DetailTasks = 'runs' | 'list' | 'line' | 'none';
export type DetailAgents = 'all' | 'sub' | 'none';

/** The detail card: its top sections in order, its tasks, its strips and controls. Chat and composer always show. */
export interface DetailLayout {
  top: LayoutItem<DetailTopId>[];
  tasks: DetailTasks;
  /** The checklist's share of the card (cqh), for `list` and `line`. */
  tasksMax: number;
  agents: DetailAgents;
  agenthead: boolean;
  sections: boolean;
  controls: boolean;
  subtitle: boolean;
  /** Sections open unfolded (the old 자세히). */
  open: boolean;
}

export interface ModeLayouts {
  card: FaceLayout;
  open: OpenLayout;
  detail: DetailLayout;
}

export interface PresetLayouts {
  name: Record<ViewMode, string>;
  minimal: ModeLayouts;
  advanced: ModeLayouts;
}

export interface ThreadLayout {
  info: LayoutItem<ThreadInfoId>[];
  nav: LayoutItem<ThreadNavId>[];
}

export type ThreadMode = 'follow' | 'theme' | 'custom';

/** What the user saved. Everything optional: absent = the built-in / the default. */
export interface DashboardLayoutDoc {
  v: 1;
  presets?: Partial<Record<PresetId, Partial<Record<ViewMode, Partial<ModeLayouts>>>>>;
  active?: { card?: PresetId; detail?: PresetId };
  thread?: { mode: ThreadMode; custom?: ThreadLayout };
}

const it = <T extends string>(id: T, on: boolean, opt?: string): LayoutItem<T> =>
  opt === undefined ? { id, on } : { id, on, opt };

const DETAIL_ALL: Omit<DetailLayout, 'tasks' | 'tasksMax' | 'open'> = {
  top: [it('info', true), it('goal', true), it('needs', true), it('artifacts', true)],
  agents: 'all',
  agenthead: true,
  sections: true,
  controls: true,
  subtitle: true,
};
const DETAIL_LEAN = (agents: DetailAgents, controls: boolean): Omit<DetailLayout, 'tasks' | 'tasksMax' | 'open'> => ({
  top: [it('info', false), it('goal', false), it('needs', true), it('artifacts', false)],
  agents,
  agenthead: false,
  sections: false,
  controls,
  subtitle: false,
});
const ADV_OPEN_BY_COL: OpenLayout['byCol'] = {
  work: ['tasks', 'agents', 'io', 'goal', 'refs', 'model'],
  wait: ['io', 'arts', 'tasks', 'agents', 'goal', 'refs', 'model'],
  done: ['io', 'arts', 'agents', 'goal', 'refs', 'model'],
};
const ADV_OPEN_PARTS: LayoutItem<OpenPartId>[] = [
  it('io', true),
  it('arts', true),
  it('tasks', true),
  it('agents', true),
  it('goal', true),
  it('refs', true),
  it('model', true),
];
const ALL_ROWS = (summary: 'all' | 'asks'): LayoutItem<CardRowId>[] => [
  it('summary', true, summary),
  it('task', true),
  it('agents', true),
  it('usage', true),
  it('arts', true, '4'),
];

/** The built-in presets — .prd/20 §5, cell for cell. */
export const BUILTIN_PRESETS: Record<PresetId, PresetLayouts> = {
  '1': {
    name: { minimal: '결과 우선', advanced: '정리' },
    minimal: {
      card: {
        kind: true,
        star: true,
        owner: true,
        rows: [
          it('summary', true, 'asks'),
          it('task', true),
          it('arts', true, '3'),
          it('agents', false),
          it('usage', false),
        ],
        foot: [
          it('pr', true),
          it('cost', true),
          it('model', true),
          it('steps', false),
          it('ctx', false),
          it('media', false),
          it('arts', false),
          it('tokens', false),
        ],
      },
      open: {
        star: false,
        parts: [
          it('refs', true),
          it('model', true),
          it('tasks', false),
          it('agents', false),
          it('io', false),
          it('arts', false),
          it('goal', false),
        ],
      },
      detail: { ...DETAIL_LEAN('none', false), tasks: 'list', tasksMax: 34, open: false },
    },
    advanced: {
      card: {
        kind: true,
        star: true,
        owner: true,
        rows: ALL_ROWS('all'),
        foot: [
          it('steps', true),
          it('ctx', true),
          it('media', true),
          it('pr', true),
          it('model', true),
          it('arts', false),
          it('cost', false),
          it('tokens', false),
        ],
      },
      open: { star: false, parts: ADV_OPEN_PARTS, byCol: ADV_OPEN_BY_COL },
      detail: { ...DETAIL_ALL, tasks: 'runs', tasksMax: 34, open: true },
    },
  },
  '2': {
    name: { minimal: '진행 우선', advanced: '원본' },
    minimal: {
      card: {
        kind: true,
        star: true,
        owner: true,
        rows: [
          it('summary', true, 'all'),
          it('task', true),
          it('agents', false),
          it('usage', false),
          it('arts', false, '4'),
        ],
        foot: [
          it('steps', true),
          it('arts', true),
          it('cost', true),
          it('model', true),
          it('ctx', false),
          it('media', false),
          it('pr', false),
          it('tokens', false),
        ],
      },
      open: {
        star: false,
        parts: [
          it('tasks', true),
          it('agents', false),
          it('io', false),
          it('arts', false),
          it('goal', false),
          it('refs', false),
          it('model', false),
        ],
        byCol: { work: ['tasks'], wait: ['tasks'], done: [] },
      },
      detail: { ...DETAIL_LEAN('sub', true), tasks: 'list', tasksMax: 50, open: false },
    },
    advanced: {
      card: {
        kind: false,
        star: true,
        owner: true,
        rows: ALL_ROWS('all'),
        foot: [
          it('steps', true),
          it('ctx', true),
          it('media', true),
          it('pr', true),
          it('arts', false),
          it('cost', false),
          it('tokens', false),
          it('model', false),
        ],
      },
      open: { star: true, parts: ADV_OPEN_PARTS, byCol: ADV_OPEN_BY_COL },
      detail: { ...DETAIL_ALL, tasks: 'runs', tasksMax: 34, open: true },
    },
  },
  '3': {
    name: { minimal: '한눈에', advanced: '압축' },
    minimal: {
      card: {
        kind: true,
        star: true,
        owner: true,
        rows: [
          it('summary', true, 'asks'),
          it('task', false),
          it('agents', false),
          it('usage', false),
          it('arts', false, '3'),
        ],
        foot: [
          it('cost', true),
          it('model', true),
          it('steps', false),
          it('ctx', false),
          it('media', false),
          it('pr', false),
          it('arts', false),
          it('tokens', false),
        ],
      },
      open: {
        star: false,
        parts: [
          it('tasks', false),
          it('agents', false),
          it('io', false),
          it('arts', false),
          it('goal', false),
          it('refs', false),
          it('model', false),
        ],
      },
      detail: { ...DETAIL_LEAN('none', false), tasks: 'line', tasksMax: 34, open: false },
    },
    advanced: {
      card: {
        kind: true,
        star: true,
        owner: true,
        rows: [
          it('summary', true, 'asks'),
          it('task', true),
          it('agents', false),
          it('usage', false),
          it('arts', false, '4'),
        ],
        foot: [
          it('steps', true),
          it('ctx', true),
          it('arts', true),
          it('pr', true),
          it('cost', true),
          it('model', true),
          it('media', false),
          it('tokens', false),
        ],
      },
      open: {
        star: false,
        parts: [
          it('goal', true),
          it('refs', true),
          it('model', true),
          it('tasks', false),
          it('agents', false),
          it('io', false),
          it('arts', false),
        ],
      },
      detail: { ...DETAIL_ALL, tasks: 'runs', tasksMax: 34, open: false },
    },
  },
};

/** The thread card's own default lines (when the user unlinks it from the task card): today's Slack header. */
export const DEFAULT_THREAD_LAYOUT: ThreadLayout = {
  info: [
    it('owner', true),
    it('workflow', true),
    it('model', true),
    it('ctx', true),
    it('cost', false),
    it('tokens', false),
    it('task', false),
    it('steps', false),
  ],
  nav: [it('dashboardLink', true), it('linkhistory', true), it('links', false), it('status', true)],
};

export interface CatalogEntry {
  id: string;
  label: string;
  hint: string;
  /** Options of the item (`opt`), value → label. */
  opts?: Array<{ value: string; label: string }>;
  /** Shown always; the switch is off-limits. */
  locked?: boolean;
  /** Not shown in Slack (the thread card's mapping skips it). */
  slack?: false;
}

const SUMMARY_OPTS = [
  { value: 'asks', label: '물을 때만' },
  { value: 'all', label: '항상' },
];
const ARTS_OPTS = ['1', '2', '3', '4'].map((v) => ({ value: v, label: `${v}개` }));

/** Names and hints for the editor — every item a surface can show. */
export const LAYOUT_CATALOG = {
  card: {
    head: [
      { id: 'title', label: '제목', hint: '항상 보입니다', locked: true },
      { id: 'status', label: '상태와 시간', hint: '맨 아래 왼쪽 — 항상 보입니다', locked: true },
      { id: 'kind', label: '종류 아이콘', hint: '일반 작업 · 에픽 표시. 끄면 ✦' },
      { id: 'star', label: '별 (즐겨찾기)', hint: '누르면 즐겨찾기 토글', slack: false },
      { id: 'owner', label: '소유자', hint: '모든 사용자 화면에서 이름표' },
    ],
    rows: [
      { id: 'summary', label: '요약 줄', hint: '권한 요청 · 질문 · 오류 · 원래 제목', opts: SUMMARY_OPTS },
      { id: 'task', label: '현재 작업', hint: '#번호 · 이름 · 시간 (작업 중 · 대기)' },
      { id: 'agents', label: '서브에이전트', hint: '상태 점과 개수', slack: false },
      { id: 'usage', label: '토큰 · 비용 줄', hint: '작업 합계' },
      { id: 'arts', label: '산출물 줄', hint: '만든 파일 칩', opts: ARTS_OPTS, slack: false },
    ],
    foot: [
      { id: 'steps', label: '진행 n/m', hint: '완료한 작업 / 전체' },
      { id: 'ctx', label: '컨텍스트 %', hint: '60% 넘으면 노랑, 80% 넘으면 빨강' },
      { id: 'media', label: '지시 첨부 수', hint: '지시에 붙인 파일', slack: false },
      { id: 'pr', label: 'PR', hint: '번호와 상태' },
      { id: 'arts', label: '산출물 수', hint: '만든 파일 개수', slack: false },
      { id: 'cost', label: '비용', hint: 'API 환산 비용' },
      { id: 'tokens', label: '토큰', hint: '총 토큰' },
      { id: 'model', label: '모델', hint: '회사 아이콘과 이름' },
    ],
  },
  open: {
    fixed: [
      { id: 'needs', label: '액션 · 입력 필요', hint: '중지 · 닫기 · Slack · 승인 · 질문 — 항상 맨 위', locked: true },
    ],
    parts: [
      { id: 'tasks', label: '작업 창', hint: '현재 목록 5줄' },
      { id: 'agents', label: '에이전트 트리', hint: '서브에이전트 실행' },
      { id: 'io', label: '최근 지시와 답변', hint: '마지막 주고받은 말' },
      { id: 'arts', label: '산출물', hint: '만든 파일' },
      { id: 'goal', label: '목표 줄', hint: 'goal · 상태 · 대기' },
      { id: 'refs', label: '이슈 · PR 링크', hint: '짧은 참조 링크' },
      { id: 'model', label: '모델 · 추론 강도', hint: '바로 바꾸기' },
    ],
    star: { id: 'star', label: '☆ 즐겨찾기 버튼', hint: '면의 별과 같은 일 — 보통은 끔' },
  },
  detail: {
    fixed: [
      { id: 'head', label: '머리 · 상태 바', hint: '제목 · 상태 · Slack · 별 · 중지 — 항상', locked: true },
      { id: 'chat', label: '채팅', hint: '지시와 답변 — 항상', locked: true },
      { id: 'composer', label: '입력창', hint: '항상', locked: true },
    ],
    top: [
      { id: 'info', label: '세션 정보', hint: '소유자 · 토큰 · 비용 · 링크' },
      { id: 'goal', label: '목표', hint: '편집 · 대기열' },
      { id: 'needs', label: '입력 필요', hint: '승인 · 질문 — 항상', locked: true },
      { id: 'artifacts', label: '산출물', hint: '만든 파일 · 지시 첨부' },
    ],
    tasks: [
      { value: 'runs', label: '실행 표 (전부)' },
      { value: 'list', label: '체크리스트' },
      { value: 'line', label: '한 줄 (누르면 펼침)' },
      { value: 'none', label: '숨김' },
    ],
    agents: [
      { value: 'all', label: '항상' },
      { value: 'sub', label: '서브에이전트 있을 때' },
      { value: 'none', label: '숨김' },
    ],
    toggles: [
      { id: 'subtitle', label: '부제', hint: '제목 아래 한 줄' },
      { id: 'agenthead', label: '에이전트 머리 · 경로', hint: '보고 있는 에이전트' },
      { id: 'sections', label: '작업 로그 · 트리 탭', hint: '채팅 옆 탭' },
      { id: 'controls', label: '모델 · 추론 강도', hint: '입력창 위' },
      { id: 'open', label: '처음부터 펼침', hint: '세션 정보 · 작업 · 이전 계획을 펼쳐서 열기' },
    ],
  },
  thread: {
    fixed: [{ id: 'title', label: '제목', hint: '머리 줄 — 항상', locked: true }],
    info: [
      { id: 'owner', label: '소유자', hint: '@멘션' },
      { id: 'workflow', label: '워크플로', hint: '`zwork` 같은 이름' },
      { id: 'model', label: '모델', hint: '모델 이름' },
      { id: 'ctx', label: '컨텍스트', hint: '▓▓░ 막대' },
      { id: 'cost', label: '비용', hint: '$6.20' },
      { id: 'tokens', label: '토큰', hint: '6.4M 토큰' },
      { id: 'task', label: '현재 작업', hint: '▶ 진행 중인 작업' },
      { id: 'steps', label: '진행 n/m', hint: '작업 2/4' },
    ],
    nav: [
      { id: 'dashboardLink', label: '대시보드 링크', hint: '📋 작업 로그' },
      { id: 'linkhistory', label: '링크 기록', hint: '이슈 · PR과 상태' },
      { id: 'links', label: '현재 링크', hint: '지금 이슈 · PR만' },
      { id: 'status', label: '종료 표시', hint: '⚫ 종료됨' },
    ],
  },
} as const;

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPreset = (v: unknown): v is PresetId => v === '1' || v === '2' || v === '3';

/** Every catalog id once: the given order for the known ones, then the missing ones off. */
function items<T extends string>(
  input: unknown,
  catalog: readonly T[],
  fallback: LayoutItem<T>[],
  opt?: Partial<Record<T, (v: unknown) => string | undefined>>,
): LayoutItem<T>[] {
  if (!Array.isArray(input)) return fallback.map((x) => ({ ...x }));
  const out: LayoutItem<T>[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !catalog.includes(raw.id as T) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const id = raw.id as T;
    const fb = fallback.find((f) => f.id === id);
    const o = opt?.[id] ? (opt[id]!(raw.opt) ?? fb?.opt) : undefined;
    out.push(o === undefined ? { id, on: raw.on === true } : { id, on: raw.on === true, opt: o });
  }
  for (const id of catalog) {
    if (seen.has(id)) continue;
    const fb = fallback.find((f) => f.id === id);
    out.push(fb?.opt === undefined ? { id, on: false } : { id, on: false, opt: fb.opt });
  }
  return out;
}

const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb);
const oneOf = <T extends string>(v: unknown, all: readonly T[], fb: T): T => (all.includes(v as T) ? (v as T) : fb);
const summaryOpt = (v: unknown) => (v === 'all' || v === 'asks' ? v : undefined);
const artsOpt = (v: unknown) => (v === '1' || v === '2' || v === '3' || v === '4' ? v : undefined);

export function normalizeFace(input: unknown, fb: FaceLayout): FaceLayout {
  const o = isObj(input) ? input : {};
  return {
    kind: bool(o.kind, fb.kind),
    star: bool(o.star, fb.star),
    owner: bool(o.owner, fb.owner),
    rows: items(o.rows, CARD_ROWS, fb.rows, { summary: summaryOpt, arts: artsOpt }),
    foot: items(o.foot, CARD_CHIPS, fb.foot),
  };
}

export function normalizeOpen(input: unknown, fb: OpenLayout): OpenLayout {
  if (!isObj(input)) return { ...fb, parts: fb.parts.map((x) => ({ ...x })) };
  // An edited list is one order for every column: the built-in's per-column order goes with the edit.
  return { star: bool(input.star, fb.star), parts: items(input.parts, OPEN_PARTS, fb.parts) };
}

export function normalizeDetail(input: unknown, fb: DetailLayout): DetailLayout {
  const o = isObj(input) ? input : {};
  const top = items(o.top, DETAIL_TOP, fb.top).map((x) => (x.id === 'needs' ? { ...x, on: true } : x));
  const max = typeof o.tasksMax === 'number' && Number.isFinite(o.tasksMax) ? Math.round(o.tasksMax) : fb.tasksMax;
  return {
    top,
    tasks: oneOf(o.tasks, ['runs', 'list', 'line', 'none'] as const, fb.tasks),
    tasksMax: Math.min(70, Math.max(20, max)),
    agents: oneOf(o.agents, ['all', 'sub', 'none'] as const, fb.agents),
    agenthead: bool(o.agenthead, fb.agenthead),
    sections: bool(o.sections, fb.sections),
    controls: bool(o.controls, fb.controls),
    subtitle: bool(o.subtitle, fb.subtitle),
    open: bool(o.open, fb.open),
  };
}

export function normalizeThread(input: unknown): ThreadLayout {
  const o = isObj(input) ? input : {};
  return {
    info: items(o.info, THREAD_INFO, DEFAULT_THREAD_LAYOUT.info),
    nav: items(o.nav, THREAD_NAV, DEFAULT_THREAD_LAYOUT.nav),
  };
}

/**
 * What the store keeps: a saved document, checked. Wrong shapes at the top are refused (`LayoutError`, a 400);
 * inside a layout, unknown ids drop and missing ones are appended off; numbers are clamped. Only surfaces the
 * user edited are kept — the rest stay the built-in, so a later built-in change reaches them.
 */
export function normalizeLayoutDoc(input: unknown): DashboardLayoutDoc {
  if (input === undefined || input === null) return { v: 1 };
  if (!isObj(input)) throw new LayoutError('레이아웃은 객체여야 합니다');
  if (input.v !== undefined && input.v !== 1) throw new LayoutError('레이아웃 버전은 1이어야 합니다');
  const out: DashboardLayoutDoc = { v: 1 };
  if (input.presets !== undefined) {
    if (!isObj(input.presets)) throw new LayoutError('presets는 객체여야 합니다');
    const presets: NonNullable<DashboardLayoutDoc['presets']> = {};
    for (const [pid, preset] of Object.entries(input.presets)) {
      if (!isPreset(pid)) throw new LayoutError(`프리셋은 1, 2, 3 중 하나여야 합니다: ${pid}`);
      if (!isObj(preset)) throw new LayoutError(`프리셋 ${pid}는 객체여야 합니다`);
      const keep: Partial<Record<ViewMode, Partial<ModeLayouts>>> = {};
      for (const [mode, layouts] of Object.entries(preset)) {
        if (mode !== 'minimal' && mode !== 'advanced') throw new LayoutError(`모드는 minimal 또는 advanced: ${mode}`);
        if (!isObj(layouts)) throw new LayoutError(`프리셋 ${pid} ${mode}는 객체여야 합니다`);
        const fb = BUILTIN_PRESETS[pid][mode];
        const m: Partial<ModeLayouts> = {};
        if (layouts.card !== undefined) m.card = normalizeFace(layouts.card, fb.card);
        if (layouts.open !== undefined) m.open = normalizeOpen(layouts.open, fb.open);
        if (layouts.detail !== undefined) m.detail = normalizeDetail(layouts.detail, fb.detail);
        if (Object.keys(m).length) keep[mode] = m;
      }
      if (Object.keys(keep).length) presets[pid] = keep;
    }
    if (Object.keys(presets).length) out.presets = presets;
  }
  if (input.active !== undefined) {
    if (!isObj(input.active)) throw new LayoutError('active는 객체여야 합니다');
    const active: NonNullable<DashboardLayoutDoc['active']> = {};
    for (const k of ['card', 'detail'] as const) {
      const v = input.active[k];
      if (v === undefined || v === null) continue;
      if (!isPreset(v)) throw new LayoutError(`기본 안은 1, 2, 3 중 하나여야 합니다 (${k})`);
      active[k] = v;
    }
    if (Object.keys(active).length) out.active = active;
  }
  if (input.thread !== undefined) {
    if (!isObj(input.thread)) throw new LayoutError('thread는 객체여야 합니다');
    const mode = input.thread.mode;
    if (mode !== 'follow' && mode !== 'theme' && mode !== 'custom')
      throw new LayoutError('스레드 카드는 follow, theme, custom 중 하나여야 합니다');
    out.thread =
      mode === 'custom' || input.thread.custom !== undefined
        ? { mode, custom: normalizeThread(input.thread.custom) }
        : { mode };
  }
  return out;
}

/** The preset a surface uses: the user's default for it, else the quick switch, else 1. */
export function activePreset(doc: DashboardLayoutDoc | undefined, surface: 'card' | 'detail', plan?: string): PresetId {
  const a = doc?.active?.[surface];
  if (isPreset(a)) return a;
  return isPreset(plan) ? plan : '1';
}

/** One surface of one preset in one mode: the user's edit, else the built-in. */
export function presetLayout<K extends keyof ModeLayouts>(
  doc: DashboardLayoutDoc | undefined,
  preset: PresetId,
  mode: ViewMode,
  surface: K,
): ModeLayouts[K] {
  const saved = doc?.presets?.[preset]?.[mode]?.[surface];
  return (saved ?? BUILTIN_PRESETS[preset][mode][surface]) as ModeLayouts[K];
}

/** What the user's dashboard draws in a mode: the task card from its preset, the detail card from its own. */
export function resolveLayouts(doc: DashboardLayoutDoc | undefined, mode: ViewMode, plan?: string): ModeLayouts {
  const card = activePreset(doc, 'card', plan);
  const detail = activePreset(doc, 'detail', plan);
  return {
    card: presetLayout(doc, card, mode, 'card'),
    open: presetLayout(doc, card, mode, 'open'),
    detail: presetLayout(doc, detail, mode, 'detail'),
  };
}

type SlackField = SurfaceLineConfig['fields'][number];
const SLACK_INFO: Record<ThreadInfoId, SlackField> = {
  owner: { field: 'owner', show: true, format: 'mention' },
  workflow: { field: 'workflow', show: true, style: { code: true } },
  model: { field: 'model', show: true, style: { code: true } },
  ctx: { field: 'contextwindow', show: true, bar: { width: 5, filledChar: '▓', emptyChar: '░' } },
  cost: { field: 'cost', show: true },
  tokens: { field: 'tokens', show: true },
  task: { field: 'task', show: true },
  steps: { field: 'steps', show: true },
};
const SLACK_NAV: Record<ThreadNavId, SlackField> = {
  dashboardLink: { field: 'dashboardLink', show: true },
  linkhistory: { field: 'linkhistory', show: true, max: 5 },
  links: { field: 'links', show: true },
  status: { field: 'status', show: true, format: 'closed-marker' },
};

/**
 * The thread card a task card makes ("태스크 카드 따라감"): the title, then what the face shows that Slack can
 * show, in the face's order — the owner, the current task, tokens · cost, the steps, the context, the model —
 * then the way back (the dashboard link, the links when the face shows the PR), then 종료됨.
 */
export function followThreadLayout(face: FaceLayout): ThreadLayout {
  const info: ThreadInfoId[] = [];
  const add = (id: ThreadInfoId) => {
    if (!info.includes(id)) info.push(id);
  };
  if (face.owner) add('owner');
  for (const r of face.rows) {
    if (!r.on) continue;
    if (r.id === 'task') add('task');
    if (r.id === 'usage') {
      add('tokens');
      add('cost');
    }
  }
  let pr = false;
  for (const c of face.foot) {
    if (!c.on) continue;
    if (c.id === 'steps') add('steps');
    else if (c.id === 'ctx') add('ctx');
    else if (c.id === 'cost') add('cost');
    else if (c.id === 'tokens') add('tokens');
    else if (c.id === 'model') add('model');
    else if (c.id === 'pr') pr = true;
  }
  return {
    info: items(
      info.map((id) => ({ id, on: true })),
      THREAD_INFO,
      DEFAULT_THREAD_LAYOUT.info,
    ),
    nav: [it('dashboardLink', true), it('linkhistory', pr), it('links', false), it('status', true)],
  };
}

/** A thread layout as Slack lines: the title as the header, the info as one context line, the links, 종료됨. */
export function threadLines(layout: ThreadLayout): SurfaceLineConfig[] {
  const on = <T extends string>(xs: LayoutItem<T>[], map: Record<T, SlackField>) =>
    xs.filter((x) => x.on).map((x) => ({ ...map[x.id] }));
  const nav = layout.nav.filter((x) => x.on && x.id !== 'status');
  const lines: SurfaceLineConfig[] = [{ block: 'header', fields: [{ field: 'title', show: true, truncate: 150 }] }];
  const info = on(layout.info, SLACK_INFO);
  if (info.length) lines.push({ block: 'context', fields: info });
  if (nav.length) lines.push({ block: 'context', fields: on(nav, SLACK_NAV) });
  if (layout.nav.some((x) => x.id === 'status' && x.on))
    lines.push({ block: 'context', fields: [{ ...SLACK_NAV.status }] });
  return lines;
}

/**
 * The user's thread card as Slack lines, or undefined for the server's Slack theme (`config.json`
 * `ui.threadheader`). The default follows the task card the user's dashboard draws in their mode.
 */
export function threadCardLines(
  doc: DashboardLayoutDoc | undefined,
  mode: ViewMode,
  plan?: string,
): SurfaceLineConfig[] | undefined {
  const t = doc?.thread?.mode ?? 'follow';
  if (t === 'theme') return undefined;
  if (t === 'custom') return threadLines(doc?.thread?.custom ?? DEFAULT_THREAD_LAYOUT);
  return threadLines(followThreadLayout(resolveLayouts(doc, mode, plan).card));
}
