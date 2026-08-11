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

const KEYS_URL = 'http://localhost:3456/llmux/keys';
const NEW_URL = 'http://localhost:3456/llmux/keys/new';
const ROTATE_URL = 'http://localhost:3456/llmux/keys/rotate';

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

  /** llmux with no keys at all: list is empty, `keys/new` succeeds. */
  function mockEmptyDaemon(doc: Record<string, unknown> = newKeyDoc()) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) return okResponse({ keys: [] });
      return okResponse(doc);
    });
  }

  const urlsOf = () => fetchMock.mock.calls.map((c) => c[0]);

  it('issues a key on first use, persists it, and serves later calls from the store', async () => {
    mockEmptyDaemon();

    const secret = await ensureTenantKey('U1', { name: 'Zhuge', email: 'z@example.com' });
    expect(secret).toBe('lmk-abcdef-secret');

    // Reclaim lookup precedes creation (see the display-name cases below).
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL]);
    const init = fetchMock.mock.calls[1][1];
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('admin-key');
    // The name embeds the Slack id, which is what makes the key re-identifiable.
    expect(JSON.parse(init.body)).toEqual({ name: 'Zhuge (U1)', email: 'z@example.com', kind: 'default' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.tenants.U1).toMatchObject({
      id: 'k-1',
      secret: 'lmk-abcdef-secret',
      keyPrefix: 'lmk-abc',
      baseUrl: 'http://localhost:3456',
    });
    // The file holds plaintext secrets — owner-only.
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);

    // Second call is a pure store hit — no further llmux traffic.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-abcdef-secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the Slack id when no display name is known', async () => {
    mockEmptyDaemon(newKeyDoc({ name: 'U9' }));
    await ensureTenantKey('U9');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ name: 'U9', kind: 'default' });
  });

  // ===== reclaim is keyed on the immutable Slack id, not the display name =====

  it('rotates an existing key named by the bare Slack id instead of creating a second one', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) {
        return okResponse({ keys: [{ id: 'k-live', name: 'U1', key_prefix: 'lmk-live', revoked_at_ms: null }] });
      }
      return okResponse({ ok: true, key: { id: 'k-live', key_prefix: 'lmk-new', key: 'lmk-rotated-secret' } });
    });

    // The user now HAS a display name, so keyName() would produce a different
    // name than the stored key — creating would silently split their metering.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-rotated-secret');
    expect(urlsOf()).toEqual([KEYS_URL, ROTATE_URL]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'k-live' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    // Name is llmux's (there is no rename); the id is preserved.
    expect(persisted.tenants.U1).toMatchObject({ id: 'k-live', name: 'U1', secret: 'lmk-rotated-secret' });
  });

  it('rotates an existing key whose display name is stale, ignoring revoked and foreign entries', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) {
        return okResponse({
          keys: [
            { id: 'k-old', name: 'Old Name (U1)', revoked_at_ms: 1_700_000_000_000 },
            { id: 'k-live', name: 'Old Name (U1)', key_prefix: 'lmk-live', revoked_at_ms: null },
            { id: 'k-other', name: 'Someone (U2)', revoked_at_ms: null },
          ],
        });
      }
      return okResponse({ ok: true, key: { id: 'k-live', key_prefix: 'lmk-new', key: 'lmk-rotated-secret' } });
    });

    await expect(ensureTenantKey('U1', { name: 'New Name' })).resolves.toBe('lmk-rotated-secret');
    expect(urlsOf()).toEqual([KEYS_URL, ROTATE_URL]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'k-live' });
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1.rotatedAtMs).toBeGreaterThan(0);
  });

  it('self-heals a 409 raced after an empty listing', async () => {
    let listCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) {
        listCalls += 1;
        // First listing sees nothing; by the time we create, a key exists.
        return okResponse({
          keys: listCalls === 1 ? [] : [{ id: 'k-live', name: 'Zhuge (U1)', revoked_at_ms: null }],
        });
      }
      if (url.endsWith('/llmux/keys/new')) {
        return okResponse({ type: 'error', error: { message: 'name already in use' } }, 409);
      }
      return okResponse({ ok: true, key: { id: 'k-live', key_prefix: 'lmk-new', key: 'lmk-rotated-secret' } });
    });

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-rotated-secret');
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL, KEYS_URL, ROTATE_URL]);
  });

  it('treats a 409 with no matching live key as a failure (shared-key fallback)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) {
        return okResponse({ keys: [{ id: 'k-old', name: 'Zhuge (U1)', revoked_at_ms: 1_700_000_000_000 }] });
      }
      return okResponse({ ok: false }, 409);
    });
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
  });

  // ===== failure handling =====

  it('returns null on a non-2xx and negative-caches the failure', async () => {
    fetchMock.mockImplementation(async () =>
      okResponse({ type: 'error', error: { message: 'admin credential required' } }, 403),
    );
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    const callsAfterFirst = fetchMock.mock.calls.length;
    // Immediate retry must NOT hit llmux again — one broken llmux would
    // otherwise add failing requests to every dispatch.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('returns null without any llmux call in ccp mode', async () => {
    setAuthMode('ccp');
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when llmux is unreachable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
  });

  // ===== store reuse is bound to the issuing daemon =====

  it('reloads persisted keys after a restart — no re-issue', async () => {
    mockEmptyDaemon();
    await ensureTenantKey('U1', { name: 'Zhuge' });
    const callsAfterIssue = fetchMock.mock.calls.length;

    // Fresh module state (simulated restart) against the same store file.
    resetLlmuxTenantKeysForTests(storePath);
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-abcdef-secret');
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterIssue);
  });

  it('re-issues when the daemon changed — a key from another llmux is not reused', async () => {
    mockEmptyDaemon();
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-abcdef-secret');
    fetchMock.mockClear();

    // Operator re-points soma-work at a different llmux. The stored secret is
    // meaningless there (it would 401 without ever falling back), so a fresh
    // key must be issued against the new daemon.
    setLlmuxSettings({ baseUrl: 'http://10.0.0.5:3456' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) return okResponse({ keys: [] });
      return okResponse(newKeyDoc({ id: 'k-remote', key: 'lmk-remote-secret', key_prefix: 'lmk-rem' }));
    });

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBe('lmk-remote-secret');
    expect(urlsOf()).toEqual(['http://10.0.0.5:3456/llmux/keys', 'http://10.0.0.5:3456/llmux/keys/new']);
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1).toMatchObject({ id: 'k-remote', baseUrl: 'http://10.0.0.5:3456' });
  });

  it('issues at most one key for concurrent dispatches of the same user', async () => {
    // Hold the creation open so the second call necessarily overlaps the first.
    let resolveIssue!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      resolveIssue = resolve;
    });
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/llmux/keys') ? Promise.resolve(okResponse({ keys: [] })) : gate,
    );

    const calls = [ensureTenantKey('U1', { name: 'Zhuge' }), ensureTenantKey('U1', { name: 'Zhuge' })];
    resolveIssue(okResponse(newKeyDoc()));

    expect(await Promise.all(calls)).toEqual(['lmk-abcdef-secret', 'lmk-abcdef-secret']);
    expect(urlsOf().filter((url) => url === NEW_URL)).toHaveLength(1);
  });
});
