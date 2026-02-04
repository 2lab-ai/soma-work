import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { resolvePermissionServerPath } from './mcp-config-builder';

describe('resolvePermissionServerPath', () => {
  it('prefers runtime extension when present', () => {
    const baseDir = '/app/dist';
    const runtimeExt = '.js';
    const preferred = path.join(baseDir, 'permission-mcp-server.js');
    const fallback = path.join(baseDir, 'permission-mcp-server.ts');
    const existsSync = vi.fn((candidate: string) => candidate === preferred);

    const result = resolvePermissionServerPath(baseDir, runtimeExt, existsSync);

    expect(result.resolvedPath).toBe(preferred);
    expect(result.fallbackUsed).toBe(false);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });

  it('falls back when runtime extension is missing', () => {
    const baseDir = '/app/src';
    const runtimeExt = '.js';
    const preferred = path.join(baseDir, 'permission-mcp-server.js');
    const fallback = path.join(baseDir, 'permission-mcp-server.ts');
    const existsSync = vi.fn((candidate: string) => candidate === fallback);

    const result = resolvePermissionServerPath(baseDir, runtimeExt, existsSync);

    expect(result.resolvedPath).toBe(fallback);
    expect(result.fallbackUsed).toBe(true);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });

  it('returns null when neither file exists', () => {
    const baseDir = '/app/missing';
    const runtimeExt = '.ts';
    const preferred = path.join(baseDir, 'permission-mcp-server.ts');
    const fallback = path.join(baseDir, 'permission-mcp-server.js');
    const existsSync = vi.fn(() => false);

    const result = resolvePermissionServerPath(baseDir, runtimeExt, existsSync);

    expect(result.resolvedPath).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    expect(result.triedPaths).toEqual([preferred, fallback]);
  });
});
