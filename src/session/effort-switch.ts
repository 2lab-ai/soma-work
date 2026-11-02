/**
 * Dashboard effort switch, host side (SSOT 2026-10-23 T1).
 *
 * Changes one session's reasoning effort — the same scope as the Slack
 * `%effort <level>` command: the session only, never the owner's default
 * (that is the settings page's `defaultEffort`). The SDK reads
 * `session.effort` when the next turn starts (`build-stream-options.ts`
 * clamps it to the model there), so a change made mid-turn applies from the
 * next turn.
 */

import { EFFORT_LEVELS, type EffortLevel, SDK_EFFORT_LEVELS } from 'soma-lib';
import type { ConversationSession } from '../types';

export interface EffortSwitchDeps {
  getSession(sessionKey: string): ConversationSession | undefined;
  /** What the model actually runs for `effort` (`clampEffortToModel`). */
  clamp(model: string, effort: string): string;
  /**
   * The levels `model` runs, or undefined when nothing is known (then the SDK
   * levels). A level outside it is refused (400): the dashboard offers only
   * the model's levels, so a pick outside them is stale or forged.
   */
  menu?(model: string): readonly string[] | undefined;
  /** The owner's default model — what a session without a model of its own runs. */
  ownerDefaultModel?(ownerId: string | undefined): string | undefined;
  save(): void;
  broadcast(): void;
}

export interface EffortSwitchResult {
  status: 'switched' | 'unchanged';
  effort: EffortLevel;
  previous: EffortLevel | undefined;
  /** The level the session's model runs — differs from `effort` when the model caps it. */
  effective: string;
}

export class EffortSwitchError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'EffortSwitchError';
  }
}

/** Normalize an effort input the way the Slack resolver does; null when unknown. */
export function parseEffortLevel(input: unknown): EffortLevel | null {
  if (typeof input !== 'string') return null;
  const normalized = input.toLowerCase().trim();
  return (EFFORT_LEVELS as readonly string[]).includes(normalized) ? (normalized as EffortLevel) : null;
}

export function switchSessionEffort(sessionKey: string, input: unknown, deps: EffortSwitchDeps): EffortSwitchResult {
  const effort = parseEffortLevel(input);
  if (!effort) {
    throw new EffortSwitchError(400, `effort는 ${EFFORT_LEVELS.join(', ')} 중 하나여야 합니다`);
  }
  const session = deps.getSession(sessionKey);
  if (!session) throw new EffortSwitchError(404, 'Session not found');
  if (session.terminated) throw new EffortSwitchError(409, '종료된 세션은 effort를 바꿀 수 없습니다');

  // The levels the session's model runs; without a menu, the SDK levels (never `ultra`).
  const model = session.model || deps.ownerDefaultModel?.(session.ownerId);
  const menu = (model && deps.menu?.(model)) || SDK_EFFORT_LEVELS;
  if (!menu.includes(effort)) {
    throw new EffortSwitchError(
      400,
      `이 세션의 모델은 effort ${effort}를 지원하지 않습니다 — ${menu.join(', ')} 중 하나`,
    );
  }

  const previous = session.effort;
  const effective = session.model ? deps.clamp(session.model, effort) : effort;
  if (previous === effort) return { status: 'unchanged', effort, previous, effective };

  session.effort = effort;
  deps.save();
  deps.broadcast();
  return { status: 'switched', effort, previous, effective };
}
