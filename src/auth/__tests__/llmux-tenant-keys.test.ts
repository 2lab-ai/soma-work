import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Freeze the env-derived defaults so the suite is independent of the host's
// AUTH_MODE / ANTHROPIC_* environment (same shape as auth-runtime.test.ts).
vi.mock('../../config', () => ({
  config: {
    auth: {
      mode: 'ccp',
      llmux: { baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' },
    },
  },
  LLMUX_PLACEHOLDER_API_KEY: 'llmux-local',
}));

import { resetAuthRuntimeForTests, setAuthMode, setLlmuxSettings } from '../auth-runtime';
import { ensureTenantKey, resetLlmuxTenantKeysForTests } from '../llmux-tenant-keys';

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `POST /llmux/keys/new` success payload (llmux `src/proxy/server.rs`). */
function newKeyDoc(overrides?: Record<string, unknown>) {
  return {
    ok: true,
    id: 'k-1',
    name: 'Zhuge (U1)',
    email: 'z@example.com',
    kind: 'default',
    key_prefix: 'lmk-abc',
    suspended: false,
    created_at_ms: 1_700_000_000_000,
    revoked_at_ms: null,
    key: 'lmk-abcdef-secret',
    ...overrides,
  };
}

describe('llmux tenant keys (per-user metering)', () => {
  let dir: string;
  let storePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmux-tenant-keys-'));
    storePath = path.join(dir, 'llmux-tenant-keys.json');
    resetAuthRuntimeForTests(path.join(dir, 'auth-runtime.json'));
    resetLlmuxTenantKeysForTests(storePath);
    delete process.env.AUTH_MODE;
    setLlmuxSettings({ baseUrl: 'http://localhost:3456', apiKey: 'admin-key' });
    setAuthMode('llmux');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAuthRuntimeForTests();
    resetLlmuxTenantKeysForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('issues a key on first use, persists it, and serves later calls from the store', async () => {
    fetchMock.mockImplementation(async () => okResponse(newKeyDoc()));

    const secret = await ensureTenantKey('U1', { name: 'Zhuge', email: 'z@example.com' });
    expect(secret).toBe('lmk-abcdef-secret');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3456/llmux/keys/new');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('admin-key');
    // The name embeds the Slack id, which is what makes it unique per user.
    expect(JSON.parse(init.body)).toEqual({ name: 'Zhuge (U1)', email: 'z@example.com', kind: 'default' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.tenants.U1).toMatchObject({ id: 'k-1', secret: 'lmk-abcdef-secret', keyPrefix: 'lmk-abc' });

    // Second call is a pure store hit — no further llmux traffic.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-abcdef-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Slack id when no display name is known', async () => {
    fetchMock.mockImplementation(async () => okResponse(newKeyDoc({ name: 'U9' })));
    await ensureTenantKey('U9');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'U9', kind: 'default' });
  });

  it('self-heals a 409 (name taken) by rotating the existing key', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys/new')) {
        return okResponse({ type: 'error', error: { message: 'name already in use' } }, 409);
      }
      if (url.endsWith('/llmux/keys')) {
        return okResponse({
          keys: [
            { id: 'k-old', name: 'Zhuge (U1)', key_prefix: 'lmk-old', revoked_at_ms: 1_700_000_000_000 },
            { id: 'k-live', name: 'Zhuge (U1)', key_prefix: 'lmk-live', revoked_at_ms: null },
            { id: 'k-other', name: 'Someone (U2)', key_prefix: 'lmk-x', revoked_at_ms: null },
          ],
        });
      }
      return okResponse({ ok: true, key: { id: 'k-live', key_prefix: 'lmk-new', key: 'lmk-rotated-secret' } });
    });

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-rotated-secret');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'http://localhost:3456/llmux/keys/new',
      'http://localhost:3456/llmux/keys',
      'http://localhost:3456/llmux/keys/rotate',
    ]);
    // Rotation targets the non-revoked key with OUR exact name.
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ id: 'k-live' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1).toMatchObject({ id: 'k-live', secret: 'lmk-rotated-secret' });
    expect(persisted.tenants.U1.rotatedAtMs).toBeGreaterThan(0);
  });

  it('treats a 409 with no matching live key as a failure (shared-key fallback)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys/new')) return okResponse({ ok: false }, 409);
      return okResponse({ keys: [{ id: 'k-old', name: 'Zhuge (U1)', revoked_at_ms: 1_700_000_000_000 }] });
    });
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
  });

  it('returns null on a non-2xx and negative-caches the failure', async () => {
    fetchMock.mockImplementation(async () =>
      okResponse({ type: 'error', error: { message: 'admin credential required' } }, 403),
    );
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Immediate retry must NOT hit llmux again — one broken llmux would
    // otherwise add a failing request to every dispatch.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null without any llmux call in ccp mode', async () => {
    setAuthMode('ccp');
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reloads persisted keys after a restart — no re-issue', async () => {
    fetchMock.mockImplementation(async () => okResponse(newKeyDoc()));
    await ensureTenantKey('U1', { name: 'Zhuge' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Fresh module state (simulated restart) against the same store file.
    resetLlmuxTenantKeysForTests(storePath);
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-abcdef-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('issues at most one key for concurrent dispatches of the same user', async () => {
    // Hold the issuance open so the second call necessarily overlaps the first.
    let resolveIssue!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveIssue = resolve;
    });
    fetchMock.mockImplementation(() => gate);

    const calls = [ensureTenantKey('U1', { name: 'Zhuge' }), ensureTenantKey('U1', { name: 'Zhuge' })];
    resolveIssue(okResponse(newKeyDoc()));

    expect(await Promise.all(calls)).toEqual(['lmk-abcdef-secret', 'lmk-abcdef-secret']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when llmux is unreachable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
  });
});
