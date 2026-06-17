import { describe, expect, it, vi } from 'vitest';
import { applyBypass, createBypassTopicBinding, normalizePermissionModeValue, renderBypassCard } from '../bypass-topic';

vi.mock('../../../../user-settings-store', () => {
  const store: Record<string, string> = {};
  return {
    userSettingsStore: {
      getUserPermissionMode: (u: string) => (store[u] as string) ?? 'auto',
      setUserPermissionMode: (u: string, v: string) => {
        store[u] = v;
      },
    },
  };
});

describe('bypass-topic.renderBypassCard (permission mode)', () => {
  it('renders auto + bypass buttons and cancel (legacy NOT offered)', async () => {
    const { blocks, text } = await renderBypassCard({ userId: 'U1', issuedAt: 10 });
    expect(text).toContain('Permission Mode');
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    expect(ids).toContain('z_setting_bypass_set_auto');
    expect(ids).toContain('z_setting_bypass_set_bypass');
    expect(ids).toContain('z_setting_bypass_cancel');
    expect(ids).not.toContain('z_setting_bypass_set_legacy');
  });

  it('header shows current mode (default AUTO)', async () => {
    const { blocks } = await renderBypassCard({ userId: 'U1', issuedAt: 1 });
    const ctxBlock = (blocks as any[]).find((b) => b.type === 'context' && b.elements?.[0]?.text?.includes('Current'));
    expect(ctxBlock).toBeDefined();
    expect(ctxBlock.elements[0].text).toContain('AUTO');
  });
});

describe('normalizePermissionModeValue', () => {
  it('maps legacy on/off aliases', () => {
    expect(normalizePermissionModeValue('on')).toBe('bypass');
    expect(normalizePermissionModeValue('off')).toBe('auto');
  });
  it('accepts explicit modes', () => {
    expect(normalizePermissionModeValue('auto')).toBe('auto');
    expect(normalizePermissionModeValue('bypass')).toBe('bypass');
    expect(normalizePermissionModeValue('legacy')).toBe('legacy');
  });
  it('rejects garbage', () => {
    expect(normalizePermissionModeValue('maybe')).toBeNull();
  });
});

describe('bypass-topic.applyBypass', () => {
  it('sets bypass (via legacy "on")', async () => {
    const r = await applyBypass({ userId: 'U1', value: 'on' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('BYPASS');
  });

  it('sets auto (via legacy "off")', async () => {
    const r = await applyBypass({ userId: 'U2', value: 'OFF' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('AUTO');
  });

  it('sets auto + bypass directly', async () => {
    expect((await applyBypass({ userId: 'U3', value: 'auto' })).summary).toContain('AUTO');
    expect((await applyBypass({ userId: 'U3', value: 'bypass' })).summary).toContain('BYPASS');
  });

  it('honours the legacy escape hatch', async () => {
    const r = await applyBypass({ userId: 'U4', value: 'legacy' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('LEGACY');
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
