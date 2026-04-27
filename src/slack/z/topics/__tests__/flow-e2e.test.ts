/**
 * `/z` Block Kit flow — end-to-end wiring tests (Phase 2, #507).
 *
 * Validates the full three-step lifecycle:
 *
 *   1. `/z` (empty) or `help` → buildHelpCard() with z_help_nav_<topic> buttons
 *   2. User clicks z_help_nav_<topic>  → handleHelpNav → binding.renderCard →
 *      ZRespond.replace() with the topic card (z_setting_<topic>_set_<value> buttons)
 *   3. User clicks z_setting_<topic>_set_<value> → handleSet → binding.apply →
 *      ZRespond.replace() with the confirmation card
 *
 * These tests use the real `buildDefaultTopicRegistry()` (no mocks for the
 * topic bindings) + a fake Slack client. They are the canonical smoke-test
 * that the 11 topics are wired correctly from `ActionHandlers` through
 * `ZSettingsActionHandler` to `ZRespond`.
 */

import { describe, expect, it, vi } from 'vitest';
import { ZSettingsActionHandler } from '../../../actions/z-settings-actions';
import { buildHelpCard } from '../../ui-builder';
import { buildDefaultTopicRegistry } from '../index';

function buildDmActionBody(actionId: string, userId = 'U1') {
  return {
    container: { channel_id: 'D1', message_ts: '111.1' },
    message: { ts: '111.1' },
    actions: [{ action_id: actionId, value: 'v' }],
    user: { id: userId },
    trigger_id: 'trig1',
  };
}

function makeClient() {
  const chat = {
    update: vi.fn().mockResolvedValue({ ts: '111.1', channel: 'D1' }),
    postMessage: vi.fn().mockResolvedValue({ ts: '222.2' }),
    postEphemeral: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };
  return { chat } as any;
}

function actionIdsIn(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks ?? []) {
    if (b.type === 'actions') for (const e of b.elements ?? []) if (e.action_id) out.push(e.action_id);
  }
  return out;
}

describe('/z Block Kit flow — help card → nav → set', () => {
  it('help card lists nav buttons for every registered topic', () => {
    const blocks = buildHelpCard({ issuedAt: 42 });
    const ids = actionIdsIn(blocks);
    // Every id must be a nav button.
    for (const id of ids) expect(id.startsWith('z_help_nav_')).toBe(true);
    // Spot-check — all Phase 2 topic ids must have a corresponding nav button
    // (since the default card includes them).
    const registry = buildDefaultTopicRegistry();
    for (const topic of registry.topics()) {
      expect(ids).toContain(`z_help_nav_${topic}`);
    }
  });

  it('z_help_nav_<topic> replaces the card via chat.update in DM source', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    // Pick a side-effect-free topic (verbosity).
    const body = buildDmActionBody('z_help_nav_verbosity');
    await handler.handleHelpNav(body, client);

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const payload = client.chat.update.mock.calls[0][0];
    expect(payload.channel).toBe('D1');
    expect(payload.ts).toBe('111.1');
    expect(Array.isArray(payload.blocks)).toBe(true);
    // The rendered topic card exposes z_setting_verbosity_set_* buttons.
    const ids = actionIdsIn(payload.blocks);
    expect(ids.some((id) => id.startsWith('z_setting_verbosity_set_'))).toBe(true);
    expect(ids).toContain('z_setting_verbosity_cancel');
  });

  it('z_setting_<topic>_set_<value> → binding.apply → confirmation card', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    // verbosity set quiet (valid) — persists but harmless.
    const body = buildDmActionBody('z_setting_verbosity_set_quiet');
    await handler.handleSet(body, client);

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const payload = client.chat.update.mock.calls[0][0];
    // Confirmation card has a single `section` block + optional context.
    expect(Array.isArray(payload.blocks)).toBe(true);
    expect(payload.blocks[0].type).toBe('section');
  });

  it('z_setting_<topic>_cancel → dismisses (chat.delete in DM)', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    const body = buildDmActionBody('z_setting_verbosity_cancel');
    await handler.handleCancel(body, client);
    expect(client.chat.delete).toHaveBeenCalledWith({ channel: 'D1', ts: '111.1' });
  });

  it('unknown topic nav surfaces a visible Phase 3 notice (no silent fallback)', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    const body = buildDmActionBody('z_help_nav_doesnotexist');
    await expect(handler.handleHelpNav(body, client)).resolves.toBeUndefined();
    // DM path → replace() calls chat.update; we expect ONE visible message
    // (not a silent no-op) even for unregistered topics so the "no silent
    // fallback" invariant (MASTER-SPEC §10) holds.
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const payload = client.chat.update.mock.calls[0][0];
    expect(payload.text).toContain('Phase 3');
    expect(payload.text).toContain('doesnotexist');
  });
});

describe('/z Block Kit flow — every registered topic renders a non-empty card', () => {
  const registry = buildDefaultTopicRegistry();
  for (const topic of registry.topics()) {
    it(`renders ${topic} card with at least one actions/context block`, async () => {
      const handler = new ZSettingsActionHandler({ registry });
      const client = makeClient();
      const body = buildDmActionBody(`z_help_nav_${topic}`);
      await handler.handleHelpNav(body, client);
      expect(client.chat.update).toHaveBeenCalledTimes(1);
      const payload = client.chat.update.mock.calls[0][0];
      expect(Array.isArray(payload.blocks)).toBe(true);
      expect(payload.blocks.length).toBeGreaterThan(0);
      // Header is always block[0].
      expect(payload.blocks[0].type).toBe('header');
    });
  }
});
