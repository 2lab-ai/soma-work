/**
 * RED (autoz): Permission-mode SSOT — tri-state mode model.
 *
 * SSOT-2/SSOT-3: the permission mode is `auto` (default) | `bypass` (unsafe) |
 * `legacy` (the old direct accept/reject, no longer user-selectable). The
 * default for any user without an explicit mode is `auto`. Legacy callers that
 * only stored the boolean `bypassPermission` migrate: `true → bypass`, else the
 * new default `auto`.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
  resolvePermissionMode,
  SELECTABLE_PERMISSION_MODES,
} from '../permission-mode';

describe('permission-mode SSOT', () => {
  it('default mode is auto (SSOT-1)', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('auto');
  });

  it('only auto + bypass are user-selectable; legacy is NOT (SSOT-3)', () => {
    expect([...SELECTABLE_PERMISSION_MODES].sort()).toEqual(['auto', 'bypass']);
    expect(SELECTABLE_PERMISSION_MODES).not.toContain('legacy');
  });

  it('isPermissionMode guards the union', () => {
    for (const m of ['auto', 'bypass', 'legacy'] as PermissionMode[]) {
      expect(isPermissionMode(m)).toBe(true);
    }
    expect(isPermissionMode('on')).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
  });

  describe('resolvePermissionMode — migration + default', () => {
    it('no stored fields → auto (the new default)', () => {
      expect(resolvePermissionMode(undefined)).toBe('auto');
      expect(resolvePermissionMode({})).toBe('auto');
    });

    it('explicit permissionMode wins over the legacy boolean', () => {
      expect(resolvePermissionMode({ permissionMode: 'legacy', bypassPermission: true })).toBe('legacy');
      expect(resolvePermissionMode({ permissionMode: 'auto', bypassPermission: true })).toBe('auto');
      expect(resolvePermissionMode({ permissionMode: 'bypass' })).toBe('bypass');
    });

    it('legacy bypass boolean: true → bypass, false/undefined → auto', () => {
      expect(resolvePermissionMode({ bypassPermission: true })).toBe('bypass');
      expect(resolvePermissionMode({ bypassPermission: false })).toBe('auto');
    });

    it('ignores a malformed stored permissionMode and falls through', () => {
      expect(resolvePermissionMode({ permissionMode: 'garbage', bypassPermission: true })).toBe('bypass');
      expect(resolvePermissionMode({ permissionMode: 'garbage' })).toBe('auto');
    });
  });
});
