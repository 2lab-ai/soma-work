/**
 * Turn occupancy — the one answer to "is a turn running in this session?" (.prd/39 S1).
 *
 * A dispatcher run carries one turn, and the run moves through phases:
 *
 *   none       the slot is free
 *   preparing  a dispatch took the slot; its turn has not started (reactions, files, routing, session init)
 *   running    the turn runs: a request controller exists, or this process's turn runtime said `working`
 *              (also between legs, when a continuation or a `/compact` replay follows at once)
 *   settling   the run's last leg ended `idle` or `waiting`; the run has not released the slot yet
 *
 * The turn-end trigger of the goal loop fires inside `settling`, so `settling` is not a held turn — counting it
 * would keep the loop from ever running after its own turn.
 *
 * The turn-runtime marks live in memory only and are tied to the run's turn generation: they come from this
 * process's `setActivityState` transitions, never from a value loaded from disk or written by host recovery. Right
 * after a restart there are none, so a stale persisted `working` is not a running turn.
 */

import type { ActivityState } from '../types';

export type RunPhase = 'none' | 'preparing' | 'running' | 'settling';

export interface SessionOccupancyDeps {
  /** The dispatcher holds this key's slot. */
  slotBusy(key: string): boolean;
  /** The turn generation of the run holding this key's slot (`FollowupDispatcher.liveTurnEpoch`). */
  slotEpoch(key: string): number | undefined;
  /** After a bot-thread migration, the running turn's slot is the source key's. */
  migratedSlotOf(key: string): string | undefined;
  /** A request controller is registered for the session. */
  requestActive(key: string): boolean;
  /** The goal loop has a run queued or running, or a continuation it injected has not yet taken the slot. */
  loopActing(key: string): boolean;
}

interface TurnMark {
  /** The run generation the mark belongs to; `undefined` = no run held the slot when the turn reported. */
  epoch: number | undefined;
  activity: ActivityState;
}

export class SessionOccupancy {
  private readonly marks = new Map<string, TurnMark>();

  constructor(private readonly deps: SessionOccupancyDeps) {}

  /** The key whose dispatcher slot carries this session's run: its own, or the source key it migrated from. */
  private slotKeyOf(key: string): string | undefined {
    if (this.deps.slotBusy(key)) return key;
    const migrated = this.deps.migratedSlotOf(key);
    return migrated !== undefined && this.deps.slotBusy(migrated) ? migrated : undefined;
  }

  /** A dispatcher run holds this session's slot (any phase). */
  slotHeld(key: string): boolean {
    return this.slotKeyOf(key) !== undefined;
  }

  /** The turn runtime of this process changed the session's activity (from `SessionRegistry.setActivityState`). */
  noteTurnActivity(key: string, activity: ActivityState): void {
    const slotKey = this.slotKeyOf(key);
    this.marks.set(key, { epoch: slotKey === undefined ? undefined : this.deps.slotEpoch(slotKey), activity });
  }

  /** Forget the session's turn mark (session deleted). */
  forget(key: string): void {
    this.marks.delete(key);
  }

  /** The mark of the run holding the slot now, if it reported; a mark from an earlier run does not count. */
  private markOfCurrentRun(key: string, slotKey: string): TurnMark | undefined {
    const mark = this.marks.get(key);
    if (!mark) return undefined;
    return mark.epoch === this.deps.slotEpoch(slotKey) ? mark : undefined;
  }

  runPhase(key: string): RunPhase {
    const slotKey = this.slotKeyOf(key);
    if (slotKey === undefined) return this.deps.requestActive(key) ? 'running' : 'none';
    if (this.deps.requestActive(key)) return 'running';
    const mark = this.markOfCurrentRun(key, slotKey);
    if (!mark) return 'preparing';
    return mark.activity === 'working' ? 'running' : 'settling';
  }

  /**
   * A turn is starting or running — what the goal loop must not judge or inject beside. A run that is only
   * settling (its turn ended) does not hold the turn. Outside a dispatcher run (slot-less task turns), a
   * `working` mark from this process still counts, as between the legs of a continuation.
   */
  turnHeld(key: string): boolean {
    const phase = this.runPhase(key);
    if (phase === 'preparing' || phase === 'running') return true;
    if (phase === 'none') return this.marks.get(key)?.activity === 'working';
    return false;
  }

  /** Someone will act for the session: a run holds its slot, or the goal loop is acting. */
  driven(key: string): boolean {
    return this.runPhase(key) !== 'none' || this.deps.loopActing(key);
  }

  /** The owner is being asked something: the action panel waits for a choice, or a question is pending. */
  static ownerQuestionOpen(
    session: { actionPanel?: { waitingForChoice?: boolean; pendingQuestion?: unknown } } | undefined,
  ): boolean {
    const panel = session?.actionPanel;
    return panel?.waitingForChoice === true || !!panel?.pendingQuestion;
  }
}
