import { randomUUID } from 'crypto';
import { Logger } from '../logger';
import { getMetricsEmitter } from '../metrics/event-emitter';
import { ConversationStorage } from './storage';
import { generateSessionSummaryTitle, type SessionSummaryTitleLinks, summarizeResponse } from './summarizer';
import type { ConversationRecord, ConversationTurn, TurnCompaction, TurnOrigin } from './types';
import { getUserMediaStore, type TurnAttachment, type UserMediaFile } from './user-media';

const logger = new Logger('ConversationRecorder');

// Singleton storage instance
let storage: ConversationStorage | null = null;

// In-memory cache of active conversations with LRU eviction (keyed by conversationId)
const MAX_CACHE_SIZE = 100;
const activeConversations = new Map<string, ConversationRecord>();

// Per-conversation write locks to serialize disk writes and prevent race conditions
const writeLocks = new Map<string, Promise<void>>();

// One disk read per conversation at a time: concurrent cold reads share it, so
// two snapshots of the same conversation can never both be live.
const pendingLoads = new Map<string, Promise<ConversationRecord | null>>();

// Saves not yet on disk, per conversation. An entry here is never evicted from
// the cache — otherwise the next cold read could load the pre-save file and
// publish it over the writes still in flight.
const savesInFlight = new Map<string, number>();

// Optional callback fired after each turn is recorded
let _onTurnRecorded: ((conversationId: string, turn: ConversationTurn) => void) | null = null;

// Optional callback fired when a summary is generated for an assistant turn.
// Used to update session title on Slack thread header.
let _onSummaryGenerated: ((conversationId: string, turn: ConversationTurn, summaryTitle: string) => void) | null = null;

// Dashboard v2.1 — session summary title bridge. Populated by the app at
// startup to wire the recorder ↔ session-registry without a cyclical import.
// Returned object is a live pointer into the session; mutations are visible
// to subsequent reads.
export interface SessionTitleBridgeSnapshot {
  sessionKey: string;
  userMessages: string[];
  lastAssistantTurnId?: string;
  summaryTitleLastUpdatedAtMs?: number;
  links?: SessionSummaryTitleLinks;
}
export interface SessionTitleBridge {
  getSnapshot(conversationId: string): SessionTitleBridgeSnapshot | null;
  setLastAssistantTurnId(conversationId: string, turnId: string): void;
  applyTitle(sessionKey: string, title: string, turnId: string, model: 'haiku' | 'sonnet'): void;
}
let _sessionTitleBridge: SessionTitleBridge | null = null;
export function setSessionTitleBridge(bridge: SessionTitleBridge | null): void {
  _sessionTitleBridge = bridge;
}

// In-flight summary-title generation guard (module-level Map).
// Key: sessionKey. Drop additional requests while one is pending so
// simultaneous turns trigger at most one LLM call per session.
const _summaryTitleInFlight = new Map<string, Promise<void>>();

// 60s debounce between successful title regenerations.
const SUMMARY_TITLE_DEBOUNCE_MS = 60_000;
// Minimum user-message count before we attempt title generation.
const SUMMARY_TITLE_MIN_USER_MSG = 3;

/**
 * Set a callback that fires after each turn is recorded.
 * Used by the dashboard to broadcast real-time conversation updates.
 */
export function setOnTurnRecordedCallback(fn: (conversationId: string, turn: ConversationTurn) => void): void {
  _onTurnRecorded = fn;
}

/**
 * Set a callback that fires when summary generation completes.
 * Used to update session title on Slack and broadcast summary to dashboard.
 */
export function setOnSummaryGeneratedCallback(
  fn: (conversationId: string, turn: ConversationTurn, summaryTitle: string) => void,
): void {
  _onSummaryGenerated = fn;
}

/**
 * Serialize save operations per conversation to prevent race conditions.
 * Each conversation's writes are queued so only one writeFile runs at a time.
 */
async function serializedSave(conversationId: string, record: ConversationRecord): Promise<void> {
  await inWriteChain(conversationId, () => getStorage().save(record));
}

/**
 * Run `task` in this conversation's write chain: after every write queued
 * before it has landed on disk, and before any write queued after it.
 */
async function inWriteChain<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
  savesInFlight.set(conversationId, (savesInFlight.get(conversationId) ?? 0) + 1);
  const previous = writeLocks.get(conversationId) || Promise.resolve();
  const current = previous.then(task);
  writeLocks.set(
    conversationId,
    current.then(
      () => undefined,
      (err) => {
        logger.error(`Write chain: prior save failed for ${conversationId}, next write will proceed`, err);
      },
    ),
  );
  try {
    return await current;
  } finally {
    const left = (savesInFlight.get(conversationId) ?? 1) - 1;
    if (left > 0) savesInFlight.set(conversationId, left);
    else savesInFlight.delete(conversationId);
  }
}

/**
 * Add a record to the in-memory cache with LRU eviction.
 * Oldest entries are evicted when cache exceeds MAX_CACHE_SIZE.
 */
function cacheRecord(id: string, record: ConversationRecord): void {
  // If already in cache, delete and re-insert to maintain insertion order (LRU)
  if (activeConversations.has(id)) {
    activeConversations.delete(id);
  }
  // Evict oldest entries if at capacity — skipping any with a save still in
  // flight (see savesInFlight). If every entry is mid-save the cache briefly
  // exceeds the cap rather than dropping unsaved state.
  for (const oldest of activeConversations.keys()) {
    if (activeConversations.size < MAX_CACHE_SIZE) break;
    if (savesInFlight.has(oldest)) continue;
    activeConversations.delete(oldest);
    writeLocks.delete(oldest);
    logger.debug(`Evicted conversation ${oldest} from cache (LRU)`);
  }
  activeConversations.set(id, record);
}

/**
 * Initialize the recorder with optional base directory
 */
export function initRecorder(baseDir?: string): void {
  storage = new ConversationStorage(baseDir);
  logger.info('Conversation recorder initialized', { baseDir: baseDir || 'default' });
}

/**
 * Get or create the storage instance
 */
function getStorage(): ConversationStorage {
  if (!storage) {
    storage = new ConversationStorage();
  }
  return storage;
}

/**
 * Create a new conversation and return its ID
 */
export function createConversation(
  channelId: string,
  threadTs: string,
  ownerId: string,
  ownerName: string,
  title?: string,
  workflow?: string,
): string {
  const id = randomUUID();
  const now = Date.now();

  const record: ConversationRecord = {
    id,
    channelId,
    threadTs,
    ownerId,
    ownerName,
    title,
    workflow,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };

  cacheRecord(id, record);

  // Fire-and-forget: persist to disk (serialized per conversation)
  serializedSave(id, record).catch((err) => {
    logger.error(`Failed to persist new conversation ${id}`, err);
  });

  logger.info(`Created conversation ${id}`, { channelId, threadTs, ownerName });
  return id;
}

/**
 * #598 ④b — create a conversation and resolve only once its record is on disk.
 * A failed save rejects and leaves nothing cached, so a Slack-less task never
 * runs a turn whose recording destination does not exist
 * (`createConversation` returns at once and only logs a failed save).
 */
export async function createConversationDurable(
  channelId: string,
  threadTs: string,
  ownerId: string,
  ownerName: string,
  title?: string,
  workflow?: string,
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const record: ConversationRecord = {
    id,
    channelId,
    threadTs,
    ownerId,
    ownerName,
    title,
    workflow,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
  cacheRecord(id, record);
  try {
    await serializedSave(id, record);
  } catch (err) {
    activeConversations.delete(id);
    writeLocks.delete(id);
    throw err;
  }
  logger.info(`Created conversation ${id} (durable)`, { ownerName });
  return id;
}

/**
 * Copy a turn's downloaded files into the user-media store (SSOT 2026-10-25).
 * Awaited by the caller BEFORE it records the turn and before the turn's temp
 * cleanup; bounded inside the store, never throws, never drops a file.
 */
export function captureUserMedia(conversationId: string, files: readonly UserMediaFile[]): Promise<TurnAttachment[]> {
  return getUserMediaStore().capture(conversationId, files);
}

/**
 * Record a user turn (fire-and-forget, non-blocking).
 * `attachments` — the files the user attached (from `captureUserMedia`); their
 * copies are committed once the turn is saved, before the dashboard is told.
 * `opts.timestamp` — when the user sent it, if earlier than now (a steered message).
 * `opts.origin` — who put the turn there (dashboard SSOT 2026-10-27 T1).
 */
export function recordUserTurn(
  conversationId: string,
  content: string,
  userName?: string,
  userId?: string,
  attachments?: readonly TurnAttachment[],
  opts: { timestamp?: number; origin?: TurnOrigin; compact?: boolean } = {},
): void {
  // Fire-and-forget
  _recordUserTurnAsync(conversationId, content, userName, userId, attachments, opts).catch((err) => {
    logger.error(`Failed to record user turn for ${conversationId}`, err);
  });
  // Metrics: emit turn_used event (fire-and-forget)
  getMetricsEmitter()
    .emitTurnUsed(conversationId, userId, userName, 'user')
    .catch((err) => logger.debug('metrics emit failed', err));
}

async function _recordUserTurnAsync(
  conversationId: string,
  content: string,
  userName: string | undefined,
  userId: string | undefined,
  attachments: readonly TurnAttachment[] | undefined,
  opts: { timestamp?: number; origin?: TurnOrigin; compact?: boolean },
): Promise<void> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    // The copies stay pending and are swept (user-media.ts lifecycle).
    logger.warn(`Conversation ${conversationId} not found, skipping user turn recording`);
    return;
  }

  const now = Date.now();
  const { timestamp, origin } = opts;
  // A compaction turn (the executor's flag) carries its record from the start —
  // empty, or the conversation's previous compaction time as the estimate.
  const estimateMs = opts.compact ? previousCompactionMs(record) : undefined;
  const turn: ConversationTurn = {
    id: randomUUID(),
    role: 'user',
    timestamp: typeof timestamp === 'number' && timestamp > 0 && timestamp <= now ? timestamp : now,
    userName,
    userId,
    rawContent: content,
    ...(attachments && attachments.length > 0 ? { attachments: [...attachments] } : {}),
    ...(origin ? { origin: { by: origin.by } } : {}),
    ...(opts.compact ? { compact: estimateMs !== undefined ? { estimateMs } : {} } : {}),
  };

  record.turns.push(turn);
  record.updatedAt = now;

  await serializedSave(conversationId, record);
  // Saved: the copies the turn lists may now be served — before anyone is told about it.
  if (turn.attachments) await getUserMediaStore().commit(conversationId, turn.attachments);
  if (_onTurnRecorded) _onTurnRecorded(conversationId, turn);
}

/**
 * The longest a compaction may run before the END that arrives is not its own
 * (`COMPACTION_IN_PROGRESS_MAX_MS` in @soma/slack/compact-state is 10 min) —
 * with slack for the gap between the turn being recorded and the compaction
 * starting.
 */
const COMPACT_RESULT_WINDOW_MS = 15 * 60 * 1000;

/** The duration of the conversation's latest compaction that reported one. */
function previousCompactionMs(record: ConversationRecord): number | undefined {
  for (let i = record.turns.length - 1; i >= 0; i--) {
    const ms = record.turns[i].compact?.durationMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms;
  }
  return undefined;
}

/**
 * Dashboard SSOT 2026-10-27 T2 — a compaction ended (the PostCompact hook /
 * `compact_boundary`, once per cycle): write its numbers onto the `/compact`
 * turn that ran it and push that turn to the dashboard again. The turn is the
 * latest user turn when it is a compaction turn (`compact` set at record time
 * from the executor's flag), recorded no longer ago than a
 * compaction can run; a result already on it only gets its missing numbers. A
 * compaction the SDK started inside an ordinary turn has no such turn —
 * nothing is written. Returns whether a turn was written.
 */
export async function recordCompactResult(
  conversationId: string,
  result: Omit<TurnCompaction, 'estimateMs'> & { endedAt: number },
): Promise<boolean> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return false;
  let turn: ConversationTurn | undefined;
  for (let i = record.turns.length - 1; i >= 0; i--) {
    const t = record.turns[i];
    if (t.role !== 'user') continue;
    if (t.compact) turn = t;
    break;
  }
  if (!turn) return false;
  if (result.endedAt - turn.timestamp > COMPACT_RESULT_WINDOW_MS) return false;

  // Already written (a second END of the cycle, or the SDK's boundary landing
  // after the hook sealed it without numbers): fill what is missing, never
  // overwrite.
  const sealed = turn.compact?.endedAt !== undefined;
  const compact: TurnCompaction = sealed ? { ...turn.compact } : { ...turn.compact, endedAt: result.endedAt };
  let filled = false;
  for (const key of ['durationMs', 'preTokens', 'postTokens'] as const) {
    const v = result[key];
    if (sealed && compact[key] !== undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      compact[key] = v;
      filled = true;
    }
  }
  if ((result.trigger === 'manual' || result.trigger === 'auto') && !(sealed && compact.trigger)) {
    compact.trigger = result.trigger;
    filled = true;
  }
  if (sealed && !filled) return false;
  turn.compact = compact;
  record.updatedAt = Date.now();
  await serializedSave(conversationId, record);
  if (_onTurnRecorded) {
    try {
      _onTurnRecorded(conversationId, turn);
    } catch (err) {
      logger.warn('onTurnRecorded callback failed', { conversationId, turnId: turn.id, error: err });
    }
  }
  return true;
}

/**
 * Record an assistant turn (fire-and-forget, non-blocking).
 * Generates summary asynchronously after saving raw content.
 */
export function recordAssistantTurn(conversationId: string, content: string): void {
  // Fire-and-forget
  _recordAssistantTurnAsync(conversationId, content).catch((err) => {
    logger.error(`Failed to record assistant turn for ${conversationId}`, err);
  });
  // Metrics: emit turn_used event for assistant (fire-and-forget)
  getMetricsEmitter()
    .emitTurnUsed(conversationId, 'assistant', 'assistant', 'assistant')
    .catch((err) => logger.debug('metrics emit failed', err));
}

async function _recordAssistantTurnAsync(conversationId: string, content: string): Promise<void> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    logger.warn(`Conversation ${conversationId} not found, skipping assistant turn recording`);
    return;
  }

  const turn: ConversationTurn = {
    id: randomUUID(),
    role: 'assistant',
    timestamp: Date.now(),
    rawContent: content,
    summarized: false,
  };

  record.turns.push(turn);
  record.updatedAt = Date.now();

  // Save immediately with raw content (serialized to prevent race conditions)
  await serializedSave(conversationId, record);
  if (_onTurnRecorded) _onTurnRecorded(conversationId, turn);

  // Dashboard v2.1 — advance session's lastAssistantTurnId for stale-write
  // guards in summary-title regeneration.
  if (_sessionTitleBridge) {
    try {
      _sessionTitleBridge.setLastAssistantTurnId(conversationId, turn.id);
    } catch (err) {
      logger.debug('sessionTitleBridge.setLastAssistantTurnId failed', { error: err });
    }
  }

  // Then generate summary asynchronously (don't block)
  generateSummary(conversationId, turn.id, content).catch((err) => {
    logger.error(`Failed to generate summary for turn ${turn.id}`, err);
  });
}

/**
 * Generate summary for an assistant turn and update the record
 */
async function generateSummary(conversationId: string, turnId: string, content: string): Promise<void> {
  const summary = await summarizeResponse(content);

  const record = await getOrLoadConversation(conversationId);
  if (!record) {
    logger.warn(`Conversation ${conversationId} disappeared during summary generation for turn ${turnId}`);
    return;
  }

  const turn = record.turns.find((t) => t.id === turnId);
  if (!turn) {
    logger.warn(`Turn ${turnId} not found in conversation ${conversationId} during summary — possible race condition`);
    return;
  }

  if (summary) {
    turn.summaryTitle = summary.title;
    turn.summaryBody = summary.body;
  } else {
    logger.warn(`Summary generation returned null for turn ${turnId} in conversation ${conversationId}`);
  }

  // Always mark as summarized so the UI can distinguish pending vs failed
  turn.summarized = true;
  record.updatedAt = Date.now();

  await serializedSave(conversationId, record);

  // Always broadcast the updated turn (with summary or failure) to dashboard via WebSocket.
  // The initial broadcast (in _recordAssistantTurnAsync) fires before summary exists;
  // this second broadcast delivers the completed/failed summary for live UI update.
  if (_onTurnRecorded) {
    try {
      _onTurnRecorded(conversationId, turn);
    } catch (err) {
      logger.warn('onTurnRecorded callback failed', { conversationId, turnId, error: err });
    }
  }

  if (summary) {
    logger.debug(`Summary generated for turn ${turnId}: "${summary.title}"`);
    // Notify session title update (e.g., update Slack thread header)
    if (_onSummaryGenerated) {
      try {
        _onSummaryGenerated(conversationId, turn, summary.title);
      } catch (err) {
        logger.warn('onSummaryGenerated callback failed', { conversationId, turnId, error: err });
      }
    }
  }

  // Dashboard v2.1 — trigger session summary title regeneration.
  // Fire-and-forget; guards + debounce + stale-check happen inside.
  maybeRegenerateSessionSummaryTitle(conversationId, turnId).catch((err) => {
    logger.debug('session summary title regeneration failed', { conversationId, turnId, error: err });
  });
}

/**
 * Debounce / version-guarded session-summary-title regeneration.
 * Triggered after each assistant turn is persisted.
 */
async function maybeRegenerateSessionSummaryTitle(conversationId: string, turnId: string): Promise<void> {
  if (!_sessionTitleBridge) return;
  const snap = _sessionTitleBridge.getSnapshot(conversationId);
  if (!snap) return;
  const { sessionKey, userMessages, summaryTitleLastUpdatedAtMs, links } = snap;

  // Skip: not enough user signal yet.
  if (!userMessages || userMessages.length < SUMMARY_TITLE_MIN_USER_MSG) return;

  // Skip: 60s debounce window.
  if (summaryTitleLastUpdatedAtMs && Date.now() - summaryTitleLastUpdatedAtMs < SUMMARY_TITLE_DEBOUNCE_MS) {
    return;
  }

  // Skip (trailing): if a generation is already in flight for this session,
  // let it finish — the next turn will re-trigger if still stale.
  if (_summaryTitleInFlight.has(sessionKey)) return;

  // Version guard — record the turn id we're building against. If the
  // session's lastAssistantTurnId moves past this by the time we get the
  // response, discard our write.
  const startTurnId = turnId;

  const work = (async () => {
    const result = await generateSessionSummaryTitle(userMessages, links);
    if (!result || !_sessionTitleBridge) return;
    const latest = _sessionTitleBridge.getSnapshot(conversationId);
    if (!latest || latest.sessionKey !== sessionKey) return;
    if (latest.lastAssistantTurnId && latest.lastAssistantTurnId !== startTurnId) {
      logger.debug('Discarding stale summary title write (turn advanced)', {
        sessionKey,
        startTurnId,
        latest: latest.lastAssistantTurnId,
      });
      return;
    }
    _sessionTitleBridge.applyTitle(sessionKey, result.title, startTurnId, result.model);
  })();

  _summaryTitleInFlight.set(sessionKey, work);
  try {
    await work;
  } finally {
    _summaryTitleInFlight.delete(sessionKey);
  }
}

/**
 * Re-generate summary for a specific assistant turn (e.g. after a failed summary).
 * Resets the summarized flag, clears stale summary data, and kicks off a new summary generation.
 */
export async function resummarizeTurn(conversationId: string, turnId: string): Promise<boolean> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return false;
  const turn = record.turns.find((t) => t.id === turnId);
  if (!turn || turn.role !== 'assistant') return false;

  // Guard: rawContent is required for summary generation.
  // Without it, clearing old summary data would cause permanent data loss.
  if (!turn.rawContent) {
    logger.warn(`Cannot resummarize turn ${turnId}: no rawContent available`);
    return false;
  }

  // Reset summarized flag
  turn.summarized = false;
  turn.summaryTitle = undefined;
  turn.summaryBody = undefined;
  await serializedSave(conversationId, record);

  // Re-generate summary
  generateSummary(conversationId, turnId, turn.rawContent).catch((err) => {
    logger.error(`Resummarize failed for turn ${turnId}`, err);
  });
  return true;
}

/**
 * Get conversation from cache or load from disk
 */
async function getOrLoadConversation(id: string): Promise<ConversationRecord | null> {
  // Check in-memory cache first
  const cached = activeConversations.get(id);
  if (cached) return cached;

  // Load from disk — one read per conversation at a time (see pendingLoads).
  const pending = pendingLoads.get(id);
  if (pending) return pending;
  const load = loadAndCache(id).finally(() => pendingLoads.delete(id));
  pendingLoads.set(id, load);
  return load;
}

async function loadAndCache(id: string): Promise<ConversationRecord | null> {
  const record = await getStorage().load(id);
  // A writer that does not read first (createConversation) may have cached this
  // id while we were on the disk. That object is the live one; publishing our
  // snapshot over it would roll back its writes — e.g. a titleSub fill would
  // then see "empty" and overwrite the owner's subtitle.
  const raced = activeConversations.get(id);
  if (raced) return raced;
  if (record) {
    cacheRecord(id, record);
  }
  return record;
}

/**
 * Get a conversation record (for web viewer)
 */
export async function getConversation(id: string): Promise<ConversationRecord | null> {
  return getOrLoadConversation(id);
}

/**
 * List all conversations (for web viewer list page)
 */
export async function listConversations() {
  return getStorage().list();
}

/**
 * Get a specific turn's raw content (for lazy loading)
 */
export async function getTurnRawContent(conversationId: string, turnId: string): Promise<string | null> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return null;

  const turn = record.turns.find((t) => t.id === turnId);
  return turn?.rawContent || null;
}

/**
 * Update the subordinate-model generated title (titleSub) for a conversation
 */
export async function updateConversationTitleSub(conversationId: string, titleSub: string): Promise<boolean> {
  const record = await getOrLoadConversation(conversationId);
  if (!record) return false;
  record.titleSub = titleSub;
  record.updatedAt = Date.now();
  await serializedSave(conversationId, record);
  return true;
}

/**
 * Fill titleSub only while it is still empty, and return the stored value.
 * A subtitle written while the caller was generating (the owner's regenerate,
 * another viewer's fill) wins — a fill never overwrites.
 *
 * The check runs inside this conversation's write chain against the file on
 * disk, not against the cached object: every save queued before it has landed,
 * so the file is the truth even if the cached object was evicted and replaced
 * by an older read in the meantime. The fill writes onto that file's record (so
 * it cannot roll back anything else on disk) and mirrors titleSub into the
 * cached object. updatedAt is left alone: filling derived data is not
 * conversation activity. Returns null when the conversation does not exist.
 */
export async function fillConversationTitleSub(conversationId: string, titleSub: string): Promise<string | null> {
  return inWriteChain(conversationId, async () => {
    const stored = await getStorage().load(conversationId);
    const cached = activeConversations.get(conversationId);
    const target = stored ?? cached;
    if (!target) return null;
    // The cached object may hold a newer value whose save is queued after us.
    const existing = cached?.titleSub || stored?.titleSub;
    if (existing) {
      if (cached && !cached.titleSub) cached.titleSub = existing;
      return existing;
    }
    target.titleSub = titleSub;
    if (cached) cached.titleSub = titleSub;
    await getStorage().save(target);
    return titleSub;
  });
}
