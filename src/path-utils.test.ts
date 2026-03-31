import { describe, expect, it } from 'vitest';
import { normalizeTmpPath } from './path-utils';

describe('normalizeTmpPath', () => {
  // Trace: Scenario 3, Section 3a — /private/tmp → /tmp conversion
  it('converts /private/tmp/ prefix to /tmp/', () => {
    expect(normalizeTmpPath('/private/tmp/U094E5L4A15/soma-work')).toBe('/tmp/U094E5L4A15/soma-work');
  });

  // Trace: Scenario 3, Section 3a — already /tmp stays unchanged
  it('leaves /tmp/ paths unchanged', () => {
    expect(normalizeTmpPath('/tmp/U094E5L4A15/soma-work')).toBe('/tmp/U094E5L4A15/soma-work');
  });

  // Trace: Scenario 3, Section 5 — non /tmp paths unchanged
  it('leaves non-tmp paths unchanged', () => {
    expect(normalizeTmpPath('/home/user/project')).toBe('/home/user/project');
  });

  // Trace: Scenario 3, Section 3a — exact /private/tmp (no trailing slash)
  it('converts exact /private/tmp to /tmp', () => {
    expect(normalizeTmpPath('/private/tmp')).toBe('/tmp');
  });

  // Edge: deeply nested /private/tmp path
  it('handles deeply nested /private/tmp paths', () => {
    expect(normalizeTmpPath('/private/tmp/a/b/c/d')).toBe('/tmp/a/b/c/d');
  });

  // Edge: /private/tmp/ with trailing slash preserves slash
  it('normalizes /private/tmp/ (trailing slash) to /tmp/', () => {
    expect(normalizeTmpPath('/private/tmp/')).toBe('/tmp/');
  });

  // Edge: /private/tmpdata should NOT be normalized (false prefix match)
  it('does not normalize /private/tmpdata (not a /tmp subpath)', () => {
    expect(normalizeTmpPath('/private/tmpdata/foo')).toBe('/private/tmpdata/foo');
  });

  // Edge: empty string returns empty string
  it('returns empty string for empty input', () => {
    expect(normalizeTmpPath('')).toBe('');
  });
});
