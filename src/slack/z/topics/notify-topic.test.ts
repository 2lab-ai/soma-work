import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => {
  const store: Record<string, { slackDm?: boolean; telegramChatId?: string; webhookUrl?: string }> = {};
  return {
    userSettingsStore: {
      getUserSettings: (u: string) => ({ userId: u, notification: { ...(store[u] ?? {}) } }),
      patchNotification: (u: string, patch: any) => {
        store[u] = { ...(store[u] ?? {}), ...patch };
      },
    },
  };
});

import {
  applyNotify,
  buildNotifyTelegramModal,
  createNotifyTopicBinding,
  renderNotifyCard,
  submitNotifyModal,
} from './notify-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  }
  return out;
}

describe('notify-topic.renderNotifyCard', () => {
  it('renders dm_on/dm_off/tg_clear + open_modal + cancel', async () => {
    const { blocks, text } = await renderNotifyCard({ userId: 'U1', issuedAt: 10 });
    expect(text).toContain('Notifications');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_notify_set_dm_on');
    expect(ids).toContain('z_setting_notify_set_dm_off');
    expect(ids).toContain('z_setting_notify_set_tg_clear');
    expect(ids).toContain('z_setting_notify_open_modal');
    expect(ids).toContain('z_setting_notify_cancel');
  });
});

describe('notify-topic.applyNotify', () => {
  it('dm_on sets slackDm=true', async () => {
    const r = await applyNotify({ userId: 'U1', value: 'dm_on' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('ON');
  });

  it('dm_off sets slackDm=false', async () => {
    const r = await applyNotify({ userId: 'U1', value: 'dm_off' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('OFF');
  });

  it('tg_clear removes telegram chat id', async () => {
    const r = await applyNotify({ userId: 'U1', value: 'tg_clear' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('해제');
  });

  it('rejects unknown value', async () => {
    const r = await applyNotify({ userId: 'U1', value: 'xxx' });
    expect(r.ok).toBe(false);
  });
});

describe('notify-topic.buildNotifyTelegramModal', () => {
  it('produces a modal with callback_id and chat-id input', () => {
    const view = buildNotifyTelegramModal();
    expect(view.callback_id).toBe('z_setting_notify_modal_submit');
    const input = view.blocks.find((b: any) => b.block_id === 'notify_tg_chat');
    expect(input).toBeDefined();
    expect(input.element.type).toBe('plain_text_input');
  });
});

describe('notify-topic.submitNotifyModal', () => {
  const fakeClient = {
    chat: { postMessage: vi.fn().mockResolvedValue({}) },
  } as any;

  it('rejects empty input', async () => {
    const r = await submitNotifyModal({
      client: fakeClient,
      userId: 'U1',
      values: { notify_tg_chat: { value: { value: '' } } },
    });
    expect(r.ok).toBe(false);
  });

  it('rejects non-numeric input', async () => {
    const r = await submitNotifyModal({
      client: fakeClient,
      userId: 'U1',
      values: { notify_tg_chat: { value: { value: 'not-a-number' } } },
    });
    expect(r.ok).toBe(false);
  });

  it('accepts numeric chat id', async () => {
    const r = await submitNotifyModal({
      client: fakeClient,
      userId: 'U1',
      values: { notify_tg_chat: { value: { value: '123456789' } } },
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('123456789');
  });
});

describe('createNotifyTopicBinding', () => {
  it('exposes topic + apply + renderCard + openModal + submitModal', () => {
    const b = createNotifyTopicBinding();
    expect(b.topic).toBe('notify');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
    expect(typeof b.openModal).toBe('function');
    expect(typeof b.submitModal).toBe('function');
  });
});
