import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../admin-utils', () => ({
  isAdminUser: vi.fn(),
}));

vi.mock('../../../user-settings-store', () => {
  const store: Record<string, { sandbox?: boolean; network?: boolean }> = {};
  return {
    userSettingsStore: {
      getUserSandboxDisabled: (u: string) => store[u]?.sandbox ?? false,
      setUserSandboxDisabled: (u: string, v: boolean) => {
        store[u] = { ...(store[u] ?? {}), sandbox: v };
      },
      getUserNetworkDisabled: (u: string) => store[u]?.network ?? false,
      setUserNetworkDisabled: (u: string, v: boolean) => {
        store[u] = { ...(store[u] ?? {}), network: v };
      },
    },
  };
});

import { isAdminUser } from '../../../admin-utils';
import { applySandbox, createSandboxTopicBinding, renderSandboxCard } from './sandbox-topic';

function actionIds(blocks: any[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'actions') for (const e of b.elements) out.push(e.action_id);
  }
  return out;
}

describe('sandbox-topic.renderSandboxCard', () => {
  it('hides admin-only on/off buttons for non-admins', async () => {
    vi.mocked(isAdminUser).mockReturnValue(false);
    const { blocks, text } = await renderSandboxCard({ userId: 'U1', issuedAt: 1 });
    expect(text).toContain('Sandbox');
    const ids = actionIds(blocks);
    expect(ids).not.toContain('z_setting_sandbox_set_on');
    expect(ids).not.toContain('z_setting_sandbox_set_off');
    expect(ids).toContain('z_setting_sandbox_set_network_on');
    expect(ids).toContain('z_setting_sandbox_set_network_off');
    expect(ids).toContain('z_setting_sandbox_cancel');
  });

  it('exposes on/off buttons for admins', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const { blocks } = await renderSandboxCard({ userId: 'U1', issuedAt: 2 });
    const ids = actionIds(blocks);
    expect(ids).toContain('z_setting_sandbox_set_on');
    expect(ids).toContain('z_setting_sandbox_set_off');
  });
});

describe('sandbox-topic.applySandbox', () => {
  it('non-admin cannot toggle sandbox on/off', async () => {
    vi.mocked(isAdminUser).mockReturnValue(false);
    const r = await applySandbox({ userId: 'U1', value: 'off' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Admin');
  });

  it('admin can turn sandbox off', async () => {
    vi.mocked(isAdminUser).mockReturnValue(true);
    const r = await applySandbox({ userId: 'U1', value: 'off' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('OFF');
  });

  it('anyone can toggle network allowlist', async () => {
    vi.mocked(isAdminUser).mockReturnValue(false);
    const r = await applySandbox({ userId: 'U1', value: 'network_off' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('Network');
  });

  it('rejects unknown value', async () => {
    const r = await applySandbox({ userId: 'U1', value: 'maybe' });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain('Unknown');
  });
});

describe('createSandboxTopicBinding', () => {
  it('exposes topic + apply + renderCard', () => {
    const b = createSandboxTopicBinding();
    expect(b.topic).toBe('sandbox');
    expect(typeof b.apply).toBe('function');
    expect(typeof b.renderCard).toBe('function');
  });
});
