import { describe, expect, it, vi } from 'vitest';
import {
  EchartsInitError,
  FontLoadError,
  ResvgNativeError,
  SlackPostError,
  SlackUploadError,
} from '../../metrics/usage-render/errors';
import type { UsageCardStats } from '../../metrics/usage-render/types';
import type { CommandContext, CommandDependencies } from './types';
import { hasExtraCardArgs, isCardSubcommand, type UsageCardOverrides, UsageHandler } from './usage-handler';

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
    postError?: Error;
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
  const postMessage = vi.fn(async () => {
    if (opts.postError) throw opts.postError;
    return {};
  });
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

  it('`/usage card` invokes handleCard path', async () => {
    const { overrides, aggregator, renderer, filesUploadV2, postMessage } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);
    const result = await handler.execute(makeCtx({ text: 'usage card' }));
    expect(result.handled).toBe(true);
    expect(aggregator.aggregateUsageCard).toHaveBeenCalledTimes(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(filesUploadV2).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('UsageHandler.handleCard — happy path', () => {
  it('calls aggregator → renderer → filesUploadV2 → postMessage in order', async () => {
    const { overrides, aggregator, renderer, filesUploadV2, postMessage } = makeOverrides();
    const handler = new UsageHandler(makeDeps(), overrides);

    await handler.handleCard(makeCtx());

    expect(aggregator.aggregateUsageCard).toHaveBeenCalled();
    expect(renderer).toHaveBeenCalled();
    expect(filesUploadV2).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'usage-card.png', channel_id: 'C_TEST' }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C_TEST',
        blocks: expect.arrayContaining([expect.objectContaining({ type: 'image', slack_file: { id: 'F_TEST' } })]),
      }),
    );
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

  it('SlackPostError wraps postMessage failure → ephemeral fallback', async () => {
    const { overrides, postEphemeral } = makeOverrides({ postError: new Error('post boom') });
    const handler = new UsageHandler(makeDeps(), overrides);

    const result = await handler.handleCard(makeCtx());
    expect(result.handled).toBe(true);
    expect(postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '카드 생성 실패, 잠시 후 다시 시도해 주세요.' }),
    );
  });

  it('directly-thrown SlackUploadError / SlackPostError (already safe) → fallback', async () => {
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

  it('non-whitelisted errors do NOT trigger DM alert', async () => {
    const { overrides, openDmChannel } = makeOverrides({ rendererError: new RangeError('not safe') });
    const handler = new UsageHandler(makeDeps(), overrides);
    await expect(handler.handleCard(makeCtx())).rejects.toBeInstanceOf(RangeError);
    expect(openDmChannel).not.toHaveBeenCalled();
  });
});
