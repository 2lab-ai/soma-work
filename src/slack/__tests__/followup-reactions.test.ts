import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOLLOWUP_REACTION_NAMES,
  diffFollowupReactionRoles,
  FOLLOWUP_REACTION_FALLBACKS,
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

  it('replaces everything with 전달완료 once the item is steered', () => {
    // A1: a steered message is in the SDK's hands, so the controls come down
    // and the `queue` command owns whatever is left to do with it.
    expect(rolesForFollowupState('steered')).toEqual(['delivered']);
  });

  it('keeps 전달완료 through the in-flight states and on resolved', () => {
    for (const state of ['reserved', 'claimed', 'dispatched', 'resolved'] as const) {
      expect(rolesForFollowupState(state), state).toEqual(['delivered']);
    }
  });

  it('shows 캔슬완료 alone on a cancelled item', () => {
    expect(rolesForFollowupState('cancelled')).toEqual(['cancelled']);
  });

  it('shows the warning alone on failed and uncertain — neither control applies', () => {
    expect(rolesForFollowupState('failed')).toEqual(['failed']);
    expect(rolesForFollowupState('uncertain')).toEqual(['failed']);
  });
});

describe('diffFollowupReactionRoles', () => {
  it('adds everything and removes nothing on a first paint', () => {
    expect(diffFollowupReactionRoles(undefined, rolesForFollowupState('queued'))).toEqual({
      add: ['queued', 'sendNow', 'cancel'],
      remove: [],
    });
  });

  it('takes the receipt and both controls down when the item is steered', () => {
    expect(diffFollowupReactionRoles(['queued', 'sendNow', 'cancel'], rolesForFollowupState('steered'))).toEqual({
      add: ['delivered'],
      remove: ['queued', 'sendNow', 'cancel'],
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

  it('re-paints the controls when a swept item goes back to queued', () => {
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

    await surface.applyState(TARGET, 'steered', ['queued', 'sendNow', 'cancel']);

    expect(order).toEqual(['-inbox_tray', '-ui_send_now', '-ui_cancel', '+white_check_mark']);
  });

  it('reports which reactions are standing, so the next transition can undo them', async () => {
    expect(await surface.applyState(TARGET, 'queued', undefined)).toEqual(['queued', 'sendNow', 'cancel']);
    expect(await surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel'])).toEqual(['cancelled']);
  });

  it('falls back to a standard emoji when the custom one is not in the workspace', async () => {
    add.mockImplementation(async (_c: string, _t: string, name: string) =>
      name === 'ui_send_now' ? { ok: false, error: 'invalid_name' } : { ok: true },
    );

    await surface.applyState(TARGET, 'queued', undefined);

    expect(added()).toEqual(['inbox_tray', 'ui_send_now', FOLLOWUP_REACTION_FALLBACKS.sendNow, 'ui_cancel']);
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

    await surface.applyState(TARGET, 'steered', ['queued', 'sendNow', 'cancel']);

    expect(removed()).toContain(FOLLOWUP_REACTION_FALLBACKS.cancel);
    expect(removed()).not.toContain('ui_cancel');
  });

  it('does not fall back on an ordinary failure — only `invalid_name` has a repair', async () => {
    add.mockResolvedValue({ ok: false, error: 'not_in_channel' });

    await surface.applyState(TARGET, 'queued', undefined);

    expect(added()).toEqual(['inbox_tray', 'ui_send_now', 'ui_cancel']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps going when one op throws — a painted surface is best effort', async () => {
    remove.mockRejectedValueOnce(new Error('no_reaction'));

    await expect(surface.applyState(TARGET, 'cancelled', ['queued', 'sendNow', 'cancel'])).resolves.toEqual([
      'cancelled',
    ]);
    expect(added()).toEqual(['no_entry_sign']);
  });

  it('answers whether a reaction name is a control, for the router filter', () => {
    expect(surface.isControlReaction('ui_cancel')).toBe(true);
    expect(surface.isControlReaction(FOLLOWUP_REACTION_FALLBACKS.sendNow)).toBe(true);
    expect(surface.isControlReaction('inbox_tray')).toBe(false);
  });
});
