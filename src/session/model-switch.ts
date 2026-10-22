/**
 * Dashboard model switch, host side (SSOT 2026-10-22 T4/T5).
 *
 * Only the representative models — the ones with a nickname — can be chosen:
 * opus / fable / sonnet / sol / astra `[1m]` and grok. grok has no 1M variant
 * (llmux forwards grok ids unchanged and `grok-4.6[1m]` is refused), so its
 * representative is `grok-4.6`: a 500k window that auto-compacts at 450k.
 *
 * A switch makes the new model's auto-compact threshold the session's
 * (`applyModelSwitch` drops a session override). When the context already
 * holds more than that threshold, switching straight away would leave the
 * session over its new model's limit: the current model compacts first (the
 * same `compact --yes` a user types) and the switch waits on the session
 * (`pendingModelSwitch`) for that compact's boundary — see
 * `@soma/slack/model-switch`. A compact cannot start mid-turn, so that case
 * is refused (409) until the turn ends.
 */

import { applyModelSwitch } from '@soma/slack/model-switch';
import type { ConversationSession } from '../types';

export const REPRESENTATIVE_MODEL_NICKNAMES = [
  'opus[1m]',
  'fable[1m]',
  'sonnet[1m]',
  'sol[1m]',
  'astra[1m]',
  'grok[1m]',
] as const;

/** What each nickname is resolved from (the model alias input). */
const NICKNAME_INPUT: Record<string, string> = { 'grok[1m]': 'grok-4.6' };

export interface RepresentativeModel {
  nickname: string;
  model: string;
  label: string;
  contextWindow: number;
  /** The model's own auto-compact threshold (no session override). */
  autoCompactTokens: number;
}

export interface ModelCatalogDeps {
  /** Alias / id → allowed model id, or null when it does not resolve now. */
  resolveModel(input: string): string | null;
  contextWindow(model: string): number;
  /** The model's own auto-compact threshold for this owner (no session override). */
  autoCompactFor(model: string, ownerId?: string): number;
  displayName(model: string): string;
}

export interface ModelSwitchDeps extends ModelCatalogDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  isRequestActive(sessionKey: string): boolean;
  /** The threshold the session compacts at now — its override included. */
  currentAutoCompact?(session: ConversationSession): number;
  /**
   * Start a compact on the session's current model (as if the owner typed
   * `compact --yes`). Resolves once the message was handled: `queued` when it
   * is parked behind another turn and has not run yet, otherwise `settled`
   * (it ran, or it was dropped).
   */
  dispatchCompact(sessionKey: string): Promise<CompactDispatchOutcome | undefined | void>;
  save(): void;
  broadcast(): void;
  now?: () => number;
}

export type CompactDispatchOutcome = 'queued' | 'settled';

export interface ModelSwitchResult {
  /** `switched` now · `compacting` first, switching at the compact boundary · `unchanged`. */
  status: 'switched' | 'compacting' | 'unchanged';
  nickname: string;
  model: string;
  autoCompactTokens: number;
  usedTokens: number;
}

export class ModelSwitchError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelSwitchError';
  }
}

/** The representative models that resolve right now, in nickname order. */
export function listRepresentativeModels(deps: ModelCatalogDeps, ownerId?: string): RepresentativeModel[] {
  const out: RepresentativeModel[] = [];
  for (const nickname of REPRESENTATIVE_MODEL_NICKNAMES) {
    const model = deps.resolveModel(NICKNAME_INPUT[nickname] ?? nickname);
    if (!model) continue;
    out.push({
      nickname,
      model,
      label: deps.displayName(model),
      contextWindow: deps.contextWindow(model),
      autoCompactTokens: deps.autoCompactFor(model, ownerId),
    });
  }
  return out;
}

/** The context the running turn's latest call read (largest per-call total), 0 when none. */
function liveContextTokens(session: Pick<ConversationSession, 'liveUsage'>): number {
  let top = 0;
  for (const c of Object.values(session.liveUsage ?? {})) {
    const n = (c.inputTokens || 0) + (c.outputTokens || 0) + (c.cacheReadTokens || 0) + (c.cacheCreateTokens || 0);
    if (n > top) top = n;
  }
  return top;
}

/** Tokens the context holds now (the four `current*` usage fields). */
export function usedContextTokens(session: Pick<ConversationSession, 'usage'>): number {
  const u = session.usage;
  if (!u) return 0;
  return (
    (u.currentInputTokens || 0) +
    (u.currentOutputTokens || 0) +
    (u.currentCacheReadTokens || 0) +
    (u.currentCacheCreateTokens || 0)
  );
}

function k(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export async function switchSessionModel(
  sessionKey: string,
  nickname: string,
  deps: ModelSwitchDeps,
): Promise<ModelSwitchResult> {
  if (!(REPRESENTATIVE_MODEL_NICKNAMES as readonly string[]).includes(nickname)) {
    throw new ModelSwitchError(400, `대표 모델만 고를 수 있습니다: ${REPRESENTATIVE_MODEL_NICKNAMES.join(', ')}`);
  }
  const model = deps.resolveModel(NICKNAME_INPUT[nickname] ?? nickname);
  if (!model) throw new ModelSwitchError(503, `${nickname} 모델을 지금 쓸 수 없습니다`);
  const session = deps.getSession(sessionKey);
  if (!session) throw new ModelSwitchError(404, 'Session not found');
  if (session.terminated) throw new ModelSwitchError(409, '종료된 세션은 모델을 바꿀 수 없습니다');

  const autoCompactTokens = deps.autoCompactFor(model, session.ownerId);
  // The committed usage is measured at turn end; a running turn's calls may
  // already hold more.
  const usedTokens = Math.max(usedContextTokens(session), liveContextTokens(session));
  // A target that compacts earlier than the session does now (its override
  // included) is the dangerous direction: it needs the context's real size.
  const currentAutoCompact = deps.currentAutoCompact
    ? deps.currentAutoCompact(session)
    : typeof session.autoCompactTokens === 'number'
      ? session.autoCompactTokens
      : session.model
        ? deps.autoCompactFor(session.model, session.ownerId)
        : Number.POSITIVE_INFINITY;
  const shrinking = autoCompactTokens < currentAutoCompact;
  const sizeKnown = !!session.usage || !!(session.liveUsage && Object.keys(session.liveUsage).length);
  const result = (status: ModelSwitchResult['status']): ModelSwitchResult => ({
    status,
    nickname,
    model,
    autoCompactTokens,
    usedTokens,
  });

  const hasOverride = typeof session.autoCompactTokens === 'number';
  if (session.model === model && !session.pendingModelSwitch && !hasOverride) return result('unchanged');

  const busy = deps.isRequestActive(sessionKey);
  if (busy && shrinking) {
    // Mid-turn the context keeps growing and a compact cannot start: a target
    // that compacts earlier waits for the turn to end.
    throw new ModelSwitchError(
      409,
      `${nickname}의 auto-compact(${k(autoCompactTokens)})가 지금 모델보다 작아 컨텍스트 확인·compact가 필요합니다 — 진행 중인 턴이 끝난 뒤 다시 시도하세요`,
    );
  }
  // Unknown size (usage is not restored across a restart) is treated as too
  // big when the target compacts earlier: compact first, never switch blind.
  const needsCompact = usedTokens > autoCompactTokens || (shrinking && !sizeKnown && !!session.sessionId);
  if (needsCompact) {
    if (busy) {
      throw new ModelSwitchError(
        409,
        `지금 컨텍스트 ${k(usedTokens)}가 ${nickname}의 auto-compact ${k(autoCompactTokens)}보다 커서 먼저 compact해야 합니다 — 진행 중인 턴이 끝난 뒤 다시 시도하세요`,
      );
    }
    session.pendingModelSwitch = { model, nickname, requestedAt: (deps.now ?? Date.now)() };
    // This compact is the one the context needs: a threshold compact already
    // parked for the next message would otherwise swallow our `compact --yes`,
    // compact, and then replay it — compacting twice.
    session.autoCompactPending = false;
    deps.save();
    deps.broadcast();
    // The compact is a whole turn: answer now and let the card follow it (the
    // waiting switch is on the card until the boundary applies it).
    // The dispatch returns once the message was handled. Ran: the compact
    // turn is over, and its boundary applied the switch (or its end cancelled
    // it). Queued behind another turn: the compact is still ahead — the switch
    // keeps waiting for it (its own turn end settles it; a switch nobody takes
    // expires after `PENDING_MODEL_SWITCH_TTL_MS`). Anything else — dropped,
    // or the dispatch failed — left no compact to wait for: un-park it and
    // push the card again.
    const parked = session.pendingModelSwitch;
    const unpark = () => {
      if (session.pendingModelSwitch !== parked) return;
      session.pendingModelSwitch = undefined;
      deps.save();
      deps.broadcast();
    };
    void Promise.resolve()
      .then(() => deps.dispatchCompact(sessionKey))
      .then((outcome) => {
        if (outcome !== 'queued') unpark();
      }, unpark);
    return result('compacting');
  }

  applyModelSwitch(session, model, (m) => deps.contextWindow(m ?? model));
  deps.save();
  deps.broadcast();
  return result('switched');
}
