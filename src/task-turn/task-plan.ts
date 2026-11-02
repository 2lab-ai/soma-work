/**
 * Plan mode (SSOT 2026-11-02 — 작업 계획 모드) — a dashboard task made with the
 * plan toggle on is gated before it works.
 *
 *   drafting ──plan_submit──▶ awaiting ──시작──▶ approved   (the work starts)
 *      ▲                        │  └──취소──▶ cancelled
 *      └──── direct input ──────┘              │
 *      └──────────── a new instruction ────────┘
 *
 * - The model writes the plan with the `plan` host tool (`plan_submit`,
 *   plan-server.ts): a structured plan in four levels — the conclusion and
 *   intent, the phases (the high-level concept), each phase's steps, each
 *   step's detail. The server draws it (task-plan-html.ts); the model writes
 *   no markup.
 * - Until the owner starts it, every turn of the task carries the plan-mode
 *   notice (`planGateTurn`): plan with SSOT + intent-first, do no work,
 *   submit, end the turn. Any instruction while a plan waits is direct input:
 *   the model revises and submits the next revision.
 * - 시작 approves exactly the revision the owner saw (`decidePlan`) and the
 *   host starts the work with the plan in its instruction (`planApprovedText`).
 *
 * Pure functions over plain records; the registry saves what they return.
 */

export type TaskPlanState = 'drafting' | 'awaiting' | 'approved' | 'cancelled';
const STATES: readonly TaskPlanState[] = ['drafting', 'awaiting', 'approved', 'cancelled'];

/** Level 3 — one step of a phase, with its detail. */
export interface TaskPlanStep {
  title: string;
  detail?: string;
  /** What the step leaves behind (a file, a PR, a report). */
  deliverable?: string;
  /** The SSOT / intent ids it serves (`T2`, `I1.3`). */
  refs?: string[];
}

/** Level 1–2 — a phase (the high-level concept) and its steps. */
export interface TaskPlanPhase {
  title: string;
  goal?: string;
  steps: TaskPlanStep[];
}

export interface TaskPlanIntent {
  id: string;
  text: string;
  /** Where it comes from: an SSOT span, or `추론` (inferred). */
  source?: string;
}

/** A submitted plan (level 0 = `summary` + `intent`). `revision` and `submittedAt` are the host's. */
export interface TaskPlanDoc {
  revision: number;
  submittedAt: number;
  summary: string;
  intent: string;
  /** The instruction quoted as given (using-ssot: no paraphrase). */
  ssot?: string[];
  intents?: TaskPlanIntent[];
  phases: TaskPlanPhase[];
  assumptions?: string[];
  risks?: string[];
  outOfScope?: string[];
  /** What the owner should settle — answered with direct input. */
  questions?: string[];
}

/** What a submission carries: a plan without the host's stamps. */
export type PlanSubmission = Omit<TaskPlanDoc, 'revision' | 'submittedAt'>;

export interface TaskPlanGate {
  state: TaskPlanState;
  /** The revision of the last submitted plan; 0 = none yet. */
  revision: number;
  updatedAt: number;
  plan?: TaskPlanDoc;
  /** Who started or cancelled it, and when. */
  decidedAt?: number;
  decidedBy?: string;
}

export const TASK_PLAN_LIMITS = Object.freeze({
  summary: 300,
  intent: 1500,
  title: 160,
  text: 2000,
  phases: 10,
  steps: 15,
  list: 12,
  ssot: 10,
  intents: 10,
  refs: 8,
  ref: 24,
  id: 24,
});

export type TaskPlanErrorCode =
  | 'bad-input'
  | 'bad-summary'
  | 'bad-intent'
  | 'bad-title'
  | 'no-phases'
  | 'no-steps'
  | 'too-many'
  | 'too-long'
  | 'already-decided';

/** A refused submission: nothing was changed. */
export class TaskPlanError extends Error {
  constructor(
    readonly code: TaskPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskPlanError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A required text, trimmed, within `max` — else the code. */
function needText(v: unknown, max: number, code: TaskPlanErrorCode, what: string): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > max) throw new TaskPlanError(code, `${what} is required, at most ${max} characters`);
  return t;
}

/** An optional text: absent or blank → undefined; over `max` → too-long. */
function optText(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new TaskPlanError('bad-input', `${what} must be text`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new TaskPlanError('too-long', `${what} is at most ${max} characters`);
  return t;
}

/** An optional list of texts: at most `count`, each within `max`; blanks dropped; empty → undefined. */
function optList(v: unknown, count: number, max: number, what: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new TaskPlanError('bad-input', `${what} must be a list`);
  if (v.length > count) throw new TaskPlanError('too-many', `${what}: at most ${count}`);
  const out = v.map((x, i) => optText(x, max, `${what}[${i + 1}]`)).filter((x): x is string => !!x);
  return out.length ? out : undefined;
}

/**
 * The tool's input, checked strictly: a refusal names its code and changes
 * nothing. Texts are trimmed; optional parts that are empty are left out.
 */
export function checkPlanSubmission(input: unknown): PlanSubmission {
  if (!isObject(input)) throw new TaskPlanError('bad-input', 'the plan must be an object');
  const L = TASK_PLAN_LIMITS;
  const summary = needText(input.summary, L.summary, 'bad-summary', 'summary (the one-line conclusion)');
  const intent = needText(input.intent, L.intent, 'bad-intent', 'intent');
  if (!Array.isArray(input.phases) || input.phases.length === 0) {
    throw new TaskPlanError('no-phases', 'a plan has at least one phase');
  }
  if (input.phases.length > L.phases) throw new TaskPlanError('too-many', `at most ${L.phases} phases`);
  const phases: TaskPlanPhase[] = input.phases.map((raw, p) => {
    if (!isObject(raw)) throw new TaskPlanError('bad-input', `phase ${p + 1} must be an object`);
    const title = needText(raw.title, L.title, 'bad-title', `phase ${p + 1} title`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      throw new TaskPlanError('no-steps', `phase ${p + 1} has at least one step`);
    }
    if (raw.steps.length > L.steps) throw new TaskPlanError('too-many', `phase ${p + 1}: at most ${L.steps} steps`);
    const steps: TaskPlanStep[] = raw.steps.map((s, i) => {
      if (!isObject(s)) throw new TaskPlanError('bad-input', `phase ${p + 1} step ${i + 1} must be an object`);
      const where = `phase ${p + 1} step ${i + 1}`;
      const step: TaskPlanStep = { title: needText(s.title, L.title, 'bad-title', `${where} title`) };
      const detail = optText(s.detail, L.text, `${where} detail`);
      const deliverable = optText(s.deliverable, L.text, `${where} deliverable`);
      const refs = optList(s.refs, L.refs, L.ref, `${where} refs`);
      if (detail) step.detail = detail;
      if (deliverable) step.deliverable = deliverable;
      if (refs) step.refs = refs;
      return step;
    });
    const phase: TaskPlanPhase = { title, steps };
    const goal = optText(raw.goal, L.text, `phase ${p + 1} goal`);
    if (goal) phase.goal = goal;
    return phase;
  });
  const plan: PlanSubmission = { summary, intent, phases };
  const ssot = optList(input.ssot, L.ssot, L.text, 'ssot');
  if (ssot) plan.ssot = ssot;
  if (input.intents !== undefined && input.intents !== null) {
    if (!Array.isArray(input.intents)) throw new TaskPlanError('bad-input', 'intents must be a list');
    if (input.intents.length > L.intents) throw new TaskPlanError('too-many', `at most ${L.intents} intents`);
    const intents = input.intents.map((raw, i) => {
      if (!isObject(raw)) throw new TaskPlanError('bad-input', `intent ${i + 1} must be an object`);
      const item: TaskPlanIntent = {
        id: needText(raw.id, L.id, 'bad-input', `intent ${i + 1} id`),
        text: needText(raw.text, L.text, 'too-long', `intent ${i + 1} text`),
      };
      const source = optText(raw.source, L.title, `intent ${i + 1} source`);
      if (source) item.source = source;
      return item;
    });
    if (intents.length) plan.intents = intents;
  }
  for (const key of ['assumptions', 'risks', 'outOfScope', 'questions'] as const) {
    const list = optList(input[key], L.list, L.text, key);
    if (list) plan[key] = list;
  }
  return plan;
}

/** A plan gate for a task made with the toggle on: no plan yet. */
export function newPlanGate(now: number): TaskPlanGate {
  return { state: 'drafting', revision: 0, updatedAt: now };
}

/** Not started yet: the task's turns carry the plan-mode notice and the `plan` tool. */
export function isPlanPending(gate: TaskPlanGate | undefined): gate is TaskPlanGate {
  return !!gate && gate.state !== 'approved';
}

/**
 * A checked submission stamped with the next revision: the plan waits for the
 * owner. A plan already started or cancelled takes none — a cancelled task
 * plans again only from a new instruction (`planGateTurn`).
 */
export function applyPlanSubmission(gate: TaskPlanGate, input: PlanSubmission, now: number): TaskPlanGate {
  if (gate.state === 'approved' || gate.state === 'cancelled') {
    throw new TaskPlanError(
      'already-decided',
      gate.state === 'approved'
        ? 'this plan was already started — do the work now'
        : 'this plan was cancelled — wait for a new instruction',
    );
  }
  const revision = gate.revision + 1;
  return {
    state: 'awaiting',
    revision,
    updatedAt: now,
    plan: { ...input, revision, submittedAt: now },
  };
}

export type PlanDecision = 'start' | 'cancel';
export type PlanDecisionResult = { ok: true; gate: TaskPlanGate } | { ok: false; status: 409; error: string };

/**
 * 시작 — only a waiting plan, and only the revision the owner saw (a newer one
 * came meanwhile: 409, look again). 취소 — a waiting plan, or one still being
 * written. Started or cancelled: nothing more to decide.
 */
export function decidePlan(
  gate: TaskPlanGate,
  decision: PlanDecision,
  revision: number,
  by: string,
  now: number,
): PlanDecisionResult {
  if (gate.state === 'approved' || gate.state === 'cancelled') {
    return {
      ok: false,
      status: 409,
      error: `the plan was already ${gate.state === 'approved' ? 'started' : 'cancelled'}`,
    };
  }
  if (decision === 'start') {
    if (gate.state !== 'awaiting' || !gate.plan)
      return { ok: false, status: 409, error: 'no plan is waiting to start' };
    if (revision !== gate.revision) {
      return { ok: false, status: 409, error: `the plan changed (now v${gate.revision}) — look at it again` };
    }
  } else if (gate.state === 'awaiting' && revision !== gate.revision) {
    return { ok: false, status: 409, error: `the plan changed (now v${gate.revision}) — look at it again` };
  }
  return {
    ok: true,
    gate: {
      ...gate,
      state: decision === 'start' ? 'approved' : 'cancelled',
      decidedAt: now,
      decidedBy: by,
      updatedAt: now,
    },
  };
}

/** The tool the notice names (`plan` server, `plan_submit`). */
export const PLAN_SUBMIT_TOOL = 'mcp__plan__plan_submit';

const PLAN_RULES = [
  '- 지금은 계획만 세운다. 작업을 시작하지 않는다: 파일 수정·커밋·PR·배포·메시지 발송·외부 시스템 변경 금지. 읽기·검색·조사는 해도 된다.',
  '- Skill 도구로 `zworkflow:using-ssot`와 `zworkflow:using-intentfirst`를 먼저 불러 그 규율로 계획한다: 지시 원문을 SSOT로 고정(paraphrase 금지) → SSOT-TASK-TREE → INTENT-LIST → INTENT-TASK-TREE → 두 트리의 차이와 가정.',
  '- using-intentfirst의 "기다리지 않고 선진행" 규칙은 이 작업에서 쓰지 않는다. 계획 모드에서는 계획을 제출하고 멈춘다 — 유저가 대시보드에서 시작해야 일한다.',
  `- 계획은 \`${PLAN_SUBMIT_TOOL}\` 하나로 제출한다. 하이레벨에서 디테일로: summary(한 줄 결론) · intent(의도) · ssot(원문 인용) · intents → phases(큰 단계) → steps(단계별 작업) → detail · deliverable · refs(T<n>/I<n> 매핑). 가정·위험·범위 밖·확인할 것(questions)도 담는다.`,
  '- 제출하면 결과를 한두 줄로 말하고 턴을 끝낸다. 유저가 시작 · 취소 · 직접 입력 중 하나를 고른다. 질문이 있으면 questions에 넣는다 — 따로 묻고 기다리지 않는다.',
];

/**
 * The notice a turn of a task whose plan is not started carries (prepended to
 * the model's prompt, never recorded as the user's words), and the gate after
 * the turn's start: a waiting plan given direct input, or a cancelled one
 * given a new instruction, goes back to drafting. No gate, or a started plan:
 * no notice.
 */
export function planGateTurn(
  gate: TaskPlanGate | undefined,
  now: number,
): { notice: string | undefined; gate: TaskPlanGate | undefined } {
  if (!isPlanPending(gate)) return { notice: undefined, gate };
  const fresh = gate.state === 'cancelled' || gate.revision === 0;
  const lead = fresh
    ? gate.state === 'cancelled'
      ? `이전 계획(v${gate.revision})은 취소되었다. 이 지시로 새 계획을 세운다.`
      : '이 작업은 작업 계획 모드로 만들어졌다. 아래 지시를 실행하기 전에 전체 작업 계획을 세워 유저의 승인을 받는다.'
    : `유저가 계획 v${gate.revision}에 대해 직접 입력했다(아래 지시). 그 입력을 반영해 계획을 고쳐 다음 버전으로 다시 제출한다. 아직 작업을 시작하지 않는다.`;
  const notice = [
    `<task-plan-mode state="${gate.state}" revision="${gate.revision}">`,
    lead,
    ...PLAN_RULES,
    '</task-plan-mode>',
  ].join('\n');
  const next = gate.state === 'drafting' ? gate : { ...gate, state: 'drafting' as const, updatedAt: now };
  return { notice, gate: next };
}

/** The approval instruction's bound — the dashboard route's own (`NEW_TASK_LIMITS.maxPromptChars`). */
export const PLAN_APPROVED_TEXT_MAX = 12_000;

/** The plan as plain text, conclusion first — what the approval instruction carries. */
export function planMarkdown(plan: TaskPlanDoc): string {
  const lines = [`# 작업 계획 v${plan.revision}`, '', `결론: ${plan.summary}`, `의도: ${plan.intent}`];
  if (plan.ssot?.length) lines.push('', '지시 원문:', ...plan.ssot.map((s) => `> ${s.replace(/\n/g, '\n> ')}`));
  if (plan.intents?.length) lines.push('', '의도 목록:', ...plan.intents.map((i) => `- ${i.id} ${i.text}`));
  plan.phases.forEach((phase, p) => {
    lines.push('', `## ${p + 1}. ${phase.title}`);
    if (phase.goal) lines.push(phase.goal);
    phase.steps.forEach((step, s) => {
      const refs = step.refs?.length ? ` ← ${step.refs.join(', ')}` : '';
      lines.push(`- ${p + 1}.${s + 1} ${step.title}${refs}`);
      if (step.detail) lines.push(`  ${step.detail.replace(/\n/g, '\n  ')}`);
      if (step.deliverable) lines.push(`  산출물: ${step.deliverable}`);
    });
  });
  const tail: Array<[string, string[] | undefined]> = [
    ['가정', plan.assumptions],
    ['위험', plan.risks],
    ['범위 밖', plan.outOfScope],
    ['확인할 것', plan.questions],
  ];
  for (const [label, list] of tail) if (list?.length) lines.push('', `${label}:`, ...list.map((x) => `- ${x}`));
  return lines.join('\n');
}

/**
 * What 시작 sends as the task's next instruction: the plan was started (by
 * whom, which revision) — do the work now, by this plan. The plan rides along
 * (a compaction or a restart since the submission must not lose it), cut to
 * the instruction bound.
 */
export function planApprovedText(plan: TaskPlanDoc, by: string): string {
  const head = [
    `[작업 계획 승인 — v${plan.revision}] <@${by}> 님이 대시보드에서 아래 계획을 시작했습니다.`,
    '이제 이 계획대로 작업을 진행하세요. 계획을 벗어나야 하면 이유를 남기고 진행합니다.',
    '',
  ].join('\n');
  const body = planMarkdown(plan);
  const cut = '\n… (계획이 길어 여기서 잘림 — 전체는 대시보드의 작업 계획)';
  const room = PLAN_APPROVED_TEXT_MAX - head.length;
  return head + (body.length <= room ? body : `${body.slice(0, room - cut.length)}${cut}`);
}

// ── Load ──

function cleanList(v: unknown, count: number, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .slice(0, count)
    .map((x) => x.trim().slice(0, max));
  return out.length ? out : undefined;
}

/** A saved plan, or undefined when it is not one (the same bounds as a submission, applied leniently). */
function sanitizePlanDoc(value: unknown): TaskPlanDoc | undefined {
  if (!isObject(value)) return undefined;
  if (!Number.isInteger(value.revision) || (value.revision as number) < 1) return undefined;
  if (typeof value.submittedAt !== 'number' || !Number.isFinite(value.submittedAt)) return undefined;
  try {
    const checked = checkPlanSubmission(value);
    return { ...checked, revision: value.revision as number, submittedAt: value.submittedAt };
  } catch {
    // A saved plan that no longer passes (a bound tightened): keep what reads, drop the rest.
    const L = TASK_PLAN_LIMITS;
    const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, L.summary) : '';
    const phases = Array.isArray(value.phases)
      ? value.phases.flatMap((raw): TaskPlanPhase[] => {
          if (!isObject(raw) || typeof raw.title !== 'string' || !raw.title.trim()) return [];
          const steps = Array.isArray(raw.steps)
            ? raw.steps.flatMap((s): TaskPlanStep[] =>
                isObject(s) && typeof s.title === 'string' && s.title.trim()
                  ? [{ title: s.title.trim().slice(0, L.title) }]
                  : [],
              )
            : [];
          return steps.length ? [{ title: raw.title.trim().slice(0, L.title), steps: steps.slice(0, L.steps) }] : [];
        })
      : [];
    if (!summary || !phases.length) return undefined;
    const intent = typeof value.intent === 'string' ? value.intent.trim().slice(0, L.intent) : '';
    const doc: TaskPlanDoc = {
      revision: value.revision as number,
      submittedAt: value.submittedAt,
      summary,
      intent: intent || summary,
      phases: phases.slice(0, L.phases),
    };
    for (const key of ['ssot', 'assumptions', 'risks', 'outOfScope', 'questions'] as const) {
      const list = cleanList(value[key], key === 'ssot' ? L.ssot : L.list, L.text);
      if (list) doc[key] = list;
    }
    return doc;
  }
}

/**
 * A saved gate (sessions.json), or undefined when it is not one. A gate that
 * waits on a plan it no longer has goes back to drafting; the revision count
 * is kept, so a new plan never reuses a number the owner saw.
 */
export function sanitizeTaskPlanGate(value: unknown): TaskPlanGate | undefined {
  if (!isObject(value)) return undefined;
  if (!STATES.includes(value.state as TaskPlanState)) return undefined;
  const revision = Number.isInteger(value.revision) && (value.revision as number) >= 0 ? (value.revision as number) : 0;
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  const plan = sanitizePlanDoc(value.plan);
  let state = value.state as TaskPlanState;
  if ((state === 'awaiting' || state === 'approved') && !plan) state = 'drafting';
  const gate: TaskPlanGate = { state, revision: Math.max(revision, plan?.revision ?? 0), updatedAt };
  if (plan) gate.plan = plan;
  if (typeof value.decidedAt === 'number' && Number.isFinite(value.decidedAt)) gate.decidedAt = value.decidedAt;
  if (typeof value.decidedBy === 'string' && value.decidedBy) gate.decidedBy = value.decidedBy.slice(0, 64);
  return gate;
}
