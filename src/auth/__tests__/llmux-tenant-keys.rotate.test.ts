import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same frozen config as llmux-tenant-keys.test.ts — independent of the host env.
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
import {
  checkTenantKey,
  describeTenantKey,
  ensureTenantKey,
  resetLlmuxTenantKeysForTests,
  rotateTenantKey,
} from '../llmux-tenant-keys';

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const LOCAL = 'http://localhost:3456';
const KEYS_URL = `${LOCAL}/llmux/keys`;
const NEW_URL = `${LOCAL}/llmux/keys/new`;
const ROTATE_URL = `${LOCAL}/llmux/keys/rotate`;

/** `POST /llmux/keys/new` success payload (llmux `keys_new_endpoint`). */
const ISSUED = {
  ok: true,
  id: 'k-1',
  name: 'Zhuge (U1)',
  kind: 'default',
  key_prefix: 'lmk-old1',
  suspended: false,
  revoked_at_ms: null,
  key: 'lmk-old1-secret',
};

/** `POST /llmux/keys/rotate` success payload (llmux `keys_rotate_endpoint`: the secret sits in `.key.key`). */
function rotatedDoc(id: string, secret: string) {
  return {
    ok: true,
    key: { id, name: 'Zhuge (U1)', key_prefix: secret.slice(0, 8), revoked_at_ms: null, key: secret },
  };
}

describe('llmux tenant keys — `key rotate` and stale-key detection', () => {
  let dir: string;
  let storePath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmux-tenant-keys-rotate-'));
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

  const urlsOf = () => fetchMock.mock.calls.map((c) => c[0]);

  /** Seed the store with an issued key (k-1 / lmk-old1-secret), then clear the call log. */
  async function seedIssuedKey() {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/llmux/keys') ? okResponse({ keys: [] }) : okResponse(ISSUED),
    );
    await ensureTenantKey('U1', { name: 'Zhuge' });
    fetchMock.mockReset();
  }

  // ===== rotateTenantKey =====

  it('rotates the stored key in place: one rotate call, new secret stored and served', async () => {
    await seedIssuedKey();
    const issuedAtMs = describeTenantKey('U1')?.issuedAtMs;
    fetchMock.mockResolvedValue(okResponse(rotatedDoc('k-1', 'lmk-new1-secret')));

    await expect(rotateTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-new1-secret',
      baseUrl: LOCAL,
    });

    expect(urlsOf()).toEqual([ROTATE_URL]);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers['x-api-key']).toBe('admin-key');
    expect(JSON.parse(init.body)).toEqual({ id: 'k-1' });

    // Same llmux id (usage history continues), new secret, rotation stamped.
    const meta = describeTenantKey('U1');
    expect(meta).toMatchObject({ id: 'k-1', keyPrefix: 'lmk-new1', issuedAtMs });
    expect(meta?.rotatedAtMs).toEqual(expect.any(Number));
    const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    expect(persisted.tenants.U1[LOCAL].secret).toBe('lmk-new1-secret');

    // Dispatches pick the new secret up from the store — no further llmux traffic.
    fetchMock.mockClear();
    await expect(ensureTenantKey('U1')).resolves.toEqual({ secret: 'lmk-new1-secret', baseUrl: LOCAL });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to issuing a new key when the stored id no longer exists at llmux (404)', async () => {
    await seedIssuedKey();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === ROTATE_URL) return okResponse({ error: { message: 'client key not found' } }, 404);
      if (url === KEYS_URL) return okResponse({ keys: [{ id: 'k-1', name: 'Zhuge (U1)', revoked_at_ms: 1 }] });
      return okResponse({ ...ISSUED, id: 'k-2', key_prefix: 'lmk-new2', key: 'lmk-new2-secret' });
    });

    await expect(rotateTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-new2-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([ROTATE_URL, KEYS_URL, NEW_URL]);
    expect(describeTenantKey('U1')).toMatchObject({ id: 'k-2', keyPrefix: 'lmk-new2' });
  });

  it('with no stored key, reclaims the user’s live llmux key by rotating it (no second tenant)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === KEYS_URL) return okResponse({ keys: [{ id: 'k-live', name: 'Zhuge (U1)', revoked_at_ms: null }] });
      return okResponse(rotatedDoc('k-live', 'lmk-live-secret'));
    });

    await expect(rotateTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-live-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, ROTATE_URL]);
  });

  it('keeps the old key when llmux refuses the rotation (non-404), and reports failure', async () => {
    await seedIssuedKey();
    fetchMock.mockResolvedValue(okResponse({ error: { message: 'boom' } }, 500));

    await expect(rotateTenantKey('U1')).resolves.toBeNull();
    expect(urlsOf()).toEqual([ROTATE_URL]);
    // Nothing was replaced: the stored secret is still the one served.
    fetchMock.mockClear();
    await expect(ensureTenantKey('U1')).resolves.toEqual({ secret: 'lmk-old1-secret', baseUrl: LOCAL });
  });

  it('an explicit rotate is not suppressed by an earlier failed issuance', async () => {
    fetchMock.mockResolvedValue(okResponse({}, 500));
    await expect(ensureTenantKey('U1')).resolves.toBeNull(); // negative-cached now
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      url === KEYS_URL ? okResponse({ keys: [] }) : okResponse(ISSUED),
    );

    await expect(rotateTenantKey('U1', { name: 'Zhuge' })).resolves.toEqual({
      secret: 'lmk-old1-secret',
      baseUrl: LOCAL,
    });
    expect(urlsOf()).toEqual([KEYS_URL, NEW_URL]);
  });

  it('serializes rotations queued behind an in-flight issuance — the store ends on llmux’s live secret', async () => {
    let releaseIssue!: (res: Response) => void;
    const issueGate = new Promise<Response>((resolve) => {
      releaseIssue = resolve;
    });
    let rotations = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === KEYS_URL) return Promise.resolve(okResponse({ keys: [] }));
      if (url === NEW_URL) return issueGate;
      rotations += 1;
      const n = rotations;
      // The first rotation answers slowly: if both ran at once it would land last.
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(okResponse(rotatedDoc('k-1', `lmk-rot${n}-secret`))), n === 1 ? 30 : 0),
      );
    });

    const issued = ensureTenantKey('U1', { name: 'Zhuge' });
    const first = rotateTenantKey('U1');
    const second = rotateTenantKey('U1');
    releaseIssue(okResponse(ISSUED));

    await issued;
    await expect(first).resolves.toEqual({ secret: 'lmk-rot1-secret', baseUrl: LOCAL });
    await expect(second).resolves.toEqual({ secret: 'lmk-rot2-secret', baseUrl: LOCAL });
    // llmux's last rotation is the live secret, and the store holds exactly that.
    await expect(ensureTenantKey('U1')).resolves.toEqual({ secret: 'lmk-rot2-secret', baseUrl: LOCAL });
  });

  it('never throws: unreachable llmux → null', async () => {
    await seedIssuedKey();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(rotateTenantKey('U1')).resolves.toBeNull();
  });

  it('returns null without any llmux call outside llmux mode', async () => {
    setAuthMode('ccp');
    await expect(rotateTenantKey('U1')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ===== checkTenantKey =====

  it('reports `valid` when llmux still holds the stored secret', async () => {
    await seedIssuedKey();
    fetchMock.mockResolvedValue(
      okResponse({ keys: [{ id: 'k-1', name: 'Zhuge (U1)', key_prefix: 'lmk-old1', revoked_at_ms: null }] }),
    );
    await expect(checkTenantKey('U1')).resolves.toBe('valid');
    expect(urlsOf()).toEqual([KEYS_URL]);
  });

  it('reports `stale` when the key was rotated outside soma-work (prefix moved on)', async () => {
    await seedIssuedKey();
    // The 2026-11-23 incident: an admin ran `llmux key rotate` — same id, new prefix.
    fetchMock.mockResolvedValue(
      okResponse({ keys: [{ id: 'k-1', name: 'Zhuge (U1)', key_prefix: 'lmk-NEWP', revoked_at_ms: null }] }),
    );
    await expect(checkTenantKey('U1')).resolves.toBe('stale');
  });

  it('reports `stale` when the stored id is revoked or gone', async () => {
    await seedIssuedKey();
    fetchMock.mockResolvedValueOnce(
      okResponse({ keys: [{ id: 'k-1', name: 'Zhuge (U1)', key_prefix: 'lmk-old1', revoked_at_ms: 5 }] }),
    );
    await expect(checkTenantKey('U1')).resolves.toBe('stale');
    fetchMock.mockResolvedValueOnce(okResponse({ keys: [] }));
    await expect(checkTenantKey('U1')).resolves.toBe('stale');
  });

  it('reports `unknown` when it cannot tell (no stored key, listing error, network error)', async () => {
    await expect(checkTenantKey('U1')).resolves.toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();

    await seedIssuedKey();
    fetchMock.mockResolvedValueOnce(okResponse({ error: 'forbidden' }, 403));
    await expect(checkTenantKey('U1')).resolves.toBe('unknown');
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(checkTenantKey('U1')).resolves.toBe('unknown');
  });
});
