/**
 * `/z` Block Kit flow — end-to-end wiring tests (#507).
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
 * that every registered topic is wired from `ActionHandlers` through
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
  // T3 invariant: a help button exists iff its topic has a registered card — both directions. A
  // button without a card is the dead "coming in Phase 3" UI this replaced; a card without a
  // button is unreachable from help.
  it('help card buttons are exactly the registered topics', () => {
    const ids = actionIdsIn(buildHelpCard({ issuedAt: 42 }));
    for (const id of ids) expect(id.startsWith('z_help_nav_')).toBe(true);
    const buttons = new Set(ids.map((id) => id.slice('z_help_nav_'.length)));
    expect([...buttons].sort()).toEqual([...buildDefaultTopicRegistry().topics()].sort());
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

  it('a stale help button (topic without a card) says it is no longer used — never a silent no-op', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    // Help cards rendered by older releases still carry buttons such as `z_help_nav_mcp`.
    const body = buildDmActionBody('z_help_nav_mcp');
    await expect(handler.handleHelpNav(body, client)).resolves.toBeUndefined();
    // One visible message (MASTER-SPEC §10 no-silent-fallback), pointing at the current help.
    expect(client.chat.update).toHaveBeenCalledTimes(1);
    const payload = client.chat.update.mock.calls[0][0];
    expect(payload.text).toContain('/z help');
    expect(payload.text).not.toMatch(/Phase/i);
    // Navigation never runs a command: nothing else is posted.
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  // T2/T3: the `skill` help button opens the skill list — personal skills, then environment skills.
  it('z_help_nav_skill replaces the card with the personal skill list, then posts the environment skills', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();

    await handler.handleHelpNav(buildDmActionBody('z_help_nav_skill', 'UNOSKILLS'), client);

    expect(client.chat.update).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.chat.update.mock.calls[0][0])).toContain('personal skill');
    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    const followUp = client.chat.postMessage.mock.calls[0][0];
    expect(followUp.channel).toBe('D1');
    expect(JSON.stringify(followUp)).toContain('환경 스킬');
  });

  it('z_help_nav_skill inside a DM thread posts the environment skills into that thread', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();
    const body: any = buildDmActionBody('z_help_nav_skill', 'UNOSKILLS');
    body.message.thread_ts = '100.1';

    await handler.handleHelpNav(body, client);

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0].thread_ts).toBe('100.1');
  });

  it('a set click on a topic whose card has no settings is ignored', async () => {
    const registry = buildDefaultTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = makeClient();
    await expect(handler.handleSet(buildDmActionBody('z_setting_skill_set_x'), client)).resolves.toBeUndefined();
    expect(client.chat.update).not.toHaveBeenCalled();
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
      // Setting cards open with a header; the skill card is the `$user` list (sections).
      expect(payload.blocks[0].type).toBe(topic === 'skill' ? 'section' : 'header');
    });
  }
});
