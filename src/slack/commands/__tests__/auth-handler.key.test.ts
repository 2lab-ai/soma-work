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
const rotateTenantKey = vi.fn();
const checkTenantKey = vi.fn();
vi.mock('../../../auth/llmux-tenant-keys', () => ({
  ensureTenantKey: (...args: unknown[]) => ensureTenantKey(...args),
  describeTenantKey: (...args: unknown[]) => describeTenantKey(...args),
  rotateTenantKey: (...args: unknown[]) => rotateTenantKey(...args),
  checkTenantKey: (...args: unknown[]) => checkTenantKey(...args),
}));

// Advertised address: real DM renderer, controllable address resolution.
const advertisedLlmuxBaseUrl = vi.fn();
vi.mock('../../../auth/llmux-key-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../auth/llmux-key-info')>()),
  advertisedLlmuxBaseUrl: (...args: unknown[]) => advertisedLlmuxBaseUrl(...args),
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
  rotateTenantKey.mockResolvedValue({ ok: true, lease: { secret: 'lmk-rotated-2', baseUrl: 'http://localhost:3456' } });
  advertisedLlmuxBaseUrl.mockResolvedValue('http://10.0.0.5:3456');
  checkTenantKey.mockResolvedValue('valid');
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
    expect(dmText).toContain("export ANTHROPIC_BASE_URL='");
    expect(dmText).toContain("export ANTHROPIC_API_KEY='lmk-secret-1'");
    expect(dmText).toContain("OPENAI_API_KEY='lmk-secret-1'");
    expect(dmText).toContain('OPENAI_BASE_URL=');
    expect(ctx.saidTexts.join('\n')).toContain('Claude Code / Codex');
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

describe('AuthHandler — `key` never DMs a key llmux no longer accepts', () => {
  it('a key rotated outside soma-work is NOT sent; the user is told to run `key rotate`', async () => {
    checkTenantKey.mockResolvedValue('stale');
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx();

    await handler.execute(ctx);

    expect(checkTenantKey).toHaveBeenCalledWith('U123');
    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    const said = ctx.saidTexts.join('\n');
    expect(said).toContain('key rotate');
    expect(said).not.toContain('lmk-secret-1');
    expect(rotateTenantKey).not.toHaveBeenCalled();
  });

  it('a key an admin revoked is NOT sent and the user is sent to the admin, not to `key rotate`', async () => {
    checkTenantKey.mockResolvedValue('revoked');
    const deps = makeDeps();
    const ctx = makeCtx();

    await new AuthHandler(deps).execute(ctx);

    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    const said = ctx.saidTexts.join('\n');
    expect(said).toMatch(/관리자/);
    expect(said).not.toContain('lmk-secret-1');
  });

  it('still DMs the key when llmux cannot be asked (`unknown`)', async () => {
    checkTenantKey.mockResolvedValue('unknown');
    const deps = makeDeps();
    const handler = new AuthHandler(deps);

    await handler.execute(makeCtx());

    expect(deps.slackApi.postMessage.mock.calls[0][1]).toContain('lmk-secret-1');
  });

  it('the DM no longer promises that plain `key` returns a key rotated by an admin', async () => {
    const deps = makeDeps();
    await new AuthHandler(deps).execute(makeCtx());
    const dmText = deps.slackApi.postMessage.mock.calls[0][1] as string;
    expect(dmText).toContain('`key rotate`');
    expect(dmText).not.toContain('`key`를 다시 호출하면 새 키를 받습니다');
  });
});

describe('AuthHandler — `key rotate` (revoke the old key, DM a new one)', () => {
  it('canHandle accepts `key rotate` and `auth key rotate`', () => {
    const handler = new AuthHandler(makeDeps());
    expect(handler.canHandle('key rotate')).toBe(true);
    expect(handler.canHandle('auth key rotate')).toBe(true);
  });

  it('rotates the caller’s key and DMs ONLY the new secret, saying the old one is dead', async () => {
    const deps = makeDeps();
    const handler = new AuthHandler(deps);
    const ctx = makeCtx({ text: 'key rotate' });

    const result = await handler.execute(ctx);

    expect(result.handled).toBe(true);
    expect(rotateTenantKey).toHaveBeenCalledWith('U123', { name: 'Z', email: 'z@2lab.ai' });
    expect(ensureTenantKey).not.toHaveBeenCalled();
    const [dmChannel, dmText] = deps.slackApi.postMessage.mock.calls[0];
    expect(dmChannel).toBe('D555');
    expect(dmText).toContain("export ANTHROPIC_API_KEY='lmk-rotated-2'");
    expect(dmText).not.toContain('lmk-secret-1');
    expect(dmText).toMatch(/이전 키.*(폐기|무효)/);
    const said = ctx.saidTexts.join('\n');
    expect(said).toMatch(/새 키|교체/);
    expect(said).not.toContain('lmk-rotated-2');
  });

  it('works for non-admin users (it is their own key)', async () => {
    const deps = makeDeps();
    await new AuthHandler(deps).execute(makeCtx({ text: 'key rotate', user: 'U999' }));
    expect(rotateTenantKey).toHaveBeenCalledWith('U999', expect.anything());
    expect(deps.slackApi.postMessage).toHaveBeenCalled();
  });

  it('refuses to rotate a key an admin revoked (no DM, points to the admin)', async () => {
    rotateTenantKey.mockResolvedValue({ ok: false, reason: 'revoked' });
    const deps = makeDeps();
    const ctx = makeCtx({ text: 'key rotate' });

    await new AuthHandler(deps).execute(ctx);

    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toMatch(/관리자/);
  });

  it('does NOT rotate when no address can be advertised — the old key is not killed for nothing', async () => {
    advertisedLlmuxBaseUrl.mockResolvedValue(null);
    const deps = makeDeps();
    const ctx = makeCtx({ text: 'key rotate' });

    await new AuthHandler(deps).execute(ctx);

    expect(rotateTenantKey).not.toHaveBeenCalled();
    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toContain('LLMUX_ADVERTISED_BASE_URL');
  });

  it('reports a failed rotation without a DM (old key untouched)', async () => {
    rotateTenantKey.mockResolvedValue({ ok: false, reason: 'failed' });
    const deps = makeDeps();
    const ctx = makeCtx({ text: 'key rotate' });

    await new AuthHandler(deps).execute(ctx);

    expect(deps.slackApi.postMessage).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toMatch(/실패/);
  });

  it('refuses outside llmux mode without touching llmux', async () => {
    getAuthMode.mockReturnValue('ccp');
    const deps = makeDeps();
    const ctx = makeCtx({ text: 'key rotate' });

    await new AuthHandler(deps).execute(ctx);

    expect(rotateTenantKey).not.toHaveBeenCalled();
    expect(ctx.saidTexts.join('\n')).toMatch(/llmux/);
  });

  it('a failed DM after a successful rotation says the old key is gone and `key` fetches the new one — never the secret', async () => {
    const deps = makeDeps();
    deps.slackApi.postMessage.mockRejectedValue(new Error('channel_not_found'));
    const ctx = makeCtx({ text: 'key rotate' });

    await new AuthHandler(deps).execute(ctx);

    const said = ctx.saidTexts.join('\n');
    expect(said).toMatch(/DM 발송에 실패/);
    expect(said).toMatch(/이전 키는 이미 폐기/);
    expect(said).toContain('`key`');
    expect(said).not.toContain('lmk-rotated-2');
  });
});
