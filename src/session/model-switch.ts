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
  /** Start a compact on the session's current model (as if the owner typed `compact --yes`). */
  dispatchCompact(sessionKey: string): Promise<void>;
  save(): void;
  broadcast(): void;
  now?: () => number;
}

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
  const usedTokens = usedContextTokens(session);
  const result = (status: ModelSwitchResult['status']): ModelSwitchResult => ({
    status,
    nickname,
    model,
    autoCompactTokens,
    usedTokens,
  });

  const hasOverride = typeof session.autoCompactTokens === 'number';
  if (session.model === model && !session.pendingModelSwitch && !hasOverride) return result('unchanged');

  if (usedTokens > autoCompactTokens) {
    if (deps.isRequestActive(sessionKey)) {
      throw new ModelSwitchError(
        409,
        `지금 컨텍스트 ${k(usedTokens)}가 ${nickname}의 auto-compact ${k(autoCompactTokens)}보다 커서 먼저 compact해야 합니다 — 진행 중인 턴이 끝난 뒤 다시 시도하세요`,
      );
    }
    session.pendingModelSwitch = { model, nickname, requestedAt: (deps.now ?? Date.now)() };
    deps.save();
    deps.broadcast();
    try {
      await deps.dispatchCompact(sessionKey);
    } catch (error) {
      session.pendingModelSwitch = undefined;
      deps.save();
      deps.broadcast();
      throw new ModelSwitchError(500, `compact를 시작하지 못했습니다: ${(error as Error)?.message ?? String(error)}`);
    }
    return result('compacting');
  }

  applyModelSwitch(session, model, (m) => deps.contextWindow(m ?? model));
  deps.save();
  deps.broadcast();
  return result('switched');
}
