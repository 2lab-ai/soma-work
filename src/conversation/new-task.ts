/**
 * Dashboard "New task" — the pure half (SSOT 2026-10-23).
 *
 * The dashboard composer starts a brand-new task in a Slack channel the user
 * picks, so the work is visible there. This module owns everything that does
 * not touch Slack or the process: what the composer offers a user
 * (`buildNewTaskContext`), how a submission is validated against that offer
 * (`parseNewTaskSubmission`), how the autoz toggle reaches the session
 * (`composeTaskText` — `$autoz` at the end, the same as typing it), the quota
 * battery (`computeModelBattery`), the root message posted into the channel
 * (`buildNewTaskRootMessage`) and the idempotency / per-user limit gate
 * (`createNewTaskGate`). The Slack side is `new-task-launcher.ts`; the
 * production wiring lives in `src/index.ts`.
 */

/** Upload / text limits. The client enforces them before sending; the server again after decoding. */
export const NEW_TASK_LIMITS = Object.freeze({
  maxPromptChars: 12_000,
  maxFiles: 10,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 30 * 1024 * 1024,
});

/** Route body limit: the attachments as base64 (4/3) plus room for the JSON around them. */
export const NEW_TASK_BODY_LIMIT = Math.ceil((NEW_TASK_LIMITS.maxTotalBytes * 4) / 3) + 1024 * 1024;

// ── Quota battery ────────────────────────────────────────────────────

/** One usage window of one account, normalised: `remaining` is 0..1, `resetsAt` epoch seconds. */
export interface UsageWindowView {
  /** `5h`, `7d`, or a model-scoped weekly window `7d-<scope>` (e.g. `7d-opus`). */
  label: string;
  remaining?: number;
  resetsAt?: number;
}

/** One routable account of the shared pool. */
export interface UsageAccountView {
  /** Provider pool: `claude`, `codex`, `grok`, … */
  group: string;
  windows: UsageWindowView[];
  /** In cooldown / rate-limited right now: counts as empty. */
  unavailable?: boolean;
}

export interface ModelBattery {
  /** Pool average of each account's binding window for this model, 0..1; null = not measured. */
  level: number | null;
  /** The most headroom a single available account has (what the next task can get); null = none. */
  best: number | null;
  /** Per window: average remaining over the accounts that report it, earliest reset. */
  windows: Array<{ label: string; remaining: number; resetsAt?: number }>;
  accounts: { measured: number; total: number; available: number };
}

/** The account pool that serves a model id. */
export function providerGroupOf(model: string): string {
  const id = model.toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('o3') || id.startsWith('o4') || id.includes('codex')) return 'codex';
  if (id.startsWith('grok')) return 'grok';
  return 'claude';
}

/** Does this window bind the given model? `5h` / `7d` bind every model; `7d-<scope>` only the model it names. */
function windowApplies(label: string, model: string): boolean {
  if (!label.startsWith('7d-')) return true;
  const scope = label.slice(3).toLowerCase();
  return scope.length > 0 && model.toLowerCase().includes(scope);
}

/**
 * The battery for one model over the shared account pool. It is an estimate of
 * the pool, not a per-user quota — the dashboard labels it so.
 */
export function computeModelBattery(model: string, accounts: UsageAccountView[] | null): ModelBattery {
  const group = providerGroupOf(model);
  const pool = (accounts ?? []).filter((a) => a.group === group);
  const levels: number[] = [];
  let available = 0;
  let best: number | null = null;
  const perWindow = new Map<string, { sum: number; n: number; resetsAt?: number }>();

  for (const account of pool) {
    const applicable = account.windows.filter(
      (w) => windowApplies(w.label, model) && typeof w.remaining === 'number' && Number.isFinite(w.remaining),
    );
    if (applicable.length === 0) continue;
    for (const w of applicable) {
      const slot = perWindow.get(w.label) ?? { sum: 0, n: 0 };
      slot.sum += w.remaining as number;
      slot.n += 1;
      if (typeof w.resetsAt === 'number' && (slot.resetsAt === undefined || w.resetsAt < slot.resetsAt)) {
        slot.resetsAt = w.resetsAt;
      }
      perWindow.set(w.label, slot);
    }
    const binding = Math.max(0, Math.min(1, ...applicable.map((w) => w.remaining as number)));
    const usable = account.unavailable ? 0 : binding;
    levels.push(usable);
    if (usable > 0) {
      available += 1;
      best = best === null ? usable : Math.max(best, usable);
    }
  }

  const windows = [...perWindow.entries()].map(([label, s]) => {
    const view: { label: string; remaining: number; resetsAt?: number } = { label, remaining: s.sum / s.n };
    if (s.resetsAt !== undefined) view.resetsAt = s.resetsAt;
    return view;
  });
  return {
    level: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null,
    best,
    windows,
    accounts: { measured: levels.length, total: pool.length, available },
  };
}

// ── Context (what the composer offers) ───────────────────────────────

export interface NewTaskChannel {
  id: string;
  name: string;
  repos: string[];
}

export interface NewTaskModelOption {
  nickname: string;
  model: string;
  label: string;
  battery: ModelBattery;
}

export interface NewTaskContext {
  models: NewTaskModelOption[];
  /** Nickname of the model selected at start (the user's default model). */
  defaultModel: string;
  efforts: string[];
  defaultEffort: string;
  channels: NewTaskChannel[];
  defaultChannelId: string | null;
  /** Channel membership could not be checked: nothing is offered (fail closed). */
  membershipUnknown: boolean;
  autogoalDefault: boolean;
  usage: { scope: 'shared-pool'; source: string | null; fetchedAt: number | null };
  limits: typeof NEW_TASK_LIMITS;
}

export interface NewTaskContextInput {
  representativeModels: Array<{ nickname: string; model: string; label: string }>;
  userDefaultModel: string;
  userDefaultModelLabel: string;
  userDefaultEffort: string;
  efforts: readonly string[];
  autogoalDefault: boolean;
  /** Every channel the bot knows (ChannelRegistry), with its repo mapping. */
  registryChannels: NewTaskChannel[];
  /** Channels the user is a member of right now; null = could not be checked. */
  memberChannelIds: Set<string> | null;
  /** The user's sessions (channel + last activity, ms) — the fallback for the default channel. */
  recentSessions: Array<{ channelId: string; lastActivity: number }>;
  /** The channel the user last gave a command in (LastCommandChannelStore). */
  lastCommandChannelId: string | null;
  usageAccounts: UsageAccountView[] | null;
  usageSource: string | null;
  usageFetchedAt: number | null;
}

/**
 * The models the new-task dialog offers: the representative set, with the
 * user's own default first when it is not one of them. Shared by the context
 * and the dashboard-task launcher, which resolves a nickname with it (#640 R2).
 */
export function newTaskModelOptions(
  representativeModels: Array<{ nickname: string; model: string; label: string }>,
  userDefaultModel: string,
  userDefaultModelLabel: string,
): { options: Array<{ nickname: string; model: string; label: string }>; defaultModel: string } {
  const options = representativeModels.map((m) => ({ nickname: m.nickname, model: m.model, label: m.label }));
  let defaultModel = options.find((m) => m.model === userDefaultModel)?.nickname;
  if (!defaultModel) {
    options.unshift({
      nickname: userDefaultModel,
      model: userDefaultModel,
      label: userDefaultModelLabel || userDefaultModel,
    });
    defaultModel = userDefaultModel;
  }
  return { options, defaultModel };
}

export function buildNewTaskContext(input: NewTaskContextInput): NewTaskContext {
  const { options, defaultModel } = newTaskModelOptions(
    input.representativeModels,
    input.userDefaultModel,
    input.userDefaultModelLabel,
  );
  const models = options.map((m) => ({ ...m, battery: computeModelBattery(m.model, input.usageAccounts) }));

  // Channels: repo-mapped channels the user is a member of — never inferred from history.
  const members = input.memberChannelIds;
  const offered = members
    ? input.registryChannels
        .filter((c) => c.repos.length > 0 && members.has(c.id) && !c.id.startsWith('D'))
        .map((c) => ({ id: c.id, name: c.name, repos: [...c.repos] }))
    : [];
  const offeredIds = new Set(offered.map((c) => c.id));
  const lastActive = new Map<string, number>();
  for (const s of input.recentSessions) {
    if (!offeredIds.has(s.channelId)) continue;
    lastActive.set(s.channelId, Math.max(lastActive.get(s.channelId) ?? 0, s.lastActivity));
  }
  const byRecency = [...lastActive.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const defaultChannelId =
    (input.lastCommandChannelId && offeredIds.has(input.lastCommandChannelId) ? input.lastCommandChannelId : null) ??
    byRecency[0] ??
    [...offered].sort((a, b) => a.name.localeCompare(b.name))[0]?.id ??
    null;
  // Order: the default first, then recently used, then by name.
  const rank = (id: string) => (id === defaultChannelId ? -2 : lastActive.has(id) ? -1 : 0);
  const channels = offered.sort(
    (a, b) =>
      rank(a.id) - rank(b.id) ||
      (lastActive.get(b.id) ?? 0) - (lastActive.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name),
  );

  const efforts = [...input.efforts];
  return {
    models,
    defaultModel,
    efforts,
    defaultEffort: efforts.includes(input.userDefaultEffort) ? input.userDefaultEffort : (efforts[0] ?? ''),
    channels,
    defaultChannelId,
    membershipUnknown: members === null,
    autogoalDefault: input.autogoalDefault,
    usage: { scope: 'shared-pool', source: input.usageSource, fetchedAt: input.usageFetchedAt },
    limits: NEW_TASK_LIMITS,
  };
}

// ── Submission ───────────────────────────────────────────────────────

export interface NewTaskAttachment {
  name: string;
  mimetype: string;
  data: Buffer;
}

export interface NewTaskSubmission {
  /** Client-generated idempotency key: a retried request launches once. */
  requestId: string;
  prompt: string;
  nickname: string;
  /** Resolved model id. */
  model: string;
  effort: string;
  channelId: string;
  autogoal: boolean;
  autoz: boolean;
  attachments: NewTaskAttachment[];
}

export type NewTaskParseResult = { ok: true; value: NewTaskSubmission } | { ok: false; error: string };

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MIMETYPE = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A file name safe to hand to Slack: no path, no control characters, bounded. */
function cleanFileName(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const base =
    raw
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .split(/[\\/]/)
      .pop() ?? '';
  const trimmed = base.replace(/^\.+/, '').trim().slice(0, 120);
  return trimmed || 'attachment';
}

/**
 * The attachments of a dashboard submission — a new task, or an instruction
 * the panel's composer sends to a running session: `[{ name, mimetype, data }]`
 * with base64 data, decoded and held to {@link NEW_TASK_LIMITS}. Absent = none.
 */
export function parseAttachments(
  raw: unknown,
): { ok: true; value: NewTaskAttachment[] } | { ok: false; error: string } {
  const rawAttachments = raw === undefined ? [] : raw;
  if (!Array.isArray(rawAttachments)) return { ok: false, error: 'attachments must be an array' };
  if (rawAttachments.length > NEW_TASK_LIMITS.maxFiles) {
    return { ok: false, error: `at most ${NEW_TASK_LIMITS.maxFiles} attachments` };
  }
  const attachments: NewTaskAttachment[] = [];
  let total = 0;
  for (const [i, item] of rawAttachments.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `attachment ${i + 1} is malformed` };
    const a = item as Record<string, unknown>;
    if (typeof a.name !== 'string' || a.name.length === 0 || a.name.length > 255) {
      return { ok: false, error: `attachment ${i + 1} needs a name` };
    }
    const mimetype = a.mimetype === undefined || a.mimetype === '' ? 'application/octet-stream' : a.mimetype;
    if (typeof mimetype !== 'string' || mimetype.length > 100 || !MIMETYPE.test(mimetype)) {
      return { ok: false, error: `attachment ${i + 1} has an invalid type` };
    }
    if (typeof a.data !== 'string' || a.data.length === 0 || a.data.length % 4 === 1 || !BASE64.test(a.data)) {
      return { ok: false, error: `attachment ${i + 1} is not valid base64 data` };
    }
    const data = Buffer.from(a.data, 'base64');
    if (data.length === 0) return { ok: false, error: `attachment ${i + 1} is empty` };
    if (data.length > NEW_TASK_LIMITS.maxFileBytes) {
      return { ok: false, error: `attachment ${i + 1} exceeds ${NEW_TASK_LIMITS.maxFileBytes} bytes` };
    }
    total += data.length;
    if (total > NEW_TASK_LIMITS.maxTotalBytes) {
      return { ok: false, error: `attachments exceed ${NEW_TASK_LIMITS.maxTotalBytes} bytes in total` };
    }
    attachments.push({ name: cleanFileName(a.name), mimetype, data });
  }
  return { ok: true, value: attachments };
}

/** #600 ⑥ — a "new task" that becomes a Slack-less dashboard task (`destination: 'task'`). */
export interface DashboardTaskSubmission {
  requestId: string;
  prompt: string;
  /** An existing folder's name in the user's `/tmp/<user>/`; the launcher validates it. */
  folder?: string;
  /** The nickname of a model the dialog offers; the task launcher resolves it (#640 R1). */
  model?: string;
}

const MODEL_NAME = /^[A-Za-z0-9._:[\]-]{1,100}$/;

/**
 * The dashboard-task form of a new-task body: a prompt (required — a task turn
 * takes no attachments yet, D8), optionally a folder name and a model. No
 * channel, no autogoal / autoz (Slack router features a task turn does not reach).
 */
export function parseDashboardTaskSubmission(
  body: unknown,
): { ok: true; value: DashboardTaskSubmission } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) {
    return { ok: false, error: 'requestId must be 8–64 characters of [A-Za-z0-9_-]' };
  }
  if (typeof b.prompt !== 'string') return { ok: false, error: 'prompt must be a string' };
  const prompt = b.prompt.trim();
  if (!prompt) return { ok: false, error: 'prompt is required' };
  if (prompt.length > NEW_TASK_LIMITS.maxPromptChars) {
    return { ok: false, error: `prompt exceeds ${NEW_TASK_LIMITS.maxPromptChars} characters` };
  }
  if (Array.isArray(b.attachments) ? b.attachments.length > 0 : b.attachments !== undefined) {
    return { ok: false, error: 'attachments are not supported on a dashboard task yet' };
  }
  if (b.folder !== undefined && (typeof b.folder !== 'string' || !b.folder)) {
    return { ok: false, error: 'folder must be a folder name' };
  }
  if (b.model !== undefined && (typeof b.model !== 'string' || !MODEL_NAME.test(b.model))) {
    return { ok: false, error: 'model must be a model name' };
  }
  return {
    ok: true,
    value: {
      requestId: b.requestId,
      prompt,
      ...(typeof b.folder === 'string' ? { folder: b.folder } : {}),
      ...(typeof b.model === 'string' ? { model: b.model } : {}),
    },
  };
}

export function parseNewTaskSubmission(body: unknown, ctx: NewTaskContext): NewTaskParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) {
    return { ok: false, error: 'requestId must be 8–64 characters of [A-Za-z0-9_-]' };
  }
  if (typeof b.prompt !== 'string') return { ok: false, error: 'prompt must be a string' };
  const prompt = b.prompt.trim();
  if (prompt.length > NEW_TASK_LIMITS.maxPromptChars) {
    return { ok: false, error: `prompt exceeds ${NEW_TASK_LIMITS.maxPromptChars} characters` };
  }
  const model = ctx.models.find((m) => m.nickname === b.model);
  if (!model) return { ok: false, error: 'model is not one of the offered models' };
  if (typeof b.effort !== 'string' || !ctx.efforts.includes(b.effort)) {
    return { ok: false, error: 'effort is not one of the offered efforts' };
  }
  if (typeof b.channelId !== 'string' || !ctx.channels.some((c) => c.id === b.channelId)) {
    return { ok: false, error: 'channel is not one of the channels offered to you' };
  }
  if (typeof b.autogoal !== 'boolean' || typeof b.autoz !== 'boolean') {
    return { ok: false, error: 'autogoal and autoz must be booleans' };
  }

  const parsed = parseAttachments(b.attachments);
  if (!parsed.ok) return parsed;
  const attachments = parsed.value;

  if (!prompt && attachments.length === 0) return { ok: false, error: 'prompt is required (or attach a file)' };

  return {
    ok: true,
    value: {
      requestId: b.requestId,
      prompt,
      nickname: model.nickname,
      model: model.model,
      effort: b.effort,
      channelId: b.channelId,
      autogoal: b.autogoal,
      autoz: b.autoz,
      attachments,
    },
  };
}

// ── What reaches the session / the channel ───────────────────────────

/** `$autoz` already present as its own token (not `$autozeta`, not `$x:autoz`). */
const AUTOZ_TOKEN = /(^|[^\w$:-])\$autoz(?![\w:-])/;

/**
 * The instruction as the session receives it. With the autoz toggle on,
 * `$autoz` is appended at the very end — exactly what a user typing it in
 * Slack does, so the `$skill` force handler fires the autoz skill.
 */
export function composeTaskText(prompt: string, autoz: boolean): string {
  const text = prompt.trim();
  if (!autoz) return text;
  if (AUTOZ_TOKEN.test(text)) return text;
  return text ? `${text}\n\n$autoz` : '$autoz';
}

export interface NewTaskRootMessageInput {
  userId: string;
  prompt: string;
  nickname: string;
  effort: string;
  autogoal: boolean;
  autoz: boolean;
  attachmentNames: string[];
}

const SECTION_LIMIT = 2900;
const MAX_SECTIONS = 12;

function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The root message posted into the chosen channel: who asked (via Dashboard),
 * the instruction verbatim as plain text (no mention / mrkdwn injection), and
 * the settings it runs with. Progress follows in its thread.
 */
export function buildNewTaskRootMessage(input: NewTaskRootMessageInput): { text: string; blocks: any[] } {
  const blocks: any[] = [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🆕 *새 작업* · <@${input.userId}> via Dashboard` }],
    },
  ];
  const prompt = input.prompt.trim();
  if (prompt) {
    const chunks: string[] = [];
    for (let i = 0; i < prompt.length && chunks.length < MAX_SECTIONS; i += SECTION_LIMIT) {
      chunks.push(prompt.slice(i, i + SECTION_LIMIT));
    }
    if (chunks.join('').length < prompt.length) {
      chunks[chunks.length - 1] =
        `${chunks[chunks.length - 1].slice(0, SECTION_LIMIT - 40)}\n… (이하 생략 — 전체 지시는 세션에 전달됨)`;
    }
    for (const chunk of chunks) blocks.push({ type: 'section', text: { type: 'plain_text', text: chunk } });
  } else {
    blocks.push({ type: 'section', text: { type: 'plain_text', text: '(첨부 파일만 전달)' } });
  }
  const parts = [
    `🤖 \`${input.nickname}\``,
    `🧠 effort \`${input.effort}\``,
    `🎯 autogoal ${input.autogoal ? 'on' : 'off'}`,
    `⚡ autoz ${input.autoz ? 'on' : 'off'}`,
  ];
  if (input.attachmentNames.length) parts.push(`📎 ${input.attachmentNames.length}개 첨부`);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: parts.join('  ·  ') }] });

  const preview = prompt
    ? escapeMrkdwn(prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt)
    : '(첨부 파일만 전달)';
  return { text: `🆕 새 작업 — <@${input.userId}> via Dashboard: ${preview}`, blocks };
}

/** A Slack file download URL — the message pipeline fetches it with the bot token. */
export function isSlackFileUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

// ── Idempotency + per-user limits ────────────────────────────────────

/** A refused or failed launch with the HTTP status it maps to. */
export class NewTaskError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'NewTaskError';
  }
}

export interface NewTaskGateOptions {
  /** How long a finished launch is remembered for its request id. */
  ttlMs?: number;
  maxPerWindow?: number;
  windowMs?: number;
  now?: () => number;
}

export interface NewTaskGate {
  run<T>(userId: string, requestId: string, launch: () => Promise<T>): Promise<T>;
}

/**
 * One launch per (user, request id): a retried request gets the first
 * launch's result instead of a second thread. A user has at most one launch
 * in flight and a bounded number per window. A failed launch is forgotten so
 * the same request id may be retried.
 */
export function createNewTaskGate(options: NewTaskGateOptions = {}): NewTaskGate {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxPerWindow = options.maxPerWindow ?? 10;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const results = new Map<string, { promise: Promise<unknown>; at: number }>();
  const inFlight = new Map<string, string>();
  const launches = new Map<string, number[]>();

  return {
    run<T>(userId: string, requestId: string, launch: () => Promise<T>): Promise<T> {
      const t = now();
      for (const [key, entry] of results) if (t - entry.at > ttlMs) results.delete(key);
      const key = `${userId}\u0000${requestId}`;
      const known = results.get(key);
      if (known) return known.promise as Promise<T>;

      const running = inFlight.get(userId);
      if (running !== undefined && running !== requestId) {
        return Promise.reject(new NewTaskError(429, '이미 다른 작업을 시작하는 중입니다 — 잠시 후 다시 시도하세요'));
      }
      const recent = (launches.get(userId) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= maxPerWindow) {
        launches.set(userId, recent);
        return Promise.reject(new NewTaskError(429, '새 작업을 너무 자주 시작했습니다 — 잠시 후 다시 시도하세요'));
      }
      recent.push(t);
      launches.set(userId, recent);
      inFlight.set(userId, requestId);

      const promise = (async () => {
        try {
          return await launch();
        } catch (error) {
          results.delete(key);
          throw error;
        } finally {
          if (inFlight.get(userId) === requestId) inFlight.delete(userId);
        }
      })();
      results.set(key, { promise, at: t });
      return promise;
    },
  };
}
