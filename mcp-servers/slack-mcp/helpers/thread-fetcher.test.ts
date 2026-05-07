/**
 * Regression: the named helpers below are imported by `slack-mcp-server.ts`.
 * They were silently de-exported once by an unused-export auto-fixer, which
 * crashed `get_thread_messages` at runtime with
 *   "(0 , import_thread_fetcher.getTotalCount) is not a function".
 *
 * This file pins the public surface so any future tool — or human — that
 * thinks these are unused has to delete this test first.
 */
import { describe, it, expect } from 'vitest';
import {
  getTotalCount,
  fetchThreadSlice,
  fetchMessagesBefore,
  fetchMessagesAfter,
} from './thread-fetcher.js';

describe('thread-fetcher public surface', () => {
  it('exports getTotalCount as a function', () => {
    expect(typeof getTotalCount).toBe('function');
  });

  it('exports fetchThreadSlice as a function', () => {
    expect(typeof fetchThreadSlice).toBe('function');
  });

  it('exports fetchMessagesBefore as a function', () => {
    expect(typeof fetchMessagesBefore).toBe('function');
  });

  it('exports fetchMessagesAfter as a function', () => {
    expect(typeof fetchMessagesAfter).toBe('function');
  });
});

describe('fetchMessagesBefore', () => {
  it('returns empty result without calling Slack when count is 0', async () => {
    const slack = {
      conversations: {
        replies: async () => {
          throw new Error('Slack API should not be called when count=0');
        },
      },
    } as any;

    const result = await fetchMessagesBefore(slack, 'C', 'T', 'A', 0);
    expect(result).toEqual({ messages: [], rootWasInjected: false });
  });
});

describe('fetchThreadSlice', () => {
  it('returns empty array when totalCount is 0', async () => {
    const slack = {
      conversations: {
        replies: async () => {
          throw new Error('Slack API should not be called when totalCount=0');
        },
      },
    } as any;

    const messages = await fetchThreadSlice(slack, 'C', 'T', 0, 10, 0);
    expect(messages).toEqual([]);
  });

  it('returns empty array when offset is past totalCount', async () => {
    const slack = {
      conversations: {
        replies: async () => {
          throw new Error('Slack API should not be called when offset>=totalCount');
        },
      },
    } as any;

    const messages = await fetchThreadSlice(slack, 'C', 'T', 100, 10, 5);
    expect(messages).toEqual([]);
  });
});
