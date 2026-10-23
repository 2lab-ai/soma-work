import { describe, expect, it } from 'vitest';
import { productionSettingsRegistry } from '../user-settings-registry-production';
import { userSettingsStore } from '../user-settings-store';

// SSOT 2026-10-23 T2 — the wired registry runs against the real store and the
// real `/z` apply functions (vitest setup pins DATA_DIR to a scratch dir).
describe('production settings registry', () => {
  it('reads every row for a user and round-trips a write through the real store', async () => {
    const registry = productionSettingsRegistry();
    const snap = registry.read('UREGPROD1');
    expect(snap.settings).toHaveLength(17);
    expect(snap.settings.find((s) => s.key === 'persona')!.options!.map((o) => o.value)).toContain('default');

    const row = await registry.write('UREGPROD1', 'defaultEffort', 'low');
    expect(row).toMatchObject({ key: 'defaultEffort', value: 'low', modified: true });
    expect(userSettingsStore.getUserDefaultEffort('UREGPROD1')).toBe('low');

    await registry.write('UREGPROD1', 'logVerbosity', 'detail');
    expect(userSettingsStore.getUserDefaultLogVerbosity('UREGPROD1')).toBe('detail');

    await expect(registry.write('UREGPROD1', 'persona', 'no-such-persona')).rejects.toMatchObject({ statusCode: 400 });
    await expect(registry.write('UREGPROD1', 'sandbox', false)).rejects.toMatchObject({ statusCode: 403 });
  });
});
