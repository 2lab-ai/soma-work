import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EchartsInitError, FontLoadError, ResvgNativeError, SlackPostError } from '../../metrics/usage-render/errors';
import type { CarouselStats, CarouselTabStats, EmptyTabStats, TabId } from '../../metrics/usage-render/types';
import type { CommandContext, CommandDependencies } from './types';
import { TabCache } from './usage-carousel-cache';
import {
  __setSleepImplForTests,
  hasExtraCardArgs,
  isCardSubcommand,
  type UsageCardOverrides,
  UsageHandler,
} from './usage-handler';

// Trace: docs/usage-card-dark/trace.md, Scenarios 1, 9, 12, 13, 15

// ─── Test-support helpers ──────────────────────────────────────────────

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
    aggregatorError?: Error;
    rendererError?: Error;
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
  const aggregateCarousel = vi.fn(async () => {
    if (opts.aggregatorError) throw opts.aggregatorError;
    return opts.carouselStats ?? makeCarouselStats();
  });
  const renderCarousel = vi.fn(async () => {
    if (opts.rendererError) throw opts.rendererError;
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
    aggregator: { aggregateCarousel: aggregateCarousel as any },
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

// ─── Pure parser tests ─────────────────────────────────────────────────

describe('isCardSubcommand', () => {
  it.each([
    ['usage card', true],
    ['/usage card', true],
    ['USAGE CARD', true],
    ['usage', false],
    ['/usage', false],
    ['usage today', false],
    ['usage 7d', false],
    ['usage 30d', false],
    ['random text', false],
  ])('%s → %s', (text, expected) => {
    expect(isCardSubcommand(text)).toBe(expected);
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

// ─── Subcommand routing ────────────────────────────────────────────────
// Scenario 15 — non-`card` subcommands MUST NOT invoke `handleCard`. The
// legacy bare `/usage` text path is untouched by this refactor.

describe('UsageHandler subcommand routing', () => {
  it.each([
    ['usage', 'bare /usage'],
    ['usage today', '/usage today'],
    ['usage 7d', '/usage 7d'],
    ['usage 30d', '/usage 30d'],
  ])('%s never invokes handleCard', async (text, _label) => {
    const { overrides, aggregateCarousel } = makeCarouselOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    const cardSpy = vi.spyOn(handler, 'handleCard');
    try {
      await handler.execute(makeCtx({ text }));
    } catch {
      // bare `/usage` text path hits filesystem through a real MetricsEventStore;
      // that throw is orthogonal — contract here is routing-only.
    }
    expect(cardSpy).not.toHaveBeenCalled();
    expect(aggregateCarousel).not.toHaveBeenCalled();
  });

  it('/usage <@OTHER_USER> hits privacy gate, never card path', async () => {
    const { overrides, aggregateCarousel } = makeCarouselOverrides();
    const deps = makeDeps();
    const handler = new UsageHandler(deps, overrides);
    const cardSpy = vi.spyOn(handler, 'handleCard');
    await handler.execute(makeCtx({ text: 'usage <@U_BOB>', user: 'U_ALICE' }));
    expect(cardSpy).not.toHaveBeenCalled();
    expect(aggregateCarousel).not.toHaveBeenCalled();
    expect(deps.slackApi.postSystemMessage).toHaveBeenCalledTimes(1);
    const msg = (deps.slackApi.postSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(msg).toContain('다른 사용자');
  });

  it('`/usage card` routes to carousel (aggregateCarousel called)', async () => {
    const { overrides, aggregateCarousel, renderCarousel, filesUploadV2, postMessage } = makeCarouselOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.execute(makeCtx({ text: 'usage card' }));
    expect(result.handled).toBe(true);
    expect(aggregateCarousel).toHaveBeenCalledTimes(1);
    expect(renderCarousel).toHaveBeenCalledTimes(1);
    expect(filesUploadV2).toHaveBeenCalledTimes(4);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

// ─── Strict param gate (spec §3) ───────────────────────────────────────

describe('UsageHandler.handleCard — strict param gate (spec §3)', () => {
  it('rejects `/usage card <@other>` with extra-arg error', async () => {
    const { overrides, aggregateCarousel, renderCarousel } = makeCarouselOverrides();
    const deps = makeDeps();
    const handler = new UsageHandler(deps, overrides);

    const result = await handler.handleCard(makeCtx({ text: 'usage card <@U_BOB>', user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(aggregateCarousel).not.toHaveBeenCalled();
    expect(renderCarousel).not.toHaveBeenCalled();
    expect((deps.slackApi as any).postSystemMessage).toHaveBeenCalledWith(
      'C_TEST',
      expect.stringMatching(/추가 인자를 받지 않습니다/),
      expect.anything(),
    );
  });

  it('rejects `/usage card foo` with extra-arg error', async () => {
    const { overrides, aggregateCarousel } = makeCarouselOverrides();
    const deps = makeDeps();
    const handler = new UsageHandler(deps, overrides);

    const result = await handler.handleCard(makeCtx({ text: 'usage card foo', user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(aggregateCarousel).not.toHaveBeenCalled();
    expect((deps.slackApi as any).postSystemMessage).toHaveBeenCalledWith(
      'C_TEST',
      expect.stringMatching(/추가 인자를 받지 않습니다/),
      expect.anything(),
    );
  });
});

// ─── Carousel path ─────────────────────────────────────────────────────
// Trace: docs/usage-card-dark/trace.md, Scenario 1 (+ 12 all-empty, 13 errors).

describe('UsageHandler.handleCard — carousel', () => {
  beforeEach(() => {
    // Instant-return sleep so the retry loop does not consume wall time.
    __setSleepImplForTests(async () => {});
  });
  afterEach(() => {
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

  // ─── Error whitelist (spec §4.4) ─────────────────────────────────────

  const whitelistErrorCases: Array<[string, () => Error]> = [
    ['FontLoadError', () => new FontLoadError('no font')],
    ['EchartsInitError', () => new EchartsInitError('echarts boom')],
    ['ResvgNativeError', () => new ResvgNativeError('resvg native')],
  ];

  it.each(
    whitelistErrorCases,
  )('%s from renderCarousel → safe-error ephemeral fallback + DM alert', async (_name, makeErr) => {
    const { overrides, postEphemeral, openDmChannel, postMessage } = makeCarouselOverrides({
      rendererError: makeErr(),
    });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
    expect(openDmChannel).toHaveBeenCalledWith('U_ALICE');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0].channel).toBe('D_DM');
  });

  it('directly-thrown SlackPostError from renderer → safe-error fallback', async () => {
    const { overrides, postEphemeral } = makeCarouselOverrides({
      rendererError: new SlackPostError('raw post'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('non-whitelisted error (RangeError) → re-throws (no swallow, no DM)', async () => {
    const { overrides, postEphemeral, openDmChannel } = makeCarouselOverrides({
      rendererError: new RangeError('not safe'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);
    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(postEphemeral).not.toHaveBeenCalled();
    expect(openDmChannel).not.toHaveBeenCalled();
  });

  it('non-whitelisted error from aggregator → re-throws', async () => {
    const { overrides, postEphemeral } = makeCarouselOverrides({
      aggregatorError: new RangeError('agg boom'),
    });
    const handler = new UsageHandler(makeDeps(), overrides);
    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it('DM channel open failure is swallowed (ephemeral fallback still sent)', async () => {
    const { overrides, openDmChannel, postEphemeral } = makeCarouselOverrides({
      rendererError: new EchartsInitError('boom'),
    });
    openDmChannel.mockRejectedValueOnce(new Error('conversations.open failed'));
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx({ user: 'U_ALICE' }));
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalled();
  });

  it('DM postMessage rejection is swallowed (does not bubble out of handler)', async () => {
    const { overrides, openDmChannel, postMessage, postEphemeral } = makeCarouselOverrides({
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
});
