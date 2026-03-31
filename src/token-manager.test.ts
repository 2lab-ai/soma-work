import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract tests derived from docs/cct-token-rotation/trace.md
// All tests should FAIL (RED) until implementation

describe('TokenManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // === Scenario 1: Token Initialization ===

  describe('initialize', () => {
    // Trace: Scenario 1, Step 3
    it('should load multiple tokens from CLAUDE_CODE_OAUTH_TOKEN_LIST', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(3);
      expect(tokens[0].name).toBe('cct1');
      expect(tokens[1].name).toBe('cct2');
      expect(tokens[2].name).toBe('cct3');
    });

    // Trace: Scenario 1, Step 2
    it('should fallback to single CLAUDE_CODE_OAUTH_TOKEN', async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'singleToken';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].name).toBe('cct1');
      expect(tokens[0].value).toBe('singleToken');
    });

    // Trace: Scenario 1, Error path 3
    it('should handle no tokens gracefully', async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(0);
    });

    // Trace: Scenario 1, Step 4
    it('should apply first token to process.env', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tokenA');
    });

    // Trace: Scenario 1, Step 3 edge
    it('should filter empty entries from comma-separated list', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,,tokenB,,,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(3);
    });
  });

  // === Scenario 3: set_cct Manual Switch ===

  describe('setActiveToken', () => {
    // Trace: Scenario 3, Step 2
    it('should switch active token by name', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const result = tokenManager.setActiveToken('cct2');
      expect(result).toBe(true);
      expect(tokenManager.getActiveToken().name).toBe('cct2');
    });

    // Trace: Scenario 3, Step 2 applyToken
    it('should update process.env on switch', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      tokenManager.setActiveToken('cct2');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tokenB');
    });

    // Trace: Scenario 3, Step 2 clear cooldown
    it('should clear cooldown on target token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // First, set a cooldown on cct2 via rotation
      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      // Now manually switch back to cct1 (which has cooldown)
      // But test cct2 — set cooldown manually via rotation from cct2
      tokenManager.rotateOnRateLimit('tokenB', new Date(Date.now() + 3600000));

      // Manual switch should clear cooldown
      tokenManager.setActiveToken('cct1');
      const token = tokenManager.getAllTokens().find((t) => t.name === 'cct1');
      expect(token?.cooldownUntil).toBeNull();
    });

    // Trace: Scenario 3, Error path 2
    it('should reject unknown token name', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const result = tokenManager.setActiveToken('cct99');
      expect(result).toBe(false);
    });
  });

  // === Scenario 4: Auto-Rotation on Rate Limit ===

  describe('rotateOnRateLimit', () => {
    // Trace: Scenario 4, Steps 5-7
    it('should switch to next available token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const result = tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(result.rotated).toBe(true);
      expect(result.newToken).toBe('cct2');
    });

    // Trace: Scenario 4, Step 5 CAS
    it('should be idempotent - no-op if already rotated', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // First rotation succeeds
      const result1 = tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(result1.rotated).toBe(true);

      // Second rotation with same failed token is no-op (CAS fails)
      const result2 = tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(result2.rotated).toBe(false);
      expect(result2.reason).toBe('already_rotated');
    });

    // Trace: Scenario 4, Step 6
    it('should set cooldown on failed token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const cooldownTime = new Date(Date.now() + 3600000);
      tokenManager.rotateOnRateLimit('tokenA', cooldownTime);

      const tokens = tokenManager.getAllTokens();
      expect(tokens[0].cooldownUntil).toEqual(cooldownTime);
    });

    // Trace: Scenario 4, Step 7 applyToken
    it('should update process.env after rotation', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tokenB');
    });

    // Trace: Scenario 4, Step 7 loop
    it('should skip tokens on cooldown', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // Rotate from A → B
      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      // Rotate from B → should skip A (on cooldown) → C
      tokenManager.rotateOnRateLimit('tokenB', new Date(Date.now() + 3600000));
      expect(tokenManager.getActiveToken().name).toBe('cct3');
    });
  });

  // === Scenario 5: All Tokens on Cooldown ===

  describe('allCooldown', () => {
    // Trace: Scenario 5, Steps 3-5
    it('should select token with earliest recovery', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const earlyRecovery = new Date(Date.now() + 1800000); // 30min
      const lateRecovery = new Date(Date.now() + 3600000); // 1hr

      // Rotate A → B, set A cooldown to late
      tokenManager.rotateOnRateLimit('tokenA', lateRecovery);
      // Rotate B → C, set B cooldown to early
      tokenManager.rotateOnRateLimit('tokenB', earlyRecovery);
      // Rotate C → should pick B (earliest recovery)
      const result = tokenManager.rotateOnRateLimit('tokenC', lateRecovery);

      expect(result.rotated).toBe(true);
      expect(result.allOnCooldown).toBe(true);
      expect(result.newToken).toBe('cct2'); // B has earliest recovery
    });

    // Trace: Scenario 5, Return value
    it('should return allOnCooldown flag', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const cooldown = new Date(Date.now() + 3600000);
      tokenManager.rotateOnRateLimit('tokenA', cooldown);
      const result = tokenManager.rotateOnRateLimit('tokenB', cooldown);

      expect(result.allOnCooldown).toBe(true);
    });

    // Trace: Scenario 5, Edge case
    it('should reuse single token when pool size is 1', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const result = tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(result.rotated).toBe(true);
      expect(result.newToken).toBe('cct1');
      expect(result.allOnCooldown).toBe(true);
    });
  });

  // === Token Masking ===

  describe('maskToken', () => {
    it('should mask token with first 10 and last 10 chars', async () => {
      const { TokenManager } = await import('./token-manager');
      expect(TokenManager.maskToken('sk-ant-oat01-eEUA4SSw6DknUGozq_TlsXccM9')).toBe(
        'sk-ant-oat01-eEUA4SS...q_TlsXccM9',
      );
    });

    it('should handle short tokens without masking', async () => {
      const { TokenManager } = await import('./token-manager');
      expect(TokenManager.maskToken('short-token-value')).toBe('short-token-value');
    });

    it('should show full token if length <= 33', async () => {
      const { TokenManager } = await import('./token-manager');
      expect(TokenManager.maskToken('123456789012345678901234567890123')).toBe('123456789012345678901234567890123');
    });
  });

  describe('rotateToNext', () => {
    it('should rotate to next available token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const result = tokenManager.rotateToNext();
      expect(result).toEqual({ name: 'cct2' });
      expect(tokenManager.getActiveToken().name).toBe('cct2');
    });

    it('should skip tokens on cooldown', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // Put cct2 on cooldown via rotation
      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      // Now active is cct2, rotate to next — should skip cct1 (on cooldown) → cct3
      const result = tokenManager.rotateToNext();
      expect(result).toEqual({ name: 'cct3' });
    });

    it('should return null for single token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      expect(tokenManager.rotateToNext()).toBeNull();
    });
  });

  // === Race Condition: Concurrent Sessions ===

  describe('concurrent rotation race condition', () => {
    it('should NOT double-rotate when two sessions pass the correct query-start token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // Both sessions started with tokenA (captured at query start)
      const sessionAToken = 'tokenA';
      const sessionBToken = 'tokenA';

      // Session A rotates first: tokenA → tokenB
      const resultA = tokenManager.rotateOnRateLimit(sessionAToken, new Date(Date.now() + 3600000));
      expect(resultA.rotated).toBe(true);
      expect(resultA.newToken).toBe('cct2');

      // Session B tries with the same query-start token: CAS detects already rotated
      const resultB = tokenManager.rotateOnRateLimit(sessionBToken, new Date(Date.now() + 3600000));
      expect(resultB.rotated).toBe(false);
      expect(resultB.reason).toBe('already_rotated');

      // Active token should still be cct2 (tokenB), NOT rotated back to cct1
      expect(tokenManager.getActiveToken().name).toBe('cct2');
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tokenB');
    });

    it('BUG REPRODUCTION: reading env at error time causes double-rotation', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      // Session A rotates: tokenA → tokenB, env is now tokenB
      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));

      // BUG: if session B reads process.env (now tokenB) instead of its query-start token,
      // it incorrectly passes tokenB as the failed token
      const envTokenAtErrorTime = process.env.CLAUDE_CODE_OAUTH_TOKEN!;
      expect(envTokenAtErrorTime).toBe('tokenB'); // env was changed by session A

      // This would incorrectly rotate tokenB → tokenA (back to rate-limited!)
      const bugResult = tokenManager.rotateOnRateLimit(envTokenAtErrorTime, new Date(Date.now() + 3600000));
      // With the bug, this WOULD rotate. This test documents the bug behavior.
      expect(bugResult.rotated).toBe(true); // unfortunately rotates
      expect(tokenManager.getActiveToken().value).toBe('tokenA'); // back to rate-limited token!
    });
  });

  // === Cooldown Time Parsing ===

  describe('parseCooldownTime', () => {
    // Trace: Scenario 4, Step 2 "7pm"
    it('should parse "resets 7pm"', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime("You've hit your limit · resets 7pm (Asia/Seoul)");
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(19);
      expect(result!.getMinutes()).toBe(0);
    });

    // Trace: Scenario 4, Step 2 "7:30pm"
    it('should parse "resets 7:30pm"', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime("You've hit your limit · resets 7:30pm");
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(19);
      expect(result!.getMinutes()).toBe(30);
    });

    // Trace: Scenario 4, Step 2 null
    it('should return null on no match', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime('Some random error message');
      expect(result).toBeNull();
    });

    it('should parse AM times', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime('resets 11am');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(11);
    });
  });
});
