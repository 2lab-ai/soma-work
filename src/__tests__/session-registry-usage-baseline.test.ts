import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted — keep the path computation inside the factory.
vi.mock('../env-paths', () => ({
  DATA_DIR: require('path').join(
    process.env.TMPDIR ?? require('os').tmpdir(),
    'soma-work-session-registry-usage-baseline-test',
  ),
}));

import { SessionRegistry } from '../session-registry';

const TEST_DATA_DIR = path.join(process.env.TMPDIR ?? os.tmpdir(), 'soma-work-session-registry-usage-baseline-test');

/**
 * RED — the last SDK running total (`sdkUsageBaseline`) must survive a
 * restart. The goal's spend is persisted: if the baseline were lost, the first
 * turn after a restart would credit the goal with the SDK session's whole
 * running total again.
 */
describe('SessionRegistry — sdkUsageBaseline persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('round-trips sdkUsageBaseline through save + load', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.101');
    session.sessionId = 'sdk-A';
    session.sdkUsageBaseline = {
      sdkSessionId: 'sdk-A',
      models: {
        'claude-opus-5-5[1m]': {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 10_000,
          cacheCreationInputTokens: 500,
          costUsd: 1.25,
        },
      },
    };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    expect(reader.getSession('C1', '171.101')?.sdkUsageBaseline).toEqual(session.sdkUsageBaseline);
  });

  it('drops a malformed persisted baseline instead of trusting it', () => {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', '171.102');
    session.sessionId = 'sdk-A';
    (session as any).sdkUsageBaseline = { sdkSessionId: 'sdk-A', models: { opus: { costUsd: 'lots' } } };
    writer.saveSessions();

    const reader = new SessionRegistry();
    reader.loadSessions();

    expect(reader.getSession('C1', '171.102')?.sdkUsageBaseline).toBeUndefined();
  });
});

/** What a 1M-window session's usage looks like after a few turns. */
function usageSample() {
  return {
    currentInputTokens: 32_960,
    currentOutputTokens: 8_240,
    currentCacheReadTokens: 354_320,
    currentCacheCreateTokens: 16_480,
    contextWindow: 1_000_000,
    totalInputTokens: 900_000,
    totalOutputTokens: 40_000,
    totalCacheReadTokens: 3_000_000,
    totalCacheCreateTokens: 90_000,
    totalCostUsd: 4.2,
    modelTotals: {
      'claude-opus-5-5[1m]': {
        inputTokens: 900_000,
        outputTokens: 40_000,
        cacheReadTokens: 3_000_000,
        cacheCreateTokens: 90_000,
        costUsd: 4.2,
      },
    },
    lastUpdated: 1_793_000_000_000,
  };
}

/**
 * RED — `session.usage` (the context fill, its window and the session totals)
 * must survive a restart. It was runtime-only, so after every deploy every
 * session lost its context gauge (dashboard <ui-context-window>, card "ctx N%")
 * until its next turn ended, and the compact threshold read restored sessions
 * as below threshold. On dev, 0 of 38 saved sessions carried it.
 */
describe('SessionRegistry — session.usage persistence', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  /** Save one session with `usage` as given, load it in a fresh registry, return what came back. */
  function roundTrip(threadTs: string, usage: unknown, model = 'claude-opus-5-5[1m]') {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', threadTs, model);
    session.sessionId = 'sdk-A';
    Object.assign(session, { usage });
    writer.saveSessions();
    const reader = new SessionRegistry();
    reader.loadSessions();
    return reader.getSession('C1', threadTs);
  }

  /** Write sessions.json by hand (a record another binary, or a corrupt write, left). */
  function loadRaw(threadTs: string, record: Record<string, unknown>) {
    const writer = new SessionRegistry();
    const session = writer.createSession('U1', 'Tester', 'C1', threadTs, 'claude-opus-5-5[1m]');
    session.sessionId = 'sdk-A';
    writer.saveSessions();
    const file = path.join(TEST_DATA_DIR, 'sessions.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    saved[0] = { ...saved[0], ...record };
    fs.writeFileSync(file, JSON.stringify(saved));
    const reader = new SessionRegistry();
    reader.loadSessions();
    return reader.getSession('C1', threadTs);
  }

  it('round-trips the context fill, the window and the totals through save + load', () => {
    const restored = roundTrip('171.301', usageSample());
    expect(restored?.usage).toEqual(usageSample());
  });

  it('a usage saved without per-model totals restores without them', () => {
    const { modelTotals: _, ...legacy } = usageSample();
    expect(roundTrip('171.302', legacy)?.usage).toEqual(legacy);
  });

  it('never persists the runtime-only fold; the saved totals leave it out so the next result cannot count it twice', () => {
    const folded = {
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 1_000,
      cacheCreateTokens: 50,
      costUsd: 0.5,
      sdkSessionId: 'sdk-A',
    };
    const restored = roundTrip('171.303', { ...usageSample(), foldedLiveUsage: folded });

    const saved = JSON.parse(fs.readFileSync(path.join(TEST_DATA_DIR, 'sessions.json'), 'utf-8'));
    expect(saved[0].usage).toBeDefined();
    expect(saved[0].usage).not.toHaveProperty('foldedLiveUsage');
    expect(restored?.usage?.foldedLiveUsage).toBeUndefined();
    // The transcript keeps the folded calls, so the SDK session's next result
    // carries them again: the restored totals are the settled ones.
    expect(restored?.usage).toMatchObject({
      totalInputTokens: 900_000 - 200,
      totalOutputTokens: 40_000 - 20,
      totalCacheReadTokens: 3_000_000 - 1_000,
      totalCacheCreateTokens: 90_000 - 50,
    });
    expect(restored?.usage?.totalCostUsd).toBeCloseTo(4.2 - 0.5);
    // The context fill is not spend — the fold leaves it as it was.
    expect(restored?.usage?.currentCacheReadTokens).toBe(354_320);
  });

  it('a session without usage still loads without it', () => {
    expect(roundTrip('171.304', undefined)?.usage).toBeUndefined();
  });

  it('drops unknown keys', () => {
    const restored = loadRaw('171.305', {
      usage: { ...usageSample(), mystery: 42, foldedLiveUsage: { inputTokens: 1 } },
    });
    expect(restored?.usage).toEqual(usageSample());
  });

  it.each([
    ['a negative count', { currentInputTokens: -1 }],
    ['a non-number count', { totalOutputTokens: '40000' }],
    ['a NaN count (JSON null)', { currentCacheReadTokens: null }],
    ['a missing count', { currentOutputTokens: undefined }],
    ['an infinite cost (JSON string)', { totalCostUsd: 'Infinity' }],
  ])('drops a usage with %s rather than trusting it', (_label, patch) => {
    const restored = loadRaw('171.306', { usage: { ...usageSample(), ...patch } });
    expect(restored?.usage).toBeUndefined();
  });

  it('drops a malformed per-model bucket and keeps the rest', () => {
    const sample = usageSample();
    const restored = loadRaw('171.307', {
      usage: { ...sample, modelTotals: { ...sample.modelTotals, broken: { inputTokens: -5, costUsd: 'x' } } },
    });
    expect(restored?.usage).toEqual(sample);
  });

  it.each([
    ['zero', 0],
    ['negative', -1_000],
    ['missing', undefined],
    ['string', '1000000'],
  ])('a %s window falls back to the session model window', (_label, contextWindow) => {
    const restored = loadRaw('171.308', { model: 'claude-opus-4-7', usage: { ...usageSample(), contextWindow } });
    // The bare claude-opus-4-7 profile is 200k (no [1m] opt-in).
    expect(restored?.usage?.contextWindow).toBe(200_000);
    expect(restored?.usage?.currentCacheReadTokens).toBe(354_320);
  });

  it('a bad window with no model to size it drops the usage', () => {
    const restored = loadRaw('171.309', { model: undefined, usage: { ...usageSample(), contextWindow: 0 } });
    expect(restored?.model).toBeUndefined();
    expect(restored?.usage).toBeUndefined();
  });
});
