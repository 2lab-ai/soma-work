import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: { getUserAutoskills: vi.fn(() => []) },
}));

vi.mock('../../skill-locator', () => ({
  resolveAutoskillContent: vi.fn(),
}));

import { resolveAutoskillContent } from '../../skill-locator';
import { userSettingsStore } from '../../user-settings-store';
import { buildAutoskillFire } from '../autoskill-fire';

const U = 'U_FIRE';

describe('buildAutoskillFire', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  it('returns null when the user has no autoskills', () => {
    expect(buildAutoskillFire(U, '<@U_FIRE>')).toBeNull();
    expect(resolveAutoskillContent).not.toHaveBeenCalled();
  });

  it('returns null when no registered name resolves', () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['ghost']);
    vi.mocked(resolveAutoskillContent).mockReturnValue(null);
    expect(buildAutoskillFire(U, '<@U_FIRE>')).toBeNull();
  });

  it('builds an <invoked_skills> block mirroring the $skill format', () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot', 'using-govuk']);
    vi.mocked(resolveAutoskillContent).mockImplementation((name: string) =>
      name === 'using-ssot'
        ? { key: 'local:using-ssot', content: 'SSOT BODY' }
        : { key: 'local:using-govuk', content: 'GOVUK BODY' },
    );

    const fire = buildAutoskillFire(U, '<@U_FIRE>');
    expect(fire).not.toBeNull();
    expect(fire?.keys).toEqual(['local:using-ssot', 'local:using-govuk']);
    expect(fire?.invokedBlock).toBe(
      '<invoked_skills>\n' +
        '<local:using-ssot>\nSSOT BODY\n</local:using-ssot>\n' +
        '<local:using-govuk>\nGOVUK BODY\n</local:using-govuk>\n' +
        '</invoked_skills>',
    );
    // Banner is a red RPG attachment that names the caster + skills.
    expect(fire?.banner.color).toBe('#FF0000');
    expect(fire?.banner.text).toContain('<@U_FIRE>');
    expect(fire?.banner.text).toContain('강제 발동');
  });

  it('skips unresolvable names but still fires the resolvable subset', () => {
    vi.mocked(userSettingsStore.getUserAutoskills).mockReturnValue(['using-ssot', 'ghost']);
    vi.mocked(resolveAutoskillContent).mockImplementation((name: string) =>
      name === 'using-ssot' ? { key: 'local:using-ssot', content: 'SSOT BODY' } : null,
    );

    const fire = buildAutoskillFire(U, '<@U_FIRE>');
    expect(fire?.keys).toEqual(['local:using-ssot']);
    expect(fire?.invokedBlock).toContain('local:using-ssot');
    expect(fire?.invokedBlock).not.toContain('ghost');
  });
});
