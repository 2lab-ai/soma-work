import { describe, expect, it } from 'vitest';
import { hasRequiredScopes, missingScopes, REQUIRED_OAUTH_SCOPES } from '../scope-check';

describe('scope-check', () => {
  it('exposes REQUIRED_OAUTH_SCOPES containing user:profile', () => {
    expect(REQUIRED_OAUTH_SCOPES).toContain('user:profile');
  });

  describe('hasRequiredScopes', () => {
    it('returns true when all required scopes are present', () => {
      expect(hasRequiredScopes(['user:profile'])).toBe(true);
    });

    it('returns true when extra unrelated scopes are present', () => {
      expect(hasRequiredScopes(['user:profile', 'user:inference', 'org:read'])).toBe(true);
    });

    it('returns false when user:profile is missing', () => {
      expect(hasRequiredScopes(['user:inference'])).toBe(false);
    });

    it('returns false for an empty scope list', () => {
      expect(hasRequiredScopes([])).toBe(false);
    });
  });

  describe('missingScopes', () => {
    it('returns empty array when all scopes present', () => {
      expect(missingScopes(['user:profile'])).toEqual([]);
    });

    it('returns user:profile when missing', () => {
      expect(missingScopes(['user:inference'])).toEqual(['user:profile']);
    });

    it('returns all required scopes for empty input', () => {
      expect(missingScopes([])).toEqual([...REQUIRED_OAUTH_SCOPES]);
    });

    it('ignores unrelated extra scopes', () => {
      expect(missingScopes(['user:profile', 'extra:scope'])).toEqual([]);
    });
  });
});
