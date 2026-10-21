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

/** The daemon the suite runs against by default, and the one it switches to. */
const LOCAL = 'http://localhost:3456';
const REMOTE = 'http://10.0.0.5:3456';
const KEYS_URL = `${LOCAL}/llmux/keys`;
const NEW_URL = `${LOCAL}/llmux/keys/new`;
const ROTATE_URL = `${LOCAL}/llmux/keys/rotate`;

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
    setLlmuxSettings({ baseUrl: LOCAL, apiKey: 'admin-key' });
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

    // The lease pairs the secret with the daemon it is valid at.
    const leased = await ensureTenantKey('U1', { name: 'Zhuge', email: 'z@example.com' });
    expect(leased).toEqual({ secret: 'lmk-abcdef-secret', baseUrl: LOCAL });

    // Reclaim lookup precedes creation (see the display-name cases below).
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL]);
    const init = fetchMock.mock.calls[1][1];
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('admin-key');
    // The name embeds the Slack id, which is what makes the key re-identifiable.
    expect(JSON.parse(init.body)).toEqual({ name: 'Zhuge (U1)', email: 'z@example.com', kind: 'default' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.version).toBe(2);
    // Slot is (user, daemon).
    expect(persisted.tenants.U1[LOCAL]).toMatchObject({
      id: 'k-1',
      secret: 'lmk-abcdef-secret',
      keyPrefix: 'lmk-abc',
      baseUrl: LOCAL,
    });
    // The file holds plaintext secrets — owner-only.
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);

    // Second call is a pure store hit — no further llmux traffic.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
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
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-rotated-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, ROTATE_URL]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'k-live' });

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    // Name is llmux's (there is no rename); the id is preserved.
    expect(persisted.tenants.U1[LOCAL]).toMatchObject({ id: 'k-live', name: 'U1', secret: 'lmk-rotated-secret' });
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

    await expect(ensureTenantKey('U1', { name: 'New Name' })).resolves.toEqual({
      secret: 'lmk-rotated-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, ROTATE_URL]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: 'k-live' });
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1[LOCAL].rotatedAtMs).toBeGreaterThan(0);
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

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-rotated-secret',
      baseUrl: LOCAL,
    });
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
    // Fails closed: a failed listing must never lead to a create.
    expect(urlsOf()).not.toContain(NEW_URL);
  });

  it('fails CLOSED when the preflight listing errors — no key is created', async () => {
    // "We could not look" is indistinguishable from "this user has no key", and
    // creating on that ignorance mints a duplicate tenant whenever the display
    // name changed since the first issuance. Degrade to the shared key instead.
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/llmux/keys') ? okResponse({ error: 'boom' }, 500) : okResponse(newKeyDoc()),
    );

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(urlsOf()).toEqual([KEYS_URL]);

    // …and the failure is negative-cached like any other.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED when the preflight listing is unparseable', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/llmux/keys') ? okResponse({ notKeys: true }) : okResponse(newKeyDoc()),
    );
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();
    expect(urlsOf()).toEqual([KEYS_URL]);
  });

  it('creates only after a SUCCESSFUL empty listing', async () => {
    mockEmptyDaemon();
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL]);
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
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterIssue);
  });

  it('re-issues when the daemon changed — a key from another llmux is not reused', async () => {
    mockEmptyDaemon();
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
    fetchMock.mockClear();

    // Operator re-points soma-work at a different llmux. The stored secret is
    // meaningless there (it would 401 without ever falling back), so a fresh
    // key must be issued against the new daemon.
    setLlmuxSettings({ baseUrl: REMOTE });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) return okResponse({ keys: [] });
      return okResponse(newKeyDoc({ id: 'k-remote', key: 'lmk-remote-secret', key_prefix: 'lmk-rem' }));
    });

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-remote-secret',
      baseUrl: REMOTE,
    });
    expect(urlsOf()).toEqual([`${REMOTE}/llmux/keys`, `${REMOTE}/llmux/keys/new`]);
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1[REMOTE]).toMatchObject({ id: 'k-remote', baseUrl: REMOTE });
  });

  it('carries ONE daemon’s admin credential for the whole issuance, even if settings flip mid-flight', async () => {
    // The URL is already snapshotted; the admin key must be too. Otherwise the
    // create leg would present daemon B's secret to daemon A's URL.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/llmux/keys')) {
        setLlmuxSettings({ baseUrl: REMOTE, apiKey: 'admin-key-B' });
        return okResponse({ keys: [] });
      }
      return okResponse(newKeyDoc());
    });

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL]);
    const headers = fetchMock.mock.calls.map((c) => c[1].headers['x-api-key']);
    expect(headers).toEqual(['admin-key', 'admin-key']);
    expect(headers).not.toContain('admin-key-B');
  });

  it('a failure against one daemon does not suppress issuance against another', async () => {
    fetchMock.mockImplementation(async () => okResponse({ error: 'boom' }, 500));
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toBeNull();

    // The negative cache is scoped to the daemon that failed, so re-pointing at
    // a healthy llmux issues immediately instead of degrading for 10 minutes.
    setLlmuxSettings({ baseUrl: REMOTE });
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/llmux/keys')
        ? okResponse({ keys: [] })
        : okResponse(newKeyDoc({ id: 'k-remote', key: 'lmk-remote-secret' })),
    );
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-remote-secret',
      baseUrl: REMOTE,
    });
  });

  it('does not hand an in-flight issuance for one daemon to a dispatch targeting another', async () => {
    let resolveLocal!: (res: Response) => void;
    const localCreate = new Promise<Response>((resolve) => {
      resolveLocal = resolve;
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/llmux/keys')) return Promise.resolve(okResponse({ keys: [] }));
      if (url.startsWith(LOCAL)) return localCreate;
      return Promise.resolve(okResponse(newKeyDoc({ id: 'k-remote', key: 'lmk-remote-secret' })));
    });

    const localCall = ensureTenantKey('U1', { name: 'Zhuge' });
    // Let the preflight settle so the create against localhost is in flight.
    await new Promise((resolve) => setImmediate(resolve));

    setLlmuxSettings({ baseUrl: REMOTE });
    // Must NOT be served the pending localhost issuance — that key is worthless
    // at the new daemon.
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-remote-secret',
      baseUrl: REMOTE,
    });

    resolveLocal(okResponse(newKeyDoc()));
    await expect(localCall).resolves.toEqual({ secret: 'lmk-abcdef-secret', baseUrl: LOCAL });
  });

  it('keeps BOTH daemons’ keys when concurrent issuances land out of order', async () => {
    // The slow daemon-A issuance completes AFTER daemon B's. With a flat
    // per-user slot A would clobber B, and the next B lookup — a miss — would
    // force-rotate B's key out from under live dispatches still using it.
    let resolveLocal!: (res: Response) => void;
    const localCreate = new Promise<Response>((resolve) => {
      resolveLocal = resolve;
    });
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/llmux/keys')) return Promise.resolve(okResponse({ keys: [] }));
      if (url.startsWith(LOCAL)) return localCreate;
      return Promise.resolve(okResponse(newKeyDoc({ id: 'k-remote', key: 'lmk-remote-secret' })));
    });

    const localCall = ensureTenantKey('U1', { name: 'Zhuge' });
    await new Promise((resolve) => setImmediate(resolve));
    setLlmuxSettings({ baseUrl: REMOTE });
    await ensureTenantKey('U1', { name: 'Zhuge' }); // daemon B finishes first
    resolveLocal(okResponse(newKeyDoc())); // …daemon A finishes last
    await localCall;

    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1[LOCAL]).toMatchObject({ id: 'k-1', secret: 'lmk-abcdef-secret' });
    expect(persisted.tenants.U1[REMOTE]).toMatchObject({ id: 'k-remote', secret: 'lmk-remote-secret' });

    // After a restart each daemon still serves its OWN key — no re-issue.
    resetLlmuxTenantKeysForTests(storePath);
    fetchMock.mockClear();
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-remote-secret',
      baseUrl: REMOTE,
    });
    setLlmuxSettings({ baseUrl: LOCAL });
    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-abcdef-secret',
      baseUrl: LOCAL,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('migrates a v1 flat store, dropping records with no daemon attribution', async () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        tenants: {
          U1: { id: 'k-1', secret: 'lmk-v1-secret', keyPrefix: 'lmk-abc', name: 'Zhuge (U1)', baseUrl: LOCAL },
          // Pre-daemon-tracking record: presenting it to the wrong llmux 401s,
          // so it is dropped and re-issued instead.
          U2: { id: 'k-2', secret: 'lmk-orphan', keyPrefix: 'lmk-orp', name: 'U2' },
        },
      }),
    );
    resetLlmuxTenantKeysForTests(storePath);

    await expect(ensureTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-v1-secret',
      baseUrl: LOCAL,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    mockEmptyDaemon(newKeyDoc({ id: 'k-2b', name: 'U2', key: 'lmk-reissued' }));
    await expect(ensureTenantKey('U2')).resolves.toEqual({ secret: 'lmk-reissued', baseUrl: LOCAL });
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

    const lease = { secret: 'lmk-abcdef-secret', baseUrl: LOCAL };
    expect(await Promise.all(calls)).toEqual([lease, lease]);
    expect(urlsOf().filter((url) => url === NEW_URL)).toHaveLength(1);
  });
});
