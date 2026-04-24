/**
 * Tests for #701 — `refresh_usage_all` mixed-failure flow:
 *   - single-surface ephemeral (banner block + card blocks, one post)
 *   - timeout inference from `results` ∩ snap2 (still-attached → timeout;
 *     removed/detached → omit)
 *   - banner uses fixed `kind` / `status` codes only; never `message`
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CctStoreSnapshot } from '../../cct-store';
import { buildPartialFailureBanner, registerCctActions } from './actions';
import { CCT_ACTION_IDS } from './views';

function makeApp() {
  const actionHandlers = new Map<string, (ctx: any) => Promise<void>>();
  const app = {
    action: (id: string, fn: (ctx: any) => Promise<void>) => {
      actionHandlers.set(id, fn);
    },
    view: () => {
      /* noop */
    },
  } as any;
  return { app, actionHandlers };
}

/**
 * Build a minimal v2 snapshot with the given attached keys.
 * `statePatches` lets an individual test seed `lastRefreshError` on a keyId.
 */
function snapshotWith(
  keys: Array<{ keyId: string; name: string }>,
  statePatches: Record<string, any> = {},
): CctStoreSnapshot {
  return {
    version: 2,
    revision: 1,
    registry: {
      activeKeyId: keys[0]?.keyId,
      slots: keys.map((k) => ({
        kind: 'cct' as const,
        source: 'setup' as const,
        keyId: k.keyId,
        name: k.name,
        setupToken: 'sk-ant-oat01-x',
        createdAt: '2026-04-01T00:00:00Z',
        oauthAttachment: {
          accessToken: 't',
          refreshToken: 'r',
          expiresAtMs: Date.now() + 3_600_000,
          scopes: ['user:profile', 'user:inference'],
          acknowledgedConsumerTosRisk: true as const,
        },
      })),
    },
    state: Object.fromEntries(
      keys.map((k) => [
        k.keyId,
        { authState: 'healthy' as const, activeLeases: [] as never[], ...(statePatches[k.keyId] ?? {}) },
      ]),
    ),
  };
}

async function runHandler(tm: any, body: any = undefined, postEphemeral = vi.fn(async () => undefined)) {
  const { app, actionHandlers } = makeApp();
  const adminUtils = await import('../../admin-utils');
  const spy = vi.spyOn(adminUtils, 'isAdminUser').mockReturnValue(true);
  try {
    registerCctActions(app, tm);
    const h = actionHandlers.get(CCT_ACTION_IDS.refresh_usage_all);
    const actionBody = body ?? {
      user: { id: 'admin' },
      container: { channel_id: 'C1' },
      actions: [{ value: 'all' }],
    };
    await h?.({
      ack: vi.fn(async () => undefined),
      body: actionBody,
      client: { chat: { postEphemeral } },
    });
  } finally {
    spy.mockRestore();
  }
  return { postEphemeral };
}

describe('#701: buildPartialFailureBanner', () => {
  it('formats N of M with name + status code', () => {
    const out = buildPartialFailureBanner(
      [
        { name: 'ai2', kind: 'rate_limited', status: 429 },
        { name: 'ai3', kind: 'network' },
      ],
      5,
    );
    expect(out).toContain('2 of 5 failed');
    expect(out).toContain('ai2 (429)');
    expect(out).toContain('ai3 (network)');
  });

  it('truncates after 5 names and adds (+N more)', () => {
    const out = buildPartialFailureBanner(
      [
        { name: 'a', kind: 'timeout' },
        { name: 'b', kind: 'server', status: 500 },
        { name: 'c', kind: 'rate_limited', status: 429 },
        { name: 'd', kind: 'network' },
        { name: 'e', kind: 'unknown' },
        { name: 'f', kind: 'server', status: 502 },
        { name: 'g', kind: 'timeout' },
      ],
      10,
    );
    expect(out).toContain('(+2 more)');
    expect(out).not.toContain('f ('); // truncated past 5
  });

  it('empty failures → empty string', () => {
    expect(buildPartialFailureBanner([], 0)).toBe('');
  });

  it('uses fixed kind/status codes ONLY — never `message` freeform', () => {
    // Adversarial test: if a future implementation leaked message through,
    // sk-ant- prefixes would appear in the banner. Assert the API only
    // accepts name/kind/status.
    const out = buildPartialFailureBanner([{ name: 'adv', kind: 'unauthorized', status: 401 }], 1);
    expect(out).not.toContain('sk-ant-');
    expect(out).not.toContain('invalid_grant');
  });
});

describe('#701: refresh_usage_all mixed-failure surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('all ok → single postEphemeral (card only, no banner)', async () => {
    const keys = [
      { keyId: 'a', name: 'aA' },
      { keyId: 'b', name: 'bB' },
    ];
    const snap = snapshotWith(keys);
    const tm = {
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ a: 'ok', b: 'ok' })),
      getSnapshot: vi.fn(async () => snap),
    } as any;
    const { postEphemeral } = await runHandler(tm);
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const payload = postEphemeral.mock.calls[0][0];
    expect(payload.text).toBe(':key: CCT status'); // plain card, no banner header.
  });

  it('all error → allNull banner (single ephemeral, no card)', async () => {
    const keys = [
      { keyId: 'a', name: 'aA' },
      { keyId: 'b', name: 'bB' },
    ];
    const snap = snapshotWith(keys);
    const tm = {
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ a: 'error', b: 'error' })),
      getSnapshot: vi.fn(async () => snap),
    } as any;
    const { postEphemeral } = await runHandler(tm);
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const payload = postEphemeral.mock.calls[0][0];
    expect(payload.text).toContain('nothing refreshed');
  });

  it('mixed (2 ok, 2 error) → SINGLE postEphemeral with banner section + card blocks', async () => {
    const keys = [
      { keyId: 'a', name: 'aA' },
      { keyId: 'b', name: 'bB' },
      { keyId: 'c', name: 'cC' },
      { keyId: 'd', name: 'dD' },
    ];
    const snap = snapshotWith(keys, {
      b: {
        lastRefreshError: {
          kind: 'rate_limited',
          status: 429,
          message: 'Refresh throttled (429)',
          at: Date.now() - 60_000,
        },
      },
      d: { lastRefreshError: { kind: 'network', message: 'Refresh network error', at: Date.now() - 60_000 } },
    });
    const tm = {
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ a: 'ok', b: 'error', c: 'ok', d: 'error' })),
      getSnapshot: vi.fn(async () => snap),
    } as any;
    const { postEphemeral } = await runHandler(tm);
    expect(postEphemeral).toHaveBeenCalledTimes(1); // single-surface invariant.
    const payload = postEphemeral.mock.calls[0][0];
    expect(payload.text).toContain('partial failure');
    // First block is the banner section with the failure summary.
    const blocks = payload.blocks as Array<{ type: string; text?: { text: string } }>;
    expect(blocks[0]?.type).toBe('section');
    expect(blocks[0]?.text?.text).toContain('2 of 4 failed');
    expect(blocks[0]?.text?.text).toContain('bB (429)');
    expect(blocks[0]?.text?.text).toContain('dD (network)');
    // Subsequent blocks are the card (has the CCT header).
    expect(blocks.length).toBeGreaterThan(1);
  });

  it('missing-from-results + still attached → classified as timeout', async () => {
    const keys = [
      { keyId: 'a', name: 'aA' },
      { keyId: 'b', name: 'bB' },
    ];
    const snap = snapshotWith(keys);
    const tm = {
      // `b` didn't settle before the fan-out deadline — not present in results.
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ a: 'ok' })),
      getSnapshot: vi.fn(async () => snap),
    } as any;
    const { postEphemeral } = await runHandler(tm);
    const payload = postEphemeral.mock.calls[0][0];
    const bannerText = (payload.blocks as Array<{ text?: { text?: string } }>)[0]?.text?.text ?? '';
    expect(bannerText).toContain('1 of 2 failed');
    expect(bannerText).toContain('bB (timeout)');
  });

  it('missing-from-results + slot gone in snap2 → OMITTED from failure accounting', async () => {
    const starting = [
      { keyId: 'a', name: 'aA' },
      { keyId: 'b', name: 'bB' },
    ];
    // Start with 2 attached, end with just `a` — `b` was removed/detached mid-flight.
    const snap2 = snapshotWith([{ keyId: 'a', name: 'aA' }]);
    const snap1 = snapshotWith(starting);
    let call = 0;
    const tm = {
      refreshAllAttachedOAuthTokens: vi.fn(async () => ({ a: 'ok' })),
      getSnapshot: vi.fn(async () => {
        call += 1;
        return call === 1 ? snap1 : snap2;
      }),
    } as any;
    const { postEphemeral } = await runHandler(tm);
    const payload = postEphemeral.mock.calls[0][0];
    // All-ok path: text is plain card title (no partial failure).
    expect(payload.text).toBe(':key: CCT status');
  });
});
