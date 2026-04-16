import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => {
  const store: Record<string, string | undefined> = {};
  return {
    userSettingsStore: {
      getUserEmail: (u: string) => store[u],
      setUserEmail: (u: string, v: string) => {
        store[u] = v || undefined;
      },
    },
  };
});

import { applyEmail, buildEmailModal, createEmailTopicBinding, renderEmailCard, submitEmailModal } from './email-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  return out;
}

describe('email-topic.renderEmailCard', () => {
  it('no email set → open_modal + cancel; text contains "설정되지 않음"', async () => {
    const { blocks, text } = await renderEmailCard({ userId: 'U_new', issuedAt: 1 });
    expect(text).toContain('설정되지 않음');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_email_open_modal');
    expect(ids).toContain('z_setting_email_cancel');
  });

  it('email set → clear + open_modal + cancel', async () => {
    await applyEmail({ userId: 'U_set', value: 'alice@example.com' });
    const { blocks, text } = await renderEmailCard({ userId: 'U_set', issuedAt: 2 });
    expect(text).toContain('alice@example.com');
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_email_set_clear');
    expect(ids).toContain('z_setting_email_open_modal');
  });
});

describe('email-topic.applyEmail', () => {
  it('clear removes email', async () => {
    await applyEmail({ userId: 'U_c', value: 'bob@example.com' });
    const r = await applyEmail({ userId: 'U_c', value: 'clear' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('삭제');
  });

  it('rejects invalid email format', async () => {
    const r = await applyEmail({ userId: 'U1', value: 'not-an-email' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('잘못된');
  });

  it('accepts valid email', async () => {
    const r = await applyEmail({ userId: 'U1', value: 'carol@example.com' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('carol@example.com');
  });
});

describe('email-topic.buildEmailModal', () => {
  it('produces modal without initial_value when unset', () => {
    const view = buildEmailModal(undefined);
    expect(view.callback_id).toBe('z_setting_email_modal_submit');
    const input = view.blocks[0].element;
    expect(input.type).toBe('plain_text_input');
    expect(input.initial_value).toBeUndefined();
  });

  it('produces modal with initial_value when set', () => {
    const view = buildEmailModal('x@y.com');
    expect(view.blocks[0].element.initial_value).toBe('x@y.com');
  });
});

describe('email-topic.submitEmailModal', () => {
  const fakeClient = { chat: { postMessage: vi.fn().mockResolvedValue({}) } } as any;

  it('rejects invalid input', async () => {
    const r = await submitEmailModal({
      client: fakeClient,
      userId: 'U1',
      values: { email_value: { value: { value: 'bogus' } } },
    });
    expect(r.ok).toBe(false);
  });

  it('accepts valid input', async () => {
    const r = await submitEmailModal({
      client: fakeClient,
      userId: 'U1',
      values: { email_value: { value: { value: 'dave@example.com' } } },
    });
    expect(r.ok).toBe(true);
  });
});

describe('createEmailTopicBinding', () => {
  it('exposes all hooks', () => {
    const b = createEmailTopicBinding();
    expect(b.topic).toBe('email');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
    expect(typeof b.openModal).toBe('function');
    expect(typeof b.submitModal).toBe('function');
  });
});
