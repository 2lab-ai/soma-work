import { describe, expect, it } from 'vitest';
import { productionSettingsRegistry } from '../user-settings-registry-production';
import { userSettingsStore } from '../user-settings-store';

// SSOT 2026-10-23 T2 — the wired registry runs against the real store and the
// real `/z` apply functions (vitest setup pins DATA_DIR to a scratch dir).
describe('production settings registry', () => {
  it('reads every row for a user and round-trips a write through the real store', async () => {
    const registry = productionSettingsRegistry();
    userSettingsStore.ensureUserExists('UREGPROD1', 'Prod One');
    const snap = registry.read('UREGPROD1');
    expect(snap.settings).toHaveLength(20);
    expect(snap.settings.find((s) => s.key === 'persona')!.options!.map((o) => o.value)).toContain('default');

    const row = await registry.write('UREGPROD1', 'defaultEffort', 'low');
    expect(row).toMatchObject({ key: 'defaultEffort', value: 'low', modified: true });
    expect(userSettingsStore.getUserDefaultEffort('UREGPROD1')).toBe('low');

    await registry.write('UREGPROD1', 'logVerbosity', 'detail');
    expect(userSettingsStore.getUserDefaultLogVerbosity('UREGPROD1')).toBe('detail');

    // The dashboard's view (SSOT 2026-11-01): minimal until the user picks advanced, through the real store.
    expect(snap.settings.find((s) => s.key === 'dashboardMode')!.value).toBe('minimal');
    await registry.write('UREGPROD1', 'dashboardMode', 'advanced');
    expect(userSettingsStore.getUserDashboardMode('UREGPROD1')).toBe('advanced');

    await expect(registry.write('UREGPROD1', 'persona', 'no-such-persona')).rejects.toMatchObject({ statusCode: 400 });
    await expect(registry.write('UREGPROD1', 'sandbox', false)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('every model the top bar offers saves through the real /z model apply (nicknames resolve to their ids)', async () => {
    const registry = productionSettingsRegistry();
    userSettingsStore.ensureUserExists('UREGPROD2', 'Prod Two');
    const options = registry.read('UREGPROD2').settings.find((s) => s.key === 'defaultModel')?.options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      const row = await registry.write('UREGPROD2', 'defaultModel', o.value);
      expect(row.value, o.value).toBe(o.value);
    }
  });

  it('a denied user (record removed by an admin) cannot re-create an accepted record through a settings write', async () => {
    const registry = productionSettingsRegistry();
    userSettingsStore.createPendingUser('UREGPROD3', 'Pending');
    await expect(registry.write('UREGPROD3', 'defaultEffort', 'low')).rejects.toMatchObject({ statusCode: 403 });
    expect(userSettingsStore.isUserAccepted('UREGPROD3')).toBe(false);
    userSettingsStore.removeUserSettings('UREGPROD3');
    await expect(registry.write('UREGPROD3', 'defaultEffort', 'low')).rejects.toMatchObject({ statusCode: 403 });
    expect(userSettingsStore.isUserAccepted('UREGPROD3')).toBe(false);
  });
});
