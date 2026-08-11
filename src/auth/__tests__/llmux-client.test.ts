import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control-plane calls now authenticate with the ADMIN key (llmux requires one
// even on loopback since it went multi-tenant), so the client reads
// `getLlmuxAdminKey()` rather than the data-plane `apiKey`.
vi.mock('../auth-runtime', () => ({
  getLlmuxSettings: () => ({ baseUrl: 'http://localhost:3456', apiKey: 'llmux-local' }),
  getLlmuxAdminKey: () => 'admin-key',
}));

import {
  addLlmuxAccount,
  fetchLlmuxStatus,
  isLlmuxUp,
  LlmuxClientError,
  removeLlmuxAccount,
  switchLlmuxAccount,
} from '../llmux-client';

const STATUS_DOC = {
  version: '0.2.11',
  pid: 1,
  uptime_secs: 120,
  port: 3456,
  email_anonymous: false,
  current: 'claude:me@example.com',
  current_by_group: { claude: 'claude:me@example.com' },
  accounts: [
    {
      name: 'claude:me@example.com',
      type: 'oauth',
      group: 'claude',
      status: 'active',
      order: 1,
      blocked: null,
      five_hour: { utilization: 0.6, resets_at: 1_900_000_000, resets_in_secs: 3600 },
      seven_day: { utilization: 0.2, resets_at: 1_900_400_000, resets_in_secs: 400_000 },
      in_flight: 0,
      totals: { requests: 10, input_tokens: 100, output_tokens: 50 },
    },
  ],
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('llmux-client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchLlmuxStatus GETs /llmux/status with the admin x-api-key header', async () => {
    fetchMock.mockResolvedValue(okResponse(STATUS_DOC));
    const status = await fetchLlmuxStatus();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3456/llmux/status',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-api-key': 'admin-key' }),
      }),
    );
    expect(status.current).toBe('claude:me@example.com');
    expect(status.accounts).toHaveLength(1);
    expect(status.accounts[0].five_hour?.utilization).toBe(0.6);
  });

  it('honors a baseUrl override (Settings modal candidate probe)', async () => {
    fetchMock.mockResolvedValue(okResponse(STATUS_DOC));
    await fetchLlmuxStatus({ baseUrl: 'http://10.1.1.1:9999/' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://10.1.1.1:9999/llmux/status');
  });

  it('switchLlmuxAccount POSTs the account body and surfaces 409 refusals', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, current: 'claude:b@example.com' }));
    const result = await switchLlmuxAccount('claude:b@example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3456/llmux/switch',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ account: 'claude:b@example.com' }) }),
    );
    expect(result.current).toBe('claude:b@example.com');

    // Fresh Response per call — a Response body is single-read.
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: 'switch refused: cooldown' } }), {
          status: 409,
        }),
    );
    await expect(switchLlmuxAccount('claude:c@example.com')).rejects.toThrowError(/switch refused: cooldown/);
    await expect(switchLlmuxAccount('claude:c@example.com')).rejects.toMatchObject({ status: 409 });
  });

  it('addLlmuxAccount omits name when not provided', async () => {
    fetchMock.mockImplementation(async () => okResponse({ ok: true, name: 'api-1', type: 'apikey', added: true }));
    await addLlmuxAccount({ apiKey: 'sk-ant-api03-xyz' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ api_key: 'sk-ant-api03-xyz' });
    await addLlmuxAccount({ apiKey: 'sk-ant-api03-xyz', name: 'work' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ api_key: 'sk-ant-api03-xyz', name: 'work' });
  });

  it('removeLlmuxAccount always sends confirm:true (llmux refuses silent deletes)', async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await removeLlmuxAccount('api-1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'api-1', confirm: true });
  });

  it('network failure surfaces as LlmuxClientError with the base URL', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchLlmuxStatus()).rejects.toBeInstanceOf(LlmuxClientError);
    await expect(fetchLlmuxStatus()).rejects.toThrowError(/unreachable at http:\/\/localhost:3456/);
  });

  it('isLlmuxUp returns false instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(isLlmuxUp()).resolves.toBe(false);
    fetchMock.mockImplementation(async () => okResponse(STATUS_DOC));
    await expect(isLlmuxUp()).resolves.toBe(true);
  });
});
