import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthHandler } from '../auth-handler';
import type { CommandContext } from '../types';

// ── auth runtime: llmux mode by default; individual tests flip it ────────────
const getAuthMode = vi.fn(() => 'llmux');
vi.mock('../../../auth/auth-runtime', () => ({
  getAuthMode: () => getAuthMode(),
  getLlmuxAdminKey: () => 'admin-key',
  getLlmuxSettings: () => ({ baseUrl: 'http://localhost:3456', apiKey: 'shared' }),
}));

// ── tenant key issuance ──────────────────────────────────────────────────────
const ensureTenantKey = vi.fn();
const describeTenantKey = vi.fn();
vi.mock('../../../auth/llmux-tenant-keys', () => ({
  ensureTenantKey: (...args: unknown[]) => ensureTenantKey(...args),
  describeTenantKey: (...args: unknown[]) => describeTenantKey(...args),
}));

// auth card render is irrelevant here but the module imports it
vi.mock('../../z/topics/auth-topic', () => ({
  applyAuthMode: vi.fn(),
  renderAuthCard: vi.fn(async () => ({ text: 'card', blocks: [] })),
}));

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext & {
  saidTexts: string[];
} {
  const saidTexts: string[] = [];
  return {
    user: 'U123',
    channel: 'C999',
    threadTs: '111.222',
    text: 'key',
    say: vi.fn(async (msg: { text: string }) => {
      saidTexts.push(msg.text);
      return {};
    }),
    saidTexts,
    ...overrides,
  } as CommandContext & { saidTexts: string[] };
}

function makeDeps() {
  return {
    slackApi: {
      openDmChannel: vi.fn(async (_userId: string) => 'D555'),
      postMessage: vi.fn(async (_channel: string, _text: string, _options?: unknown) => ({ ts: '1.2' })),
    },
    userSettingsStore: {
      getUserSettings: vi.fn(() => ({ slackName: 'Z', email: 'z@2lab.ai' })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthMode.mockReturnValue('llmux');
  ensureTenantKey.mockResolvedValue({ secret: 'lmk-secret-1', baseUrl: 'http://localhost:3456' });
  describeTenantKey.mockReturnValue({
    id: 'k-1',
    keyPrefix: 'lmk-secr',
    name: 'Z (U123)',
    issuedAtMs: 1,
    baseUrl: 'http://localhost:3456',
  });
});

describe('AuthHandler — `key` (personal llmux key DM)', () => {
  it('canHandle accepts `key` and `auth key`', () => {
    const handler = new AuthHandler(makeDeps());
    expect(handler.canHandle('key')).toBe(true);
    expect(handler.canHandle('auth key')).toBe(true);
  });

  it('DMs the requesting user their key + usage guide, never posting the secret to the channel', async () => {
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();

    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(ensureTenantKey).toHaveBeenCalledWith('U123', { name: 'Z', email: 'z@2lab.ai' });
    expect(deps.slackApi.openDmChannel).toHaveBeenCalledWith('U123');
    const [dmChannel, dmText] = deps.slackApi.postMessage.mock.calls[0];
    expect(dmChannel).toBe('D555');
    expect(dmText).toContain('lmk-secret-1');
    expect(dmText).toContain('ANTHROPIC_BASE_URL=');
    // channel-side reply exists but must not leak the secret
    expect(ctx.saidTexts.join('\n')).not.toContain('lmk-secret-1');
    expect(ctx.saidTexts.length).toBeGreaterThan(0);
  });

  it('skips the channel-side confirmation when invoked from the DM itself', async () => {
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx({ channel: 'D555' });

    await handler.execute(ctx);

    expect(deps.slackApi.postMessage).toHaveBeenCalled();
    expect(ctx.saidTexts).toHaveLength(0);
  });

  it('reports a clear error when not in llmux mode (no DM attempt)', async () => {
    getAuthMode.mockReturnValue('ccp');
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();

    await handler.execute(ctx);

    expect(deps.slackApi.openDmChannel).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toMatch(/llmux/);
  });

  it('reports issuance failure without leaking anything (ensureTenantKey → null)', async () => {
    ensureTenantKey.mockResolvedValue(null);
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();

    await handler.execute(ctx);

    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toMatch(/실패|fail/i);
  });

  it('a failed DM send is contained: constant channel reply, no thrown secret-bearing error', async () => {
    const deps = makeDeps();
    deps.slackApi.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();

    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    const said = ctx.saidTexts.join('\n');
    expect(said).toMatch(/DM 발송에 실패/);
    expect(said).not.toContain('lmk-secret-1');
  });

  it('non-admin users can use it (no admin gate)', async () => {
    // makeCtx user U123 is not in adminUsers (config empty in tests)
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();
    const result = await handler.execute(ctx);
    expect(result.handled).toBe(true);
    expect(deps.slackApi.postMessage).toHaveBeenCalled();
  });
});
