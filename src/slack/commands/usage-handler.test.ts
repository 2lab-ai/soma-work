import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EchartsInitError,
  FontLoadError,
  ResvgNativeError,
  SlackPostError,
  SlackUploadError,
} from '../../metrics/usage-render/errors';
import type {
  CarouselStats,
  CarouselTabStats,
  EmptyTabStats,
  TabId,
  UsageCardStats,
} from '../../metrics/usage-render/types';
import type { CommandContext, CommandDependencies } from './types';
import { TabCache } from './usage-carousel-cache';
import {
  __setSleepImplForTests,
  hasExtraCardArgs,
  isCardSubcommand,
  type UsageCardOverrides,
  UsageHandler,
} from './usage-handler';

// Trace: docs/usage-card/trace.md, Scenarios 1, 8, 9, 10, 11, 12

function makeStats(partial: Partial<UsageCardStats> = {}): UsageCardStats {
  return {
    empty: false,
    targetUserId: 'U_ALICE',
    targetUserName: 'Alice',
    windowStart: '2026-03-19',
    windowEnd: '2026-04-17',
    totals: { last24h: 100, last7d: 500, last30d: 12345, costLast30dUsd: 0.42 },
    heatmap: Array.from({ length: 42 }, (_, i) => ({ date: i >= 12 ? `d${i}` : '', tokens: 0, cellIndex: i })),
    hourly: new Array(24).fill(0),
    rankings: { tokensTop: [], costTop: [], targetTokenRow: null, targetCostRow: null },
    sessions: { tokenTop3: [], spanTop3: [] },
    favoriteModel: null,
    currentStreakDays: 1,
    totalSessions: 1,
    ...partial,
  };
}

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    user: 'U_ALICE',
    channel: 'C_TEST',
    threadTs: '1.1',
    text: 'usage card',
    say: vi.fn(),
    ...overrides,
  };
}

function makeDeps(): CommandDependencies {
  return {
    slackApi: {
      postSystemMessage: vi.fn().mockResolvedValue({}),
      postMessage: vi.fn().mockResolvedValue({}),
      postEphemeral: vi.fn().mockResolvedValue({}),
      openDmChannel: vi.fn().mockResolvedValue('D_DM'),
      getClient: () => ({}),
    },
  } as unknown as CommandDependencies;
}

function makeOverrides(
  opts: {
    stats?: UsageCardStats | { empty: true; windowStart: string; windowEnd: string; targetUserId: string };
    rendererError?: Error;
    uploadError?: Error;
    aggregatorError?: Error;
  } = {},
): {
  overrides: UsageCardOverrides;
  aggregator: { aggregateUsageCard: ReturnType<typeof vi.fn> };
  renderer: ReturnType<typeof vi.fn>;
  filesUploadV2: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  postEphemeral: ReturnType<typeof vi.fn>;
  openDmChannel: ReturnType<typeof vi.fn>;
} {
  const aggregator = {
    aggregateUsageCard: vi.fn(async () => {
      if (opts.aggregatorError) throw opts.aggregatorError;
      return opts.stats ?? makeStats();
    }),
  };
  const renderer = vi.fn(async () => {
    if (opts.rendererError) throw opts.rendererError;
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0, 0x0, 0x0, 0x0]);
  });
  const filesUploadV2 = vi.fn(async () => {
    if (opts.uploadError) throw opts.uploadError;
    return { files: [{ files: [{ id: 'F_TEST' }] }] };
  });
  // postMessage is no longer used on the success path — it only fires from
  // `postDmAlert` when a safe-operational error falls back to DM notification.
  const postMessage = vi.fn().mockResolvedValue({});
  const postEphemeral = vi.fn().mockResolvedValue({});
  const openDmChannel = vi.fn().mockResolvedValue('D_DM');
  const overrides: UsageCardOverrides = {
    aggregator: aggregator as any,
    renderer: renderer as any,
    slackApi: { filesUploadV2, postMessage, postEphemeral, openDmChannel },
    clock: () => new Date('2026-04-17T14:00:00+09:00'),
  };
  return { overrides, aggregator, renderer, filesUploadV2, postMessage, postEphemeral, openDmChannel };
}

describe('isCardSubcommand', () => {
  it.each([
    ['usage card', true],
    ['/usage card', true],
    ['USAGE CARD', true],
    ['usage', false],
    ['/usage', false],
    ['usage today', false],
    ['usage 30d', false],
    ['usage week', false],
    ['usage month', false],
  ])('%s → %s', (text, expected) => {
    expect(isCardSubcommand(text)).toBe(expected);
  });
});

describe('UsageHandler subcommand routing', () => {
  it('bare `/usage` does NOT call card handler (falls through to text path)', async () => {
    const { overrides, aggregator } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    // Replace handleCard so we know whether it was invoked.
    const spy = vi.spyOn(handler, 'handleCard');
    try {
      await handler.execute(makeCtx({ text: 'usage' }));
    } catch {
      // text path may fail on filesystem — ignore, we only care about routing.
    }
    expect(spy).not.toHaveBeenCalled();
    expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
  });

  // Scenario 15 (trace rev-2) — regression matrix: every non-`card` subcommand
  // must keep the v1 text path untouched, regardless of USAGE_CARD_V2 flag.
  // The legacy text path builds a fresh MetricsEventStore internally (no DI),
  // so on fs failure we swallow the throw — the contract here is narrow:
  //   * handleCard spy never fires
  //   * carousel aggregator never fires (aggregateCarousel / aggregateUsageCard)
  //   * privacy-gate subcommand still reaches postSystemMessage with the
  //     rejection message instead of the card path.
  describe('Scenario 15 — v1 text-command regression matrix', () => {
    const originalFlag = process.env.USAGE_CARD_V2;
    afterEach(() => {
      if (originalFlag === undefined) delete process.env.USAGE_CARD_V2;
      else process.env.USAGE_CARD_V2 = originalFlag;
    });

    it.each([
      ['usage', 'bare /usage'],
      ['usage today', '/usage today'],
      ['usage 7d', '/usage 7d'],
      ['usage 30d', '/usage 30d'],
    ])('%s never invokes card path (flag on)', async (text, _label) => {
      process.env.USAGE_CARD_V2 = 'true';
      const { overrides, aggregator } = makeOverrides();
      const carouselSpy = vi.fn();
      (overrides.aggregator as unknown as { aggregateCarousel?: typeof carouselSpy }).aggregateCarousel = carouselSpy;

      const handler = new UsageHandler(makeDeps(), overrides);
      const cardSpy = vi.spyOn(handler, 'handleCard');
      try {
        await handler.execute(makeCtx({ text }));
      } catch {
        /* v1 text path hits filesystem — ignore, contract is routing-only */
      }
      expect(cardSpy).not.toHaveBeenCalled();
      expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
      expect(carouselSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['usage', 'bare /usage'],
      ['usage today', '/usage today'],
      ['usage 7d', '/usage 7d'],
      ['usage 30d', '/usage 30d'],
    ])('%s never invokes card path (flag off)', async (text, _label) => {
      delete process.env.USAGE_CARD_V2;
      const { overrides, aggregator } = makeOverrides();
      const handler = new UsageHandler(makeDeps(), overrides);
      const cardSpy = vi.spyOn(handler, 'handleCard');
      try {
        await handler.execute(makeCtx({ text }));
      } catch {
        /* v1 text path hits filesystem — ignore */
      }
      expect(cardSpy).not.toHaveBeenCalled();
      expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
    });

    it('/usage <@OTHER_USER> hits privacy gate, never card path', async () => {
      const { overrides, aggregator } = makeOverrides();
      const deps = makeDeps();
      const handler = new UsageHandler(deps, overrides);
      const cardSpy = vi.spyOn(handler, 'handleCard');
      await handler.execute(makeCtx({ text: 'usage <@U_BOB>', user: 'U_ALICE' }));
      expect(cardSpy).not.toHaveBeenCalled();
      expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
      expect(deps.slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
      const msg = (deps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(msg).toContain('다른 사용자');
    });
  });

  it('`/usage card` invokes handleCard path', async () => {
    const { overrides, aggregator, renderer, filesUploadV2, postMessage } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.execute(makeCtx({ text: 'usage card' }));
    expect(result.handled).toBe(true);
    expect(aggregator.aggregateUsageCard).toHaveBeenCalledTimes(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    // 1-step upload: no follow-up postMessage on the success path.
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('UsageHandler.handleCard — happy path', () => {
  it('calls aggregator → renderer → filesUploadV2 (1-step upload, no separate postMessage)', async () => {
    const { overrides, aggregator, renderer, filesUploadV2, postMessage } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);

    await handler.handleCard(makeCtx());

    expect(aggregator.aggregateUsageCard).toHaveBeenCalled();
    expect(renderer).toHaveBeenCalled();
    // filesUploadV2 must carry channel_id + thread_ts + initial_comment so Slack
    // posts the file into the originating thread in one call. This is the whole
    // point of the 1-step fix (issue #579) — no follow-up Block Kit postMessage.
    expect(filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'usage-card.png',
        channel_id: 'C_TEST',
        thread_ts: '1.1',
        initial_comment: expect.stringContaining('Usage Card'),
        alt_text: expect.stringContaining('Usage card for'),
        request_file_info: false,
      }),
    );
    // Legacy field `channels` (plural) must NOT be passed — the SDK would
    // silently prefer it over `channel_id` and we'd lose the thread placement.
    const uploadArgs = filesUploadV2.mock.calls[0][0] as Record<string, unknown>;
    expect(uploadArgs).not.toHaveProperty('channels');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('passes 30d window (startDate, endDate) to aggregator', async () => {
    const { overrides, aggregator } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    await handler.handleCard(makeCtx());
    const call = aggregator.aggregateUsageCard.mock.calls[0][0];
    expect(call.targetUserId).toBe('U_ALICE');
    // clock is 2026-04-17 KST, month = today-29 = 2026-03-19
    expect(call.endDate).toBe('2026-04-17');
    expect(call.startDate).toBe('2026-03-19');
  });
});

describe('UsageHandler.handleCard — empty short-circuit', () => {
  it('renderer/upload/post NOT called when stats.empty', async () => {
    const { overrides, renderer, filesUploadV2, postMessage, postEphemeral } = makeOverrides({
      stats: { empty: true, windowStart: '2026-03-19', windowEnd: '2026-04-17', targetUserId: 'U_ALICE' },
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(renderer).not.toHaveBeenCalled();
    expect(filesUploadV2).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('최근 30일간') }),
    );
  });
});

describe('UsageHandler.handleCard — strict param gate (spec §3)', () => {
  it('rejects `/usage card <@other>` with extra-arg error', async () => {
    const { overrides, aggregator, renderer } = makeOverrides();
    const deps = makeDeps();
    const handler = new UsageHandler(deps, overrides);

    const result = await handler.handleCard(makeCtx({ text: 'usage card <@U_BOB>', user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
    expect(renderer).not.toHaveBeenCalled();
    expect((deps.slackApi as any).postSystemMessage).toHaveBeenCalledWith(
      'C_TEST',
      expect.stringMatching(/추가 인자를 받지 않습니다/),
      expect.anything(),
    );
  });

  it('rejects `/usage card foo` with extra-arg error', async () => {
    const { overrides, aggregator } = makeOverrides();
    const deps = makeDeps();
    const handler = new UsageHandler(deps, overrides);

    const result = await handler.handleCard(makeCtx({ text: 'usage card foo', user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(aggregator.aggregateUsageCard).not.toHaveBeenCalled();
    expect((deps.slackApi as any).postSystemMessage).toHaveBeenCalledWith(
      'C_TEST',
      expect.stringMatching(/추가 인자를 받지 않습니다/),
      expect.anything(),
    );
  });
});

describe('hasExtraCardArgs', () => {
  it.each([
    ['usage card', false],
    ['/usage card', false],
    ['  usage   card  ', false],
    ['usage card foo', true],
    ['usage card <@U_BOB>', true],
    ['/usage card trailing junk', true],
  ])('%s → %s', (text, expected) => {
    expect(hasExtraCardArgs(text)).toBe(expected);
  });
});

describe('UsageHandler.handleCard — error fallback', () => {
  const errorCases: Array<[string, () => Error]> = [
    ['FontLoadError', () => new FontLoadError('no font')],
    ['EchartsInitError', () => new EchartsInitError('echarts boom')],
    ['ResvgNativeError', () => new ResvgNativeError('resvg native')],
  ];

  it.each(errorCases)('%s from renderer → ephemeral fallback text', async (_name, makeErr) => {
    const { overrides, postEphemeral } = makeOverrides({ rendererError: makeErr() });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('SlackUploadError wraps uploadV2 failure → ephemeral fallback (no card post)', async () => {
    const { overrides, postEphemeral, postMessage } = makeOverrides({
      uploadError: new Error('upload boom'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    // postMessage is used for DM alert only (no card post). Assert the
    // single call went to a DM channel, not the caller's channel.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].channel).not.toBe('C_TEST');
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('directly-thrown SlackUploadError (already safe) → fallback', async () => {
    // Even if the error is already the expected subclass, handler must still fallback.
    const { overrides, postEphemeral } = makeOverrides({ uploadError: new SlackUploadError('raw') });
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('non-whitelisted error (RangeError) from renderer → re-throws (no swallow)', async () => {
    const { overrides, postEphemeral } = makeOverrides({ rendererError: new RangeError('not safe') });
    const handler = new UsageHandler(makeDeps(), overrides);

    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it('non-whitelisted error from aggregator → re-throws', async () => {
    const { overrides, postEphemeral } = makeOverrides({ aggregatorError: new RangeError('agg boom') });
    const handler = new UsageHandler(makeDeps(), overrides);

    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it('directly-thrown SlackPostError from renderer path → fallback (no re-throw)', async () => {
    const { overrides, postEphemeral } = makeOverrides({ rendererError: new SlackPostError('raw post') });
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });
});

describe('UsageHandler.handleCard — DM alert (spec §4.4)', () => {
  it('safe-error path also opens DM channel and posts alert with error kind', async () => {
    const { overrides, openDmChannel, postMessage, postEphemeral } = makeOverrides({
      rendererError: new FontLoadError('missing'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));

    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalled();
    expect(openDmChannel).toHaveBeenCalledWith('U_ALICE');
    // Two postMessage calls would be wrong — original card post never happened,
    // so this should be the first and only postMessage invocation (the DM).
    expect(postMessage).toHaveBeenCalledTimes(1);
    const dmCall = postMessage.mock.calls[0][0];
    expect(dmCall.channel).toBe('D_DM');
    expect(dmCall.text).toMatch(/FontLoadError/);
  });

  it('DM alert fires for SlackUploadError too', async () => {
    const { overrides, openDmChannel, postMessage } = makeOverrides({
      uploadError: new Error('upload boom'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);
    await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(openDmChannel).toHaveBeenCalledWith('U_ALICE');
    const dmCall = postMessage.mock.calls[0][0];
    expect(dmCall.text).toMatch(/SlackUploadError/);
  });

  it('DM channel open failure is swallowed (does not bubble out of handler)', async () => {
    const { overrides, openDmChannel, postEphemeral } = makeOverrides({
      rendererError: new EchartsInitError('boom'),
    });
    openDmChannel.mockRejectedValueOnce(new Error('conversations.open failed'));
    const handler = new UsageHandler(makeDeps(), overrides);

    // Must not throw.
    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    // Ephemeral channel fallback still sent.
    expect(postEphemeral).toHaveBeenCalled();
  });

  it('DM postMessage rejection is swallowed (does not bubble out of handler)', async () => {
    // The 1-step upload fix removed the success-path postMessage, but
    // `postDmAlert` still calls postMessage to deliver the DM notification.
    // A rejection there must not mask the ephemeral channel fallback.
    const { overrides, openDmChannel, postMessage, postEphemeral } = makeOverrides({
      rendererError: new EchartsInitError('boom'),
    });
    postMessage.mockRejectedValueOnce(new Error('chat.postMessage to DM failed'));
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(openDmChannel).toHaveBeenCalledWith('U_ALICE');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postEphemeral).toHaveBeenCalled();
  });

  it('non-whitelisted errors do NOT trigger DM alert', async () => {
    const { overrides, openDmChannel } = makeOverrides({ rendererError: new RangeError('not safe') });
    const handler = new UsageHandler(makeDeps(), overrides);
    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(openDmChannel).not.toHaveBeenCalled();
  });
});

// ─── Carousel (v2) — Scenario 1 + 12 + 13 ──────────────────────────────
// Trace: docs/usage-card-dark/trace.md, Scenario 1 (lines 38–73).

const ALL_TABS: readonly TabId[] = ['24h', '7d', '30d', 'all'] as const;

function makeTabStats(tabId: TabId, overrides: Partial<CarouselTabStats> = {}): CarouselTabStats {
  return {
    empty: false,
    tabId,
    targetUserId: 'U_ALICE',
    targetUserName: 'Alice',
    windowStart: '2026-03-19',
    windowEnd: '2026-04-17',
    totals: { tokens: 100, costUsd: 0.1, sessions: 1 },
    favoriteModel: null,
    hourly: new Array(24).fill(0),
    heatmap: [],
    rankings: { tokensTop: [], targetTokenRow: null },
    activeDays: 1,
    longestStreakDays: 1,
    currentStreakDays: 1,
    topSessions: [],
    longestSession: null,
    mostActiveDay: null,
    ...overrides,
  };
}

function makeEmptyTab(tabId: TabId): EmptyTabStats {
  return { empty: true, tabId, windowStart: '2026-03-19', windowEnd: '2026-04-17' };
}

function makeCarouselStats(partial: Partial<Record<TabId, CarouselTabStats | EmptyTabStats>> = {}): CarouselStats {
  return {
    targetUserId: 'U_ALICE',
    targetUserName: 'Alice',
    now: '2026-04-17T14:00:00+09:00',
    tabs: {
      '24h': partial['24h'] ?? makeTabStats('24h'),
      '7d': partial['7d'] ?? makeTabStats('7d'),
      '30d': partial['30d'] ?? makeTabStats('30d'),
      all: partial.all ?? makeTabStats('all'),
    },
  };
}

function makeCarouselOverrides(
  opts: {
    carouselStats?: CarouselStats;
    pngMap?: Record<TabId, Buffer>;
    postMessageReturn?: { ts: string };
    postMessageThrows?: unknown[];
    uploadError?: Error;
  } = {},
): {
  overrides: UsageCardOverrides;
  aggregateCarousel: ReturnType<typeof vi.fn>;
  renderCarousel: ReturnType<typeof vi.fn>;
  filesUploadV2: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  postEphemeral: ReturnType<typeof vi.fn>;
  openDmChannel: ReturnType<typeof vi.fn>;
  tabCache: TabCache;
} {
  const aggregateCarousel = vi.fn(async () => opts.carouselStats ?? makeCarouselStats());
  const renderCarousel = vi.fn(async () => {
    return (
      opts.pngMap ?? {
        '24h': Buffer.from([0x89]),
        '7d': Buffer.from([0x89]),
        '30d': Buffer.from([0x89]),
        all: Buffer.from([0x89]),
      }
    );
  });
  let uploadCallIdx = 0;
  const filesUploadV2 = vi.fn(async (_args: Record<string, unknown>) => {
    if (opts.uploadError) throw opts.uploadError;
    const idx = uploadCallIdx++;
    const tab = ALL_TABS[idx] ?? ('x' as TabId);
    return { files: [{ files: [{ id: `F_${tab}` }] }] };
  });
  const postMessage = vi.fn();
  if (opts.postMessageThrows && opts.postMessageThrows.length > 0) {
    for (const err of opts.postMessageThrows) {
      postMessage.mockRejectedValueOnce(err);
    }
    postMessage.mockResolvedValue(opts.postMessageReturn ?? { ts: 'TS_POST' });
  } else {
    postMessage.mockResolvedValue(opts.postMessageReturn ?? { ts: 'TS_POST' });
  }
  const postEphemeral = vi.fn().mockResolvedValue({});
  const openDmChannel = vi.fn().mockResolvedValue('D_DM');
  // Pin TabCache's internal clock to the handler's fake clock, otherwise
  // entries written with `expiresAt = fakeNow + 24h` would already look expired
  // under real `Date.now()`.
  const tabCache = new TabCache({ now: () => new Date('2026-04-17T14:00:00+09:00').getTime() });

  const overrides: UsageCardOverrides = {
    aggregator: {
      aggregateUsageCard: vi.fn() as any,
      aggregateCarousel: aggregateCarousel as any,
    },
    renderCarousel: renderCarousel as any,
    slackApi: { filesUploadV2, postMessage, postEphemeral, openDmChannel },
    clock: () => new Date('2026-04-17T14:00:00+09:00'),
    tabCache,
  };
  return {
    overrides,
    aggregateCarousel,
    renderCarousel,
    filesUploadV2,
    postMessage,
    postEphemeral,
    openDmChannel,
    tabCache,
  };
}

describe('UsageHandler.handleCard — carousel (v2)', () => {
  beforeEach(() => {
    process.env.USAGE_CARD_V2 = 'true';
    // Instant-return sleep so the retry loop does not consume wall time.
    __setSleepImplForTests(async () => {});
  });
  afterEach(() => {
    delete process.env.USAGE_CARD_V2;
    __setSleepImplForTests(null);
  });

  it('happy path: aggregateCarousel → renderCarousel → 4× filesUploadV2 → 1× postMessage → tabCache set', async () => {
    const { overrides, aggregateCarousel, renderCarousel, filesUploadV2, postMessage, tabCache } =
      makeCarouselOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());

    expect(result.handled).toBe(true);
    expect(aggregateCarousel).toHaveBeenCalledTimes(1);
    expect(aggregateCarousel.mock.calls[0][0]).toEqual(expect.objectContaining({ targetUserId: 'U_ALICE' }));
    expect(renderCarousel).toHaveBeenCalledTimes(1);
    expect(renderCarousel.mock.calls[0][1]).toBe('30d');

    expect(filesUploadV2).toHaveBeenCalledTimes(4);
    for (const call of filesUploadV2.mock.calls) {
      const args = call[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty('channel_id');
      expect(args).not.toHaveProperty('channels');
      expect(args).not.toHaveProperty('thread_ts');
      expect(args).not.toHaveProperty('initial_comment');
      expect(args.request_file_info).toBe(false);
      expect(String(args.filename)).toMatch(/^usage-card-(24h|7d|30d|all)\.png$/);
    }

    expect(postMessage).toHaveBeenCalledTimes(1);
    const postArgs = postMessage.mock.calls[0][0];
    expect(postArgs.channel).toBe('C_TEST');
    expect(postArgs.thread_ts).toBe('1.1');
    const blocks = postArgs.blocks as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].slack_file.id).toBe('F_30d');
    expect(blocks[2].block_id).toBe('usage_card_tabs');

    const cached = tabCache.get('TS_POST');
    expect(cached).toBeDefined();
    expect(cached!.userId).toBe('U_ALICE');
    expect(cached!.fileIds).toEqual({ '24h': 'F_24h', '7d': 'F_7d', '30d': 'F_30d', all: 'F_all' });
  });

  it('flag off → v1 path (aggregateCarousel NOT called; v1 aggregateUsageCard + 1× filesUploadV2 with channel_id)', async () => {
    delete process.env.USAGE_CARD_V2;

    const v1 = makeOverrides();
    const aggregateCarousel = vi.fn(async () => makeCarouselStats());
    (v1.overrides.aggregator as any).aggregateCarousel = aggregateCarousel;
    const renderCarousel = vi.fn();
    v1.overrides.renderCarousel = renderCarousel as any;

    const handler = new UsageHandler(makeDeps(), v1.overrides);
    const result = await handler.handleCard(makeCtx());

    expect(result.handled).toBe(true);
    expect(aggregateCarousel).not.toHaveBeenCalled();
    expect(renderCarousel).not.toHaveBeenCalled();
    expect(v1.aggregator.aggregateUsageCard).toHaveBeenCalledTimes(1);
    expect(v1.filesUploadV2).toHaveBeenCalledTimes(1);
    const uploadArgs = v1.filesUploadV2.mock.calls[0][0] as Record<string, unknown>;
    expect(uploadArgs.channel_id).toBe('C_TEST');
    expect(uploadArgs.thread_ts).toBe('1.1');
    expect(uploadArgs).toHaveProperty('initial_comment');
  });

  it('all-empty short-circuit: all 4 tabs empty → ephemeral, no render/upload/post', async () => {
    const allEmpty = makeCarouselStats({
      '24h': makeEmptyTab('24h'),
      '7d': makeEmptyTab('7d'),
      '30d': makeEmptyTab('30d'),
      all: makeEmptyTab('all'),
    });
    const { overrides, renderCarousel, filesUploadV2, postMessage, postEphemeral, tabCache } = makeCarouselOverrides({
      carouselStats: allEmpty,
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());

    expect(result.handled).toBe(true);
    expect(renderCarousel).not.toHaveBeenCalled();
    expect(filesUploadV2).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('최근 30일간') }),
    );
    expect(tabCache.size()).toBe(0);
  });

  it('partial-empty passes through: 24h empty, others non-empty → render + upload + post still fire', async () => {
    const partialStats = makeCarouselStats({ '24h': makeEmptyTab('24h') });
    const { overrides, renderCarousel, filesUploadV2, postMessage, tabCache } = makeCarouselOverrides({
      carouselStats: partialStats,
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    await handler.handleCard(makeCtx());

    expect(renderCarousel).toHaveBeenCalledTimes(1);
    expect(filesUploadV2).toHaveBeenCalledTimes(4);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(tabCache.get('TS_POST')).toBeDefined();
  });

  it('cold-cache retry: postMessage throws invalid_blocks 2× then succeeds → postMessage called 3×, tabCache keyed by final ts', async () => {
    const invalidBlocks = Object.assign(new Error('invalid_blocks'), {
      data: { error: 'invalid_blocks' },
    });
    const { overrides, postMessage, tabCache } = makeCarouselOverrides({
      postMessageThrows: [invalidBlocks, invalidBlocks],
      postMessageReturn: { ts: 'TS_OK' },
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());

    expect(result.handled).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(tabCache.get('TS_OK')).toBeDefined();
    expect(tabCache.get('TS_POST')).toBeUndefined();
  });

  it('retry exhausted: postMessage throws invalid_blocks 3× → safe-error ephemeral fallback (no throw escapes)', async () => {
    const invalidBlocks = Object.assign(new Error('invalid_blocks'), {
      data: { error: 'invalid_blocks' },
    });
    const { overrides, postMessage, postEphemeral, openDmChannel } = makeCarouselOverrides({
      postMessageThrows: [invalidBlocks, invalidBlocks, invalidBlocks],
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    // 3 card-post attempts (all fail) + 1 DM alert postMessage = 4 total.
    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
    expect(openDmChannel).toHaveBeenCalledWith('U_ALICE');
  });

  it('non-invalid_blocks postMessage error → no retry, safe-error path', async () => {
    const other = new Error('rate_limited');
    const { overrides, postMessage, postEphemeral } = makeCarouselOverrides({
      postMessageThrows: [other],
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    // 1 card-post attempt (throws immediately) + 1 DM alert.
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('upload error: filesUploadV2 rejects → SlackUploadError → ephemeral fallback', async () => {
    const { overrides, postEphemeral, postMessage } = makeCarouselOverrides({
      uploadError: new Error('upload boom'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].channel).toBe('D_DM');
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('actions block uses static block_id "usage_card_tabs" (no messageTs embedded)', async () => {
    const { overrides, postMessage } = makeCarouselOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    await handler.handleCard(makeCtx());

    const blocks = postMessage.mock.calls[0][0].blocks as any[];
    expect(blocks[2].block_id).toBe('usage_card_tabs');
    expect(blocks[2].block_id).not.toContain('TS_POST');
  });

  it('30d button has style:"primary" in posted blocks, others do not', async () => {
    const { overrides, postMessage } = makeCarouselOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    await handler.handleCard(makeCtx());

    const elements = (postMessage.mock.calls[0][0].blocks as any[])[2].elements;
    expect(elements[0].style).toBeUndefined(); // 24h
    expect(elements[1].style).toBeUndefined(); // 7d
    expect(elements[2].style).toBe('primary'); // 30d
    expect(elements[3].style).toBeUndefined(); // all
  });
});
