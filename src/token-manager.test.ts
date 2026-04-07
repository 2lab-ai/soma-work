import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract tests derived from docs/cct-token-rotation/trace.md
// All tests should FAIL (RED) until implementation

const TEST_DATA_DIR = path.join(__dirname, '../.test-data-token-manager');

describe('TokenManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clean test data dir
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(TEST_DATA_DIR)) {
      fs.rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  // === Scenario 1: Token Initialization ===

  describe('initialize', () => {
    // Trace: Scenario 1, Step 3 (legacy unnamed format)
    it('should load multiple tokens with cctN fallback names', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB,tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(3);
      expect(tokens[0].name).toBe('cct1');
      expect(tokens[1].name).toBe('cct2');
      expect(tokens[2].name).toBe('cct3');
    });

    // Named token format: name=value
    it('should load named tokens from name=value format', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai3=tokenA,ai2=tokenB,info=tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens).toHaveLength(3);
      expect(tokens[0]).toMatchObject({ name: 'ai3', value: 'tokenA' });
      expect(tokens[1]).toMatchObject({ name: 'ai2', value: 'tokenB' });
      expect(tokens[2]).toMatchObject({ name: 'info', value: 'tokenC' });
    });

    it('should handle mixed named and unnamed entries', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai3=tokenA,tokenB,info=tokenC';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens[0].name).toBe('ai3');
      expect(tokens[1].name).toBe('cct2');
      expect(tokens[2].name).toBe('info');
    });

    it('should resolve ${VAR} references from process.env', async () => {
      process.env.AI3_TOKEN = 'sk-ant-real-ai3';
      process.env.AI2_TOKEN = 'sk-ant-real-ai2';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai3=${AI3_TOKEN},ai2=${AI2_TOKEN}';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens[0]).toMatchObject({ name: 'ai3', value: 'sk-ant-real-ai3' });
      expect(tokens[1]).toMatchObject({ name: 'ai2', value: 'sk-ant-real-ai2' });
    });

    it('should keep raw value if env var not found', async () => {
      delete process.env.MISSING_TOKEN;
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'missing=${MISSING_TOKEN}';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize();

      const tokens = tokenManager.getAllTokens();
      expect(tokens[0]).toMatchObject({ name: 'missing', value: '${MISSING_TOKEN}' });
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

    // === Weekly limit parsing (bug fix) ===

    it('should parse weekly limit "resets Apr 7, 7pm (Asia/Seoul)"', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime("You've hit your limit · resets Apr 7, 7pm (Asia/Seoul)");
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(19);
      expect(result!.getMinutes()).toBe(0);
      expect(result!.getMonth()).toBe(3); // April = 3 (0-based)
      expect(result!.getDate()).toBe(7);
    });

    it('should parse weekly limit with minutes "resets Mar 15, 3:30pm"', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime('resets Mar 15, 3:30pm');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(15);
      expect(result!.getMinutes()).toBe(30);
      expect(result!.getMonth()).toBe(2); // March = 2
      expect(result!.getDate()).toBe(15);
    });

    it('should parse weekly limit without comma "resets Jan 20 9am"', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      const result = parseCooldownTime('resets Jan 20 9am');
      expect(result).toBeInstanceOf(Date);
      expect(result!.getHours()).toBe(9);
      expect(result!.getMonth()).toBe(0); // January = 0
      expect(result!.getDate()).toBe(20);
    });

    it('should handle weekly limit date in the past by advancing to next year', async () => {
      const { parseCooldownTime } = await import('./token-manager');
      // Use a date guaranteed to be in the past
      const pastMonth = new Date();
      pastMonth.setMonth(pastMonth.getMonth() - 2);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const msg = `resets ${monthNames[pastMonth.getMonth()]} ${pastMonth.getDate()}, 7pm`;
      const result = parseCooldownTime(msg);
      expect(result).toBeInstanceOf(Date);
      // The returned date must be in the future (past date → next year)
      expect(result!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // === Cooldown Persistence ===

  describe('cooldown persistence', () => {
    it('should save cooldowns to disk on rotateOnRateLimit', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2=tokenA,ai3=tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(TEST_DATA_DIR);

      const cooldownTime = new Date(Date.now() + 3600000);
      tokenManager.rotateOnRateLimit('tokenA', cooldownTime);

      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(data.cooldowns.ai2).toBeDefined();
      expect(data.cooldowns.ai2.until).toBe(cooldownTime.toISOString());
      expect(data.activeToken).toBe('ai3');
    });

    it('should restore cooldowns from disk on initialize', async () => {
      const cooldownTime = new Date(Date.now() + 3600000); // 1hr from now
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');

      // Pre-write cooldown file
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            cooldowns: { ai2: { until: cooldownTime.toISOString() } },
            activeToken: 'ai3',
          },
          null,
          2,
        ),
        'utf-8',
      );

      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2=tokenA,ai3=tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(TEST_DATA_DIR);

      const tokens = tokenManager.getAllTokens();
      // ai2 should have cooldown restored
      expect(tokens[0].cooldownUntil).toBeInstanceOf(Date);
      expect(tokens[0].cooldownUntil!.toISOString()).toBe(cooldownTime.toISOString());
      // ai3 should be active (was persisted, and ai2 is on cooldown)
      expect(tokenManager.getActiveToken().name).toBe('ai3');
    });

    it('should discard expired cooldowns on restore', async () => {
      const expiredTime = new Date(Date.now() - 3600000); // 1hr ago
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            cooldowns: { ai2: { until: expiredTime.toISOString() } },
            activeToken: 'ai2',
          },
          null,
          2,
        ),
        'utf-8',
      );

      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2=tokenA,ai3=tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(TEST_DATA_DIR);

      const tokens = tokenManager.getAllTokens();
      // Expired cooldown should be discarded
      expect(tokens[0].cooldownUntil).toBeNull();
      // ai2 should still be active (restored preference, no cooldown)
      expect(tokenManager.getActiveToken().name).toBe('ai2');
    });

    it('should pick best available token when persisted active is on cooldown', async () => {
      const cooldownTime = new Date(Date.now() + 3600000);
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');

      // ai2 is persisted as active but has cooldown
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            cooldowns: { ai2: { until: cooldownTime.toISOString() } },
            activeToken: 'ai2',
          },
          null,
          2,
        ),
        'utf-8',
      );

      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2=tokenA,ai3=tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(TEST_DATA_DIR);

      // ai2 on cooldown → should auto-select ai3
      expect(tokenManager.getActiveToken().name).toBe('ai3');
    });

    it('should work without dataDir (no persistence)', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(); // no dataDir

      // Should work fine without persistence
      tokenManager.rotateOnRateLimit('tokenA', new Date(Date.now() + 3600000));
      expect(tokenManager.getActiveToken().name).toBe('cct2');

      // No file created
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should handle corrupt cooldown file gracefully', async () => {
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');
      fs.writeFileSync(filePath, 'not valid json!!!', 'utf-8');

      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'tokenA,tokenB';
      const { tokenManager } = await import('./token-manager');

      // Should not throw, just warn and continue
      expect(() => tokenManager.initialize(TEST_DATA_DIR)).not.toThrow();
      expect(tokenManager.getActiveToken().name).toBe('cct1');
    });

    it('should select earliest recovery when all tokens on cooldown at restore', async () => {
      const earlyCooldown = new Date(Date.now() + 1800000); // 30min
      const lateCooldown = new Date(Date.now() + 3600000); // 1hr
      const filePath = path.join(TEST_DATA_DIR, 'token-cooldowns.json');

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            cooldowns: {
              ai2: { until: lateCooldown.toISOString() },
              ai3: { until: earlyCooldown.toISOString() },
            },
            activeToken: 'ai2',
          },
          null,
          2,
        ),
        'utf-8',
      );

      process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST = 'ai2=tokenA,ai3=tokenB';
      const { tokenManager } = await import('./token-manager');
      tokenManager.initialize(TEST_DATA_DIR);

      // Both on cooldown → should pick ai3 (earliest recovery)
      expect(tokenManager.getActiveToken().name).toBe('ai3');
    });
  });
});
