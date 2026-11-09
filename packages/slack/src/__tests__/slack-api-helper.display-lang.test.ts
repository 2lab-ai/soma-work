import { currentDisplayLang, runWithDisplayLang } from '@soma/common/i18n';
import { describe, expect, it, vi } from 'vitest';
import { SlackApiHelper } from '../slack-api-helper';

/**
 * The display language is per call (#774): the Slack boundary translates a bot message for the reader of the work that
 * sent it, reading `currentDisplayLang()` when the request leaves. Every call rides ONE rate-limit queue, drained by a
 * loop that the first call to find the queue idle starts — so a call queued behind it must still leave in its own
 * caller's language, not in the language of the call that happened to start the drain.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A helper whose first call holds the drain until `release()`; every call records the language it left in. */
function harness() {
  const seen: Array<[string, string]> = [];
  const blocker = deferred();
  const app = {
    client: {
      chat: {
        postMessage: vi.fn(async (payload: any) => {
          seen.push([payload.text, currentDisplayLang()]);
          // the queue runs one call at a time: only the first one ever waits here
          await blocker.promise;
          return { ok: true, ts: '111.222' };
        }),
      },
    },
  };
  return { seen, release: blocker.resolve, helper: new SlackApiHelper(app as any, { minInterval: 0 }) };
}

describe('SlackApiHelper — a queued call keeps its caller display language', () => {
  it('runs each queued call in the language it was queued under, not the drainer one', async () => {
    const { seen, release, helper } = harness();

    // A Korean turn starts the drain and holds it; an English and another Korean call queue behind it.
    const ko = runWithDisplayLang('ko', () => helper.postMessage('C1', 'ko-head'));
    const en = runWithDisplayLang('en', () => helper.postMessage('C2', 'en-header'));
    const ko2 = runWithDisplayLang('ko', () => helper.postMessage('C3', 'ko-after'));
    release();
    await Promise.all([ko, en, ko2]);

    expect(seen).toEqual([
      ['ko-head', 'ko'],
      ['en-header', 'en'],
      ['ko-after', 'ko'],
    ]);
  });

  it('an English drain does not turn a Korean call behind it English', async () => {
    const { seen, release, helper } = harness();

    const en = runWithDisplayLang('en', () => helper.postMessage('C1', 'en-head'));
    const ko = runWithDisplayLang('ko', () => helper.postMessage('C2', 'ko-header'));
    release();
    await Promise.all([en, ko]);

    expect(seen).toEqual([
      ['en-head', 'en'],
      ['ko-header', 'ko'],
    ]);
  });
});
