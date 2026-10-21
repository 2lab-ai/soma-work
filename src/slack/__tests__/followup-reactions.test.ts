import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOLLOWUP_REACTION_NAMES,
  diffFollowupReactionRoles,
  FOLLOWUP_REACTION_FALLBACKS,
  FOLLOWUP_REACTION_SKIPPED_AFTER_FAILED_REMOVE,
  FollowupReactionSurface,
  followupControlRole,
  rolesForFollowupState,
} from '../followup-reactions';

/**
 * The reaction surface (09 §2.1/§2.3) — the state→emoji table and the ops it
 * takes to get from one state to the next.
 *
 * Kept pure on purpose: the table is the contract the user wrote down, and it
 * has to be readable as a table. The only impure part is {@link
 * FollowupReactionSurface}, which is given a port and owns exactly two
 * decisions the table cannot express: the order (remove before add, so the
 * message never shows two contradictory states) and the `invalid_name`
 * fallback.
 */

const TARGET = { channel: 'C1', ts: '222.333' };

describe('rolesForFollowupState — 09 §2.1', () => {
  it('shows the receipt and BOTH controls on a queued item', () => {
    expect(rolesForFollowupState('queued')).toEqual(['queued', 'sendNow', 'cancel']);
  });

  it('shows the same three on a paused item — Send now is its Resume', () => {
    expect(rolesForFollowupState('paused')).toEqual(['queued', 'sendNow', 'cancel']);
  });

  /**
   * 2026-09-18 user correction: `steered` is WAITING, not delivered. The message
   * sits in the SDK's input channel until the model picks it up at its next
   * tool-call boundary, and that window is exactly when the user still wants
   * both controls — the previous table took them away there.
   */
  it('keeps the receipt and BOTH controls on a steered item — it is still waiting', () => {
    expect(rolesForFollowupState('steered')).toEqual(['queued', 'sendNow', 'cancel']);
  });

  it('claims delivery only once there IS one — dispatched and resolved', () => {
    for (const state of ['dispatched', 'resolved'] as const) {
      expect(rolesForFollowupState(state), state).toEqual(['delivered']);
    }
  });

  /**
   * `reserved`/`claimed` sit between the drain's decision and the dispatch, and
   * `rollback` (`followup-queue.ts:558-565`) puts either straight back to
   * `queued`. A check mark there would claim a delivery that may never happen —
   * and the controls stay down because the queue refuses to cancel anything in
   * flight.
   */
  it('shows the receipt ALONE while an item is reserved or claimed — no delivery, no controls', () => {
    for (const state of ['reserved', 'claimed'] as const) {
      expect(rolesForFollowupState(state), state).toEqual(['queued']);
    }
  });

  it('shows 캔슬완료 alone on a cancelled item', () => {
    expect(rolesForFollowupState('cancelled')).toEqual(['cancelled']);
  });

  /**
   * Both states are actionable in the domain: the queue cancels them
   * (`CANCELLABLE_STATES`) and `retry` is their one non-terminal exit. The
   * `sendNow` role is the "go" control — the host routes it into Retry here
   * (09 C1) — so a parked row is never left with a warning and no way out.
   */
  it('keeps BOTH controls next to the warning on failed and uncertain', () => {
    expect(rolesForFollowupState('failed')).toEqual(['failed', 'sendNow', 'cancel']);
    expect(rolesForFollowupState('uncertain')).toEqual(['failed', 'sendNow', 'cancel']);
  });
});

describe('diffFollowupReactionRoles', () => {
  it('adds everything and removes nothing on a first paint', () => {
    expect(diffFollowupReactionRoles(undefined, rolesForFollowupState('queued'))).toEqual({
      add: ['queued', 'sendNow', 'cancel'],
      remove: [],
    });
  });

  it('takes the receipt and both controls down when the model has READ the item', () => {
    expect(diffFollowupReactionRoles(['queued', 'sendNow', 'cancel'], rolesForFollowupState('resolved'))).toEqual({
      add: ['delivered'],
      remove: ['queued', 'sendNow', 'cancel'],
    });
  });

  it('changes nothing when a queued item is merely steered', () => {
    expect(diffFollowupReactionRoles(['queued', 'sendNow', 'cancel'], rolesForFollowupState('steered'))).toEqual({
      add: [],
      remove: [],
    });
  });

  /**
   * §2.1 cancelled: the bot's OWN `ui_cancel` is what it removes (2→1) — the
   * user's stays, which is what makes the count read as "you did this".
   */
  it('removes the bot copy of every control on a cancel', () => {
    expect(diffFollowupReactionRoles(['queued', 'sendNow', 'cancel'], rolesForFollowupState('cancelled'))).toEqual({
      add: ['cancelled'],
      remove: ['queued', 'sendNow', 'cancel'],
    });
  });

  it('re-paints the controls when a consumed-looking row goes back to queued', () => {
    expect(diffFollowupReactionRoles(['delivered'], rolesForFollowupState('queued'))).toEqual({
      add: ['queued', 'sendNow', 'cancel'],
      remove: ['delivered'],
    });
  });

  it('is a no-op when nothing changed', () => {
    expect(diffFollowupReactionRoles(['delivered'], ['delivered'])).toEqual({ add: [], remove: [] });
  });
});

describe('followupControlRole', () => {
  it('names the control a reaction stands for', () => {
    expect(followupControlRole('ui_send_now', DEFAULT_FOLLOWUP_REACTION_NAMES)).toBe('sendNow');
    expect(followupControlRole('ui_cancel', DEFAULT_FOLLOWUP_REACTION_NAMES)).toBe('cancel');
  });

  it('accepts the fallback emoji too — a workspace without the custom ones still works', () => {
    expect(followupControlRole(FOLLOWUP_REACTION_FALLBACKS.sendNow, DEFAULT_FOLLOWUP_REACTION_NAMES)).toBe('sendNow');
    expect(followupControlRole(FOLLOWUP_REACTION_FALLBACKS.cancel, DEFAULT_FOLLOWUP_REACTION_NAMES)).toBe('cancel');
  });

  it('refuses the STATE emoji — 전달완료 is a report, not a button', () => {
    expect(followupControlRole('white_check_mark', DEFAULT_FOLLOWUP_REACTION_NAMES)).toBeUndefined();
    expect(followupControlRole('inbox_tray', DEFAULT_FOLLOWUP_REACTION_NAMES)).toBeUndefined();
    expect(followupControlRole('+1', DEFAULT_FOLLOWUP_REACTION_NAMES)).toBeUndefined();
  });

  it('follows a renamed control from config', () => {
    const names = { ...DEFAULT_FOLLOWUP_REACTION_NAMES, cancel: 'stop_sign' };
    expect(followupControlRole('stop_sign', names)).toBe('cancel');
    expect(followupControlRole('ui_cancel', names)).toBeUndefined();
  });
});

describe('FollowupReactionSurface', () => {
  let add: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let surface: FollowupReactionSurface;

  beforeEach(() => {
    add = vi.fn().mockResolvedValue({ ok: true });
    remove = vi.fn().mockResolvedValue(undefined);
    warn = vi.fn();
    surface = new FollowupReactionSurface({
      port: { add: add as any, remove: remove as any },
      onWarn: warn as any,
    });
  });

  const added = () => add.mock.calls.map((call: any[]) => call[2]);
  const removed = () => remove.mock.calls.map((call: any[]) => call[2]);

  it('paints the three queued reactions on the user message itself', async () => {
    await surface.applyState(TARGET, 'queued', undefined);

    expect(add.mock.calls.map((call: any[]) => [call[0], call[1]])).toEqual([
      ['C1', '222.333'],
      ['C1', '222.333'],
      ['C1', '222.333'],
    ]);
    expect(added()).toEqual(['inbox_tray', 'ui_send_now', 'ui_cancel']);
    expect(removed()).toEqual([]);
  });

  /**
   * Removes first: a message that briefly carried both `inbox_tray` and
   * `white_check_mark` would read as two states at once.
   */
  it('removes the old reactions before adding the new one', async () => {
    const order: string[] = [];
    add.mockImplementation(async (_c: string, _t: string, name: string) => {
      order.push(`+${name}`);
      return { ok: true };
    });
    remove.mockImplementation(async (_c: string, _t: string, name: string) => {
      order.push(`-${name}`);
    });

    await surface.applyState(TARGET, 'resolved', ['queued', 'sendNow', 'cancel']);

    expect(order).toEqual(['-inbox_tray', '-ui_send_now', '-ui_cancel', '+white_check_mark']);
  });

  /**
   * 2026-09-21 — the three queued reactions used to be added one `await` at a
   * time, so each one paid a full round trip through the shared rate-limit
   * queue and the controls appeared seconds apart ("왜 지금 실행 이모지랑 취소
   * 이모지가 서로 다른 시간에 추가됨?"). They are one picture, so they are
   * issued as one: all three calls are in flight before the first answers.
   */
  it('issues the adds of one paint concurrently — the three controls are one picture', async () => {
    const inFlight: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    add.mockImplementation(async (_c: string, _t: string, name: string) => {
      inFlight.push(name);
      await gate;
      return { ok: true };
    });

    const paint = surface.applyState(TARGET, 'queued', undefined);
    await Promise.resolve();

    // Nothing has answered yet, and all three are already asked.
    expect(inFlight).toEqual(['inbox_tray', 'ui_send_now', 'ui_cancel']);
    release();
    expect((await paint).painted).toEqual(['queued', 'sendNow', 'cancel']);
  });

  /** The same for the removes of a transition — still strictly before the adds. */
  it('issues the removes concurrently, and still finishes all of them before any add', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remove.mockImplementation(async (_c: string, _t: string, name: string) => {
      order.push(`-${name}`);
      await gate;
    });
    add.mockImplementation(async (_c: string, _t: string, name: string) => {
      order.push(`+${name}`);
      return { ok: true };
    });

    const paint = surface.applyState(TARGET, 'resolved', ['queued', 'sendNow', 'cancel']);
    await Promise.resolve();

    expect(order).toEqual(['-inbox_tray', '-ui_send_now', '-ui_cancel']);
    release();
    await paint;
    expect(order).toEqual(['-inbox_tray', '-ui_send_now', '-ui_cancel', '+white_check_mark']);
  });

  it('reports which reactions are standing, so the next transition can undo them', async () => {
    expect((await surface.applyState(TARGET, 'queued', undefined)).painted).toEqual(['queued', 'sendNow', 'cancel']);
    expect((await surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel'])).painted).toEqual([
      'cancelled',
    ]);
  });

  it('falls back to a standard emoji when the custom one is not in the workspace', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_send_now' ? { ok: false, error: 'invalid_name' } : { ok: true },
    );

    const result = await surface.applyState(TARGET, 'queued', undefined);

    // The three roles are ISSUED first (one concurrent paint), so the repair
    // for the refused one lands after them rather than in its place — the
    // fallback is a second call on the same role either way.
    expect(added()).toEqual(['inbox_tray', 'ui_send_now', 'ui_cancel', FOLLOWUP_REACTION_FALLBACKS.sendNow]);
    // The fallback WORKED, so the role is standing and nothing is outstanding.
    expect(result.painted).toEqual(['queued', 'sendNow', 'cancel']);
    expect(result.failed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once and then uses the fallback directly — one WARN per name (§2.3)', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_cancel' ? { ok: false, error: 'invalid_name' } : { ok: true },
    );

    await surface.applyState(TARGET, 'queued', undefined);
    add.mockClear();
    await surface.applyState({ channel: 'C1', ts: '444.555' }, 'queued', undefined);

    expect(added()).toEqual(['inbox_tray', 'ui_send_now', FOLLOWUP_REACTION_FALLBACKS.cancel]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('removes the fallback name once it is the one standing', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_cancel' ? { ok: false, error: 'invalid_name' } : { ok: true },
    );
    await surface.applyState(TARGET, 'queued', undefined);

    await surface.applyState(TARGET, 'resolved', ['queued', 'sendNow', 'cancel']);

    expect(removed()).toContain(FOLLOWUP_REACTION_FALLBACKS.cancel);
    expect(removed()).not.toContain('ui_cancel');
  });

  it('does not fall back on an ordinary failure — only `invalid_name` has a repair', async () => {
    add.mockResolvedValue({ ok: false, error: 'not_in_channel' });

    await surface.applyState(TARGET, 'queued', undefined);

    expect(added()).toEqual(['inbox_tray', 'ui_send_now', 'ui_cancel']);
  });

  /* ---------------------------------------------------------------- *
   * Failure accounting — a refused call must never look like a paint.
   * ---------------------------------------------------------------- */

  it('reads `no_reaction` on a remove as success — the reaction not being there IS the goal', async () => {
    remove.mockResolvedValue({ ok: false, error: 'no_reaction' });

    const result = await surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel']);

    expect(result.painted).toEqual(['cancelled']);
    expect(result.failed).toEqual([]);
    expect(added()).toEqual(['no_entry_sign']);
  });

  it('reads `already_reacted` on an add as success', async () => {
    add.mockResolvedValue({ ok: false, error: 'already_reacted' });

    const result = await surface.applyState(TARGET, 'queued', undefined);

    expect(result.painted).toEqual(['queued', 'sendNow', 'cancel']);
    expect(result.failed).toEqual([]);
  });

  /**
   * The bug this pins: recording a role as painted when its add was refused
   * means the next identical sync computes an EMPTY diff and the reaction is
   * missing forever, with nothing left to notice it.
   */
  it('does not record a failed add as painted, and says which one failed', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_cancel' ? { ok: false, error: 'ratelimited' } : { ok: true },
    );

    const result = await surface.applyState(TARGET, 'queued', undefined);

    expect(result.painted).toEqual(['queued', 'sendNow']);
    expect(result.failed).toEqual([{ role: 'cancel', op: 'add', error: 'ratelimited' }]);
  });

  it('reports a fallback add that fails too', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_send_now'
        ? { ok: false, error: 'invalid_name' }
        : name === 'arrow_forward'
          ? { ok: false, error: 'ratelimited' }
          : { ok: true },
    );

    const result = await surface.applyState(TARGET, 'queued', undefined);

    expect(result.painted).toEqual(['queued', 'cancel']);
    expect(result.failed).toEqual([{ role: 'sendNow', op: 'add', error: 'ratelimited' }]);
  });

  it('keeps a role whose removal failed as painted, so the next sync takes it down again', async () => {
    remove.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_cancel' ? { ok: false, error: 'ratelimited' } : { ok: true },
    );

    const result = await surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel']);

    expect(result.painted).toEqual(['cancel']);
    expect(result.failed).toContainEqual({ role: 'cancel', op: 'remove', error: 'ratelimited' });
  });

  /**
   * Remove-before-add exists so the message never shows two states at once.
   * A failed remove therefore cancels the adds as well: `no_entry_sign` next to
   * a `ui_send_now` that would not come down is exactly the picture the order
   * was protecting against.
   */
  it('skips the adds when a remove failed, and reports them as not attempted', async () => {
    remove.mockResolvedValue({ ok: false, error: 'ratelimited' });

    const result = await surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel']);

    expect(added()).toEqual([]);
    expect(result.painted).toEqual(['queued', 'sendNow', 'cancel']);
    expect(result.failed).toContainEqual({
      role: 'cancelled',
      op: 'add',
      error: FOLLOWUP_REACTION_SKIPPED_AFTER_FAILED_REMOVE,
    });
  });

  it('a failed remove does not block an add of a role that is not contradicted — after it succeeds', async () => {
    // First sync: the remove fails, so nothing is added.
    remove.mockResolvedValueOnce({ ok: false, error: 'ratelimited' });
    const first = await surface.applyState(TARGET, 'resolved', ['queued']);
    expect(first.painted).toEqual(['queued']);
    expect(added()).toEqual([]);

    // Second sync, same target state, remove works this time.
    const second = await surface.applyState(TARGET, 'resolved', first.painted);

    expect(removed()).toEqual(['inbox_tray', 'inbox_tray']);
    expect(added()).toEqual(['white_check_mark']);
    expect(second.painted).toEqual(['delivered']);
    expect(second.failed).toEqual([]);
  });

  /**
   * Reconciliation: the next sync repaints exactly what is missing and removes
   * exactly what is extra — which is only possible because `painted` describes
   * the message rather than the request.
   */
  it('repaints exactly the missing roles on the next identical sync', async () => {
    add
      .mockImplementationOnce(async () => ({ ok: true }))
      .mockImplementationOnce(async () => ({
        ok: false,
        error: 'ratelimited',
      }));
    const first = await surface.applyState(TARGET, 'queued', undefined);
    expect(first.painted).toEqual(['queued', 'cancel']);
    add.mockClear();

    const second = await surface.applyState(TARGET, 'queued', first.painted);

    expect(added()).toEqual(['ui_send_now']);
    expect(removed()).toEqual([]);
    expect(second.painted).toEqual(['queued', 'sendNow', 'cancel']);
    expect(second.failed).toEqual([]);
  });

  it('reads the Slack code out of a thrown error, and tolerates the harmless one', async () => {
    remove.mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'no_reaction' } }));
    add.mockRejectedValueOnce(Object.assign(new Error('boom'), { data: { error: 'ratelimited' } }));

    const result = await surface.applyState(TARGET, 'cancelled', ['queued']);

    expect(result.failed).toEqual([{ role: 'cancelled', op: 'add', error: 'ratelimited' }]);
    expect(result.painted).toEqual([]);
  });

  it('never throws out of a paint — the queue transition it describes is already durable', async () => {
    remove.mockRejectedValue(new Error('network down'));

    const result = await surface.applyState(TARGET, 'cancelled', ['queued']);

    // A throw with no Slack code is reported by its message, and the add it
    // blocked is reported too — the row has not converged either way.
    expect(result.failed).toContainEqual({ role: 'queued', op: 'remove', error: 'network down' });
    expect(result.painted).toEqual(['queued']);
  });

  it('warns once per message, role and error', async () => {
    add.mockResolvedValue({ ok: false, error: 'ratelimited' });

    await surface.applyState(TARGET, 'queued', undefined);
    const afterFirst = warn.mock.calls.length;
    await surface.applyState(TARGET, 'queued', undefined);

    expect(afterFirst).toBe(3); // one per role
    expect(warn.mock.calls.length).toBe(afterFirst);
    // A different message is a different fact and is reported again.
    await surface.applyState({ channel: 'C1', ts: '999.999' }, 'queued', undefined);
    expect(warn.mock.calls.length).toBe(afterFirst + 3);
  });

  it('answers whether a reaction name is a control, for the router filter', () => {
    expect(surface.isControlReaction('ui_cancel')).toBe(true);
    expect(surface.isControlReaction(FOLLOWUP_REACTION_FALLBACKS.sendNow)).toBe(true);
    expect(surface.isControlReaction('inbox_tray')).toBe(false);
  });
});
