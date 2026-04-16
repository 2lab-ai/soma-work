import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelEphemeralZRespond, DmZRespond, SlashZRespond } from '../z/respond';
import {
  respondFromActionBody,
  ZSettingsActionHandler,
  type ZTopicBinding,
  ZTopicRegistry,
} from './z-settings-actions';

/* ------------------------------------------------------------------ *
 * respondFromActionBody — source selection
 * ------------------------------------------------------------------ */

describe('respondFromActionBody', () => {
  const client = {
    chat: {
      update: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({ ts: '1.0' }),
      postEphemeral: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns DmZRespond when container channel starts with D', () => {
    const body = {
      container: { channel_id: 'D123', message_ts: '111.1' },
      message: { ts: '111.1' },
      user: { id: 'U1' },
    };
    const r = respondFromActionBody({ body, client });
    expect(r).toBeInstanceOf(DmZRespond);
    expect(r.source).toBe('dm');
  });

  it('returns ChannelEphemeralZRespond when response_url present (channel)', () => {
    const body = {
      container: { channel_id: 'C456' },
      response_url: 'https://hooks.slack.com/actions/xxx',
      user: { id: 'U1' },
    };
    const r = respondFromActionBody({ body, client });
    expect(r).toBeInstanceOf(ChannelEphemeralZRespond);
    expect(r.source).toBe('channel_mention');
  });

  it('returns SlashZRespond when no channel_id but respond() available', () => {
    const body = { user: { id: 'U1' } };
    const respond = vi.fn();
    const r = respondFromActionBody({ body, client, respond });
    expect(r).toBeInstanceOf(SlashZRespond);
  });

  it('returns ChannelEphemeralZRespond w/o responseUrl as last resort', () => {
    const body = { user: { id: 'U1' }, container: { channel_id: 'C1' } };
    const r = respondFromActionBody({ body, client });
    expect(r).toBeInstanceOf(ChannelEphemeralZRespond);
  });

  it('slash-in-DM (container.is_ephemeral=true) uses ChannelEphemeralZRespond, not DmZRespond', () => {
    // Regression: `/z` invoked inside a DM yields an ephemeral slash response;
    // button clicks on that card arrive with channel_id=D... AND
    // is_ephemeral=true. chat.update is illegal on ephemeral messages, so we
    // MUST route through response_url (ChannelEphemeralZRespond) instead of
    // DmZRespond.
    const body = {
      container: { channel_id: 'D123', is_ephemeral: true },
      response_url: 'https://hooks.slack.com/actions/slash-in-dm',
      user: { id: 'U1' },
    };
    const r = respondFromActionBody({ body, client });
    expect(r).toBeInstanceOf(ChannelEphemeralZRespond);
    expect(r.source).toBe('channel_mention');
  });

  it('persistent DM bot message (is_ephemeral=false) still uses DmZRespond', () => {
    const body = {
      container: { channel_id: 'D123', is_ephemeral: false, message_ts: '222.2' },
      message: { ts: '222.2' },
      response_url: 'https://hooks.slack.com/actions/dm-persistent',
      user: { id: 'U1' },
    };
    const r = respondFromActionBody({ body, client });
    expect(r).toBeInstanceOf(DmZRespond);
  });
});

/* ------------------------------------------------------------------ *
 * DmZRespond.fromAction — branded ts validation
 * ------------------------------------------------------------------ */

describe('DmZRespond.fromAction', () => {
  const client = { chat: { update: vi.fn() } } as any;

  it('mints DmZRespond from a DM action body', () => {
    const r = DmZRespond.fromAction(
      {
        container: { channel_id: 'D9', message_ts: '500.1' },
        message: { ts: '500.1' },
      },
      client,
    );
    expect(r.source).toBe('dm');
  });

  it('throws when container channel is not a DM', () => {
    expect(() => DmZRespond.fromAction({ container: { channel_id: 'C9' }, message: { ts: '1' } }, client)).toThrow(
      /not a DM/,
    );
  });

  it('throws when message.ts is missing', () => {
    expect(() => DmZRespond.fromAction({ container: { channel_id: 'D9' } }, client)).toThrow(/missing message.ts/);
  });
});

/* ------------------------------------------------------------------ *
 * ZSettingsActionHandler — set / cancel / nav / modal flows
 * ------------------------------------------------------------------ */

function buildActionBody(opts: { source: 'dm' | 'channel' | 'slash'; actionId: string; userId?: string }) {
  const { source, actionId, userId = 'U1' } = opts;
  if (source === 'dm') {
    return {
      container: { channel_id: 'D1', message_ts: '111.1' },
      message: { ts: '111.1' },
      actions: [{ action_id: actionId, value: 'v' }],
      user: { id: userId },
      trigger_id: 't1',
    };
  }
  if (source === 'channel') {
    return {
      container: { channel_id: 'C1', thread_ts: '200.2' },
      response_url: 'https://hooks.slack.com/actions/xxx',
      actions: [{ action_id: actionId, value: 'v' }],
      user: { id: userId },
      trigger_id: 't1',
    };
  }
  // slash
  return {
    response_url: 'https://hooks.slack.com/commands/xxx',
    actions: [{ action_id: actionId, value: 'v' }],
    user: { id: userId },
    trigger_id: 't1',
  };
}

function makeRegistry(): {
  registry: ZTopicRegistry;
  apply: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  openModal: ReturnType<typeof vi.fn>;
  submitModal: ReturnType<typeof vi.fn>;
} {
  const apply = vi.fn(async () => ({
    ok: true,
    summary: '✅ Applied',
  }));
  const render = vi.fn(async () => ({
    text: 'card',
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'card' } }],
  }));
  const openModal = vi.fn(async () => undefined);
  const submitModal = vi.fn(async () => undefined);
  const binding: ZTopicBinding = {
    topic: 'persona',
    apply: apply as any,
    renderCard: render as any,
    openModal: openModal as any,
    submitModal: submitModal as any,
  };
  const registry = new ZTopicRegistry();
  registry.register(binding);
  return { registry, apply, render, openModal, submitModal };
}

describe('ZSettingsActionHandler.handleSet', () => {
  it('DM source: calls chat.update on replace (with stored botMessageTs)', async () => {
    const { registry, apply } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const chatUpdate = vi.fn().mockResolvedValue({});
    const client = { chat: { update: chatUpdate, postMessage: vi.fn() } } as any;
    const body = buildActionBody({ source: 'dm', actionId: 'z_setting_persona_set_linus' });
    await handler.handleSet(body, client);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'U1', value: 'linus', actionId: 'z_setting_persona_set_linus' }),
    );
    expect(chatUpdate).toHaveBeenCalledTimes(1);
    expect(chatUpdate.mock.calls[0][0]).toMatchObject({
      channel: 'D1',
      ts: '111.1',
    });
  });

  it('Channel source: posts to response_url with replace_original (no chat.update)', async () => {
    const { registry } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as any);
    const chatUpdate = vi.fn();
    const client = { chat: { update: chatUpdate } } as any;
    const body = buildActionBody({ source: 'channel', actionId: 'z_setting_persona_set_linus' });
    await handler.handleSet(body, client);
    expect(chatUpdate).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(payload.replace_original).toBe(true);
    expect(payload.blocks).toBeDefined();
    fetchSpy.mockRestore();
  });

  it('Slash source without response_url: uses SlashZRespond.respondFn', async () => {
    const { registry } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const respond = vi.fn().mockResolvedValue(undefined);
    const client = { chat: { update: vi.fn() } } as any;
    const body = {
      actions: [{ action_id: 'z_setting_persona_set_linus', value: 'v' }],
      user: { id: 'U1' },
    };
    await handler.handleSet(body, client, respond);
    expect(respond).toHaveBeenCalled();
    const call = respond.mock.calls[0][0];
    expect(call.replace_original).toBe(true);
  });

  it('dismiss:true → calls dismiss (delete_original) instead of replace', async () => {
    const apply = vi.fn(async () => ({ ok: true, summary: 'dismissed', dismiss: true }));
    const binding: ZTopicBinding = {
      topic: 'persona',
      apply: apply as any,
      renderCard: vi.fn() as any,
    };
    const registry = new ZTopicRegistry();
    registry.register(binding);
    const handler = new ZSettingsActionHandler({ registry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as any);
    const body = buildActionBody({ source: 'channel', actionId: 'z_setting_persona_set_linus' });
    await handler.handleSet(body, {} as any);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(payload.delete_original).toBe(true);
    fetchSpy.mockRestore();
  });

  it('unknown topic → logs and returns without throwing', async () => {
    const registry = new ZTopicRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const body = {
      actions: [{ action_id: 'z_setting_ghost_set_bar' }],
      user: { id: 'U1' },
      response_url: 'https://x',
    };
    await expect(handler.handleSet(body, {} as any)).resolves.toBeUndefined();
  });
});

describe('ZSettingsActionHandler.handleCancel', () => {
  it('DM source: calls chat.delete with stored botMessageTs', async () => {
    const { registry } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const chatDelete = vi.fn().mockResolvedValue({});
    const client = { chat: { delete: chatDelete, update: vi.fn(), postMessage: vi.fn() } } as any;
    const body = buildActionBody({ source: 'dm', actionId: 'z_setting_persona_cancel' });
    await handler.handleCancel(body, client);
    expect(chatDelete).toHaveBeenCalledWith({ channel: 'D1', ts: '111.1' });
  });

  it('Channel source: posts delete_original to response_url', async () => {
    const { registry } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as any);
    const body = buildActionBody({ source: 'channel', actionId: 'z_setting_persona_cancel' });
    await handler.handleCancel(body, {} as any);
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(payload.delete_original).toBe(true);
    fetchSpy.mockRestore();
  });
});

describe('ZSettingsActionHandler.handleHelpNav', () => {
  it('invokes binding.renderCard and replaces the message', async () => {
    const { registry, render } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const chatUpdate = vi.fn().mockResolvedValue({});
    const client = { chat: { update: chatUpdate, postMessage: vi.fn() } } as any;
    const body = buildActionBody({ source: 'dm', actionId: 'z_help_nav_persona' });
    await handler.handleHelpNav(body, client);
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U1', issuedAt: expect.any(Number) }));
    expect(chatUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('ZSettingsActionHandler.handleOpenModal', () => {
  it('delegates to binding.openModal with trigger_id', async () => {
    const { registry, openModal } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const client = {} as any;
    const body = buildActionBody({
      source: 'channel',
      actionId: 'z_setting_persona_open_modal',
    });
    await handler.handleOpenModal(body, client);
    expect(openModal).toHaveBeenCalledWith(expect.objectContaining({ triggerId: 't1', userId: 'U1' }));
  });

  it('is a no-op when topic has no openModal', async () => {
    const registry = new ZTopicRegistry();
    registry.register({
      topic: 'ro',
      apply: vi.fn() as any,
      renderCard: vi.fn() as any,
    });
    const handler = new ZSettingsActionHandler({ registry });
    const body = {
      actions: [{ action_id: 'z_setting_ro_open_modal' }],
      user: { id: 'U1' },
      trigger_id: 't',
    };
    await expect(handler.handleOpenModal(body, {} as any)).resolves.toBeUndefined();
  });
});

describe('ZSettingsActionHandler.handleModalSubmit', () => {
  it('invokes binding.submitModal with parsed values', async () => {
    const { registry, submitModal } = makeRegistry();
    const handler = new ZSettingsActionHandler({ registry });
    const body = {
      view: {
        callback_id: 'z_setting_persona_modal_submit',
        state: { values: { block1: { input1: { value: 'foo' } } } },
      },
      user: { id: 'U1' },
    };
    await handler.handleModalSubmit(body, {} as any);
    expect(submitModal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'U1',
        values: { block1: { input1: { value: 'foo' } } },
      }),
    );
  });
});
