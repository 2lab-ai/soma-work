import { describe, expect, it, vi } from 'vitest';
import { applyVerbosity, renderVerbosityCard } from '../verbosity-topic';

vi.mock('../../../../user-settings-store', async () => {
  const actual = await vi.importActual<typeof import('../../../../user-settings-store')>(
    '../../../../user-settings-store',
  );
  const store: Record<string, any> = {};
  return {
    ...actual,
    userSettingsStore: {
      getUserDefaultLogVerbosity: (u: string) => store[u] ?? 'minimal',
      setUserDefaultLogVerbosity: (u: string, v: string) => {
        store[u] = v;
      },
      resolveVerbosityInput: (raw: string) => {
        const lower = raw.toLowerCase();
        return ['minimal', 'compact', 'detail', 'verbose'].includes(lower) ? lower : null;
      },
    },
  };
});

describe('verbosity-topic.renderVerbosityCard', () => {
  it('exposes four levels as set buttons', async () => {
    const { blocks } = await renderVerbosityCard({ userId: 'U1', issuedAt: 1 });
    const ids: string[] = [];
    for (const b of blocks as any[]) {
      if (b.type === 'actions') for (const e of b.elements) ids.push(e.action_id);
    }
    for (const lvl of ['minimal', 'compact', 'detail', 'verbose']) {
      expect(ids).toContain(`z_setting_verbosity_set_${lvl}`);
    }
  });
});

describe('verbosity-topic.applyVerbosity', () => {
  it('accepts valid level', async () => {
    const r = await applyVerbosity({ userId: 'U1', value: 'detail' });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown level', async () => {
    const r = await applyVerbosity({ userId: 'U1', value: 'ultra' });
    expect(r.ok).toBe(false);
  });
});
