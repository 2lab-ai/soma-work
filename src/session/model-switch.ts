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

import { liveOccupancyCall } from '@soma/slack/live-usage';
import { applyModelSwitch, PENDING_MODEL_SWITCH_TTL_MS } from '@soma/slack/model-switch';
import { clampEffortToSupported } from 'soma-lib';
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
  /** The effort levels the model runs, in level order; absent when the catalog has no menu for it. */
  effortLevels?: string[];
}

export interface ModelCatalogDeps {
  /** Alias / id → allowed model id, or null when it does not resolve now. */
  resolveModel(input: string): string | null;
  contextWindow(model: string): number;
  /** The model's own auto-compact threshold for this owner (no session override). */
  autoCompactFor(model: string, ownerId?: string): number;
  displayName(model: string): string;
  /** The effort levels `model` runs, in level order; undefined when the catalog has no menu for it. */
  effortLevels?(model: string): string[] | undefined;
}

export interface ModelSwitchDeps extends ModelCatalogDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  isRequestActive(sessionKey: string): boolean;
  /** The threshold the session compacts at now — its override included. */
  currentAutoCompact?(session: ConversationSession): number;
  /**
   * Start a compact on the session's current model (as if the owner typed
   * `compact --yes`). `onSent` gets the message's identity before it is
   * handled — its compact turn is the only one that applies the switch.
   * Resolves once the message was handled: `queued` when it is parked behind
   * another turn and has not run yet, otherwise `settled` (it ran, or it was
   * dropped).
   */
  dispatchCompact(
    sessionKey: string,
    onSent?: (message: { channel: string; ts: string }) => void,
  ): Promise<CompactDispatchOutcome | undefined | void>;
  /**
   * Is that message still parked in the follow-up queue to run (or running)?
   * Watched while a switch waits on a queued compact: once it will not run
   * (cancelled, stopped, failed), the switch is un-parked.
   */
  isCompactQueued?(message: { channel: string; ts: string }): boolean;
  save(): void;
  broadcast(): void;
  now?: () => number;
}

export type CompactDispatchOutcome = 'queued' | 'settled';

/** How often a switch waiting on a queued compact checks that compact is still ahead. */
export const QUEUED_COMPACT_WATCH_MS = 2_000;

export interface ModelSwitchResult {
  /** `switched` now · `compacting` first, switching at the compact boundary · `unchanged`. */
  status: 'switched' | 'compacting' | 'unchanged';
  nickname: string;
  model: string;
  autoCompactTokens: number;
  usedTokens: number;
  /**
   * The session's effort once the switch lands, present only when it changes:
   * the target does not run the session's level, so it takes the nearest one
   * the target runs (the runtime clamp's rule).
   */
  effort?: string;
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
    const effortLevels = deps.effortLevels?.(model);
    out.push({
      nickname,
      model,
      label: deps.displayName(model),
      contextWindow: deps.contextWindow(model),
      autoCompactTokens: deps.autoCompactFor(model, ownerId),
      ...(effortLevels ? { effortLevels: [...effortLevels] } : {}),
    });
  }
  return out;
}

/** The context the running turn's calls read (largest call, after its compact boundary), 0 when none. */
function liveContextTokens(session: ConversationSession): number {
  const c = liveOccupancyCall(session);
  if (!c) return 0;
  return (c.inputTokens || 0) + (c.outputTokens || 0) + (c.cacheReadTokens || 0) + (c.cacheCreateTokens || 0);
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
  // The effort follows the model: a level the target does not run becomes the
  // nearest one it does, so no menu ever offers or shows a level the model
  // cannot take (a model without a catalog menu keeps the level as it is).
  const menu = deps.effortLevels?.(model);
  const effort =
    session.effort && menu && menu.length > 0 && !menu.includes(session.effort)
      ? clampEffortToSupported(menu, session.effort)
      : undefined;
  const result = (status: ModelSwitchResult['status']): ModelSwitchResult => ({
    status,
    nickname,
    model,
    autoCompactTokens,
    usedTokens,
    ...(effort && status !== 'unchanged' ? { effort } : {}),
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
  // Unknown size (no usage: saved before usage was persisted, or its saved
  // usage was dropped as malformed) is treated as too big when the target
  // compacts earlier: compact first, never switch blind.
  const needsCompact = usedTokens > autoCompactTokens || (shrinking && !sizeKnown && !!session.sessionId);
  if (needsCompact) {
    if (busy) {
      throw new ModelSwitchError(
        409,
        `지금 컨텍스트 ${k(usedTokens)}가 ${nickname}의 auto-compact ${k(autoCompactTokens)}보다 커서 먼저 compact해야 합니다 — 진행 중인 턴이 끝난 뒤 다시 시도하세요`,
      );
    }
    const parked: NonNullable<ConversationSession['pendingModelSwitch']> = {
      model,
      nickname,
      requestedAt: (deps.now ?? Date.now)(),
      ...(effort ? { effort, effortFrom: session.effort } : {}),
    };
    session.pendingModelSwitch = parked;
    // This compact is the one the context needs: a threshold compact already
    // parked for the next message would otherwise swallow our `compact --yes`,
    // compact, and then replay it — compacting twice.
    session.autoCompactPending = false;
    deps.save();
    deps.broadcast();
    // The compact is a whole turn: answer now and let the card follow it (the
    // waiting switch is on the card until the boundary applies it). Only the
    // compact turn of the message sent here applies it (`compactTs`): an
    // auto-compact or a typed compact in between leaves it waiting.
    // The dispatch returns once the message was handled. Ran: the compact
    // turn is over, and its boundary applied the switch (or its end cancelled
    // it). Queued behind another turn: the compact is still ahead — the switch
    // keeps waiting for it (its own turn end settles it; a switch nobody takes
    // expires after `PENDING_MODEL_SWITCH_TTL_MS`). Anything else — dropped,
    // or the dispatch failed — left no compact to wait for: un-park it and
    // push the card again.
    const unpark = () => {
      if (session.pendingModelSwitch !== parked) return;
      session.pendingModelSwitch = undefined;
      deps.save();
      deps.broadcast();
    };
    let sent: { channel: string; ts: string } | undefined;
    const onSent = (message: { channel: string; ts: string }) => {
      sent = message;
      if (session.pendingModelSwitch === parked) parked.compactTs = message.ts;
    };
    // Queued: watch it. Its own /compact turn arms the switch and takes it
    // from there; a compact that will no longer run (cancelled, stopped,
    // failed) or a switch past its TTL is un-parked — never left to lock the
    // card or to wait on a compact that is gone.
    const watchQueued = (message: { channel: string; ts: string }) => {
      const probe = deps.isCompactQueued;
      if (!probe) return;
      const now = deps.now ?? Date.now;
      const timer = setInterval(() => {
        if (session.pendingModelSwitch !== parked || parked.armed) {
          clearInterval(timer);
          return;
        }
        let ahead = false;
        try {
          ahead = probe(message);
        } catch {
          ahead = false;
        }
        if (!ahead || now() - parked.requestedAt > PENDING_MODEL_SWITCH_TTL_MS) {
          clearInterval(timer);
          unpark();
        }
      }, QUEUED_COMPACT_WATCH_MS);
      (timer as { unref?: () => void }).unref?.();
    };
    void Promise.resolve()
      .then(() => deps.dispatchCompact(sessionKey, onSent))
      .then((outcome) => {
        if (outcome !== 'queued') unpark();
        else if (sent) watchQueued(sent);
      }, unpark);
    return result('compacting');
  }

  applyModelSwitch(session, model, (m) => deps.contextWindow(m ?? model), effort);
  deps.save();
  deps.broadcast();
  return result('switched');
}
