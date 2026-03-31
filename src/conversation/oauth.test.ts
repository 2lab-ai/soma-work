import * as jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  conversation: {
    viewerUrl: 'http://localhost:3000',
    viewerPort: 3000,
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: 'test-jwt-secret',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../config', () => ({ config: mockConfig }));

describe('OAuth module', () => {
  let verifyDashboardToken: typeof import('./oauth').verifyDashboardToken;
  let getDashboardUser: typeof import('./oauth').getDashboardUser;
  let setOAuthUserLookup: typeof import('./oauth').setOAuthUserLookup;

  beforeEach(async () => {
    vi.resetModules();
    const oauth = await import('./oauth');
    verifyDashboardToken = oauth.verifyDashboardToken;
    getDashboardUser = oauth.getDashboardUser;
    setOAuthUserLookup = oauth.setOAuthUserLookup;
  });

  describe('verifyDashboardToken', () => {
    it('should verify a valid JWT', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );

      const user = verifyDashboardToken(token);
      expect(user).not.toBeNull();
      expect(user!.slackUserId).toBe('U123');
      expect(user!.email).toBe('alice@test.com');
      expect(user!.name).toBe('Alice');
      expect(user!.provider).toBe('google');
    });

    it('should return null for invalid JWT', () => {
      expect(verifyDashboardToken('invalid-token')).toBeNull();
    });

    it('should return null for expired JWT', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'test-jwt-secret',
        { expiresIn: -10 }, // already expired
      );

      expect(verifyDashboardToken(token)).toBeNull();
    });

    it('should return null for wrong secret', () => {
      const token = jwt.sign(
        { sub: 'U123', email: 'alice@test.com', name: 'Alice', provider: 'google' },
        'wrong-secret',
      );

      expect(verifyDashboardToken(token)).toBeNull();
    });
  });

  describe('getDashboardUser', () => {
    it('should extract user from cookie header', () => {
      const token = jwt.sign(
        { sub: 'U456', email: 'bob@test.com', name: 'Bob', provider: 'microsoft' },
        'test-jwt-secret',
        { expiresIn: 3600 },
      );

      const mockRequest = {
        headers: {
          cookie: `soma_dash_token=${encodeURIComponent(token)}; other=value`,
        },
      } as any;

      const user = getDashboardUser(mockRequest);
      expect(user).not.toBeNull();
      expect(user!.slackUserId).toBe('U456');
      expect(user!.provider).toBe('microsoft');
    });

    it('should return null when no cookie', () => {
      const mockRequest = { headers: {} } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });

    it('should return null when cookie has no soma_dash_token', () => {
      const mockRequest = { headers: { cookie: 'other=value' } } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });

    it('should return null when cookie has invalid JWT', () => {
      const mockRequest = {
        headers: { cookie: 'soma_dash_token=bad-jwt-token' },
      } as any;
      expect(getDashboardUser(mockRequest)).toBeNull();
    });
  });

  describe('setOAuthUserLookup', () => {
    it('should register and use lookup function', () => {
      // This tests the lookup registration — actual matching is done in index.ts
      // Just verify the function can be called without error
      setOAuthUserLookup((email: string) => {
        if (email === 'alice@test.com') return { userId: 'U123', name: 'Alice' };
        return null;
      });
      // No assertion needed — just verifying no throw
    });
  });
});
