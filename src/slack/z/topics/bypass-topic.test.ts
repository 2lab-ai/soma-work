import { describe, expect, it, vi } from 'vitest';
import { applyBypass, createBypassTopicBinding, renderBypassCard } from './bypass-topic';

vi.mock('../../../user-settings-store', () => {
  const store: Record<string, boolean> = {};
  return {
    userSettingsStore: {
      getUserBypassPermission: (u: string) => store[u] ?? false,
      setUserBypassPermission: (u: string, v: boolean) => {
        store[u] = v;
      },
    },
  };
});

describe('bypass-topic.renderBypassCard', () => {
  it('renders on/off buttons and cancel', async () => {
    const { blocks, text } = await renderBypassCard({ userId: 'U1', issuedAt: 10 });
    expect(text).toContain('Bypass');
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    expect(ids).toContain('z_setting_bypass_set_on');
    expect(ids).toContain('z_setting_bypass_set_off');
    expect(ids).toContain('z_setting_bypass_cancel');
  });

  it('header shows current state', async () => {
    const { blocks } = await renderBypassCard({ userId: 'U1', issuedAt: 1 });
    const ctxBlock = (blocks as any[]).find((b) => b.type === 'context' && b.elements?.[0]?.text?.includes('Current'));
    expect(ctxBlock).toBeDefined();
    expect(ctxBlock.elements[0].text).toContain('OFF');
  });
});

describe('bypass-topic.applyBypass', () => {
  it('sets ON', async () => {
    const r = await applyBypass({ userId: 'U1', value: 'on' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('ON');
  });

  it('sets OFF', async () => {
    const r = await applyBypass({ userId: 'U2', value: 'OFF' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('OFF');
  });

  it('rejects unknown value', async () => {
    const r = await applyBypass({ userId: 'U1', value: 'maybe' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Expected');
  });
});

describe('createBypassTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createBypassTopicBinding();
    expect(b.topic).toBe('bypass');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
