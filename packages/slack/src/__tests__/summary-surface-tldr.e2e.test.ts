import { describe, expect, it, vi } from 'vitest';
import { StreamExecutor } from '../pipeline/stream-executor';
import { SummaryService } from '../summary-service';
import { type ConversationSession, ThreadSurface, type ThreadSurfaceDeps } from '../thread-surface';

/**
 * End to end: summary timer fires → Slack payloads.
 *
 * SSOT (Z, 2026-10-22): "스레드안에는 전체를 출력하고 스레드 서피스 (채널에서
 * 보이는 화면)에는 별도로 세줄요약으로 출력해줘 … 익스큐티브 서머리를 항상
 * tldr이랑 같이 받고 스레드 서피스에는 tldr만 출력"
 *
 * Drives the real `StreamExecutor.onSummaryTimerFire`, the real
 * `SummaryService` and the real `ThreadSurface` against a fake Slack API that
 * records the exact `chat.update` / `chat.postMessage` payloads. Only the LLM
 * fork is stubbed. In a bot-initiated thread the surface message IS the thread
 * root — the message the channel timeline shows.
 */

const KEY = 'C1:1700.000000';
const ROOT_TS = '1700.000000';

const BODY_MARKER = 'Edited packages/slack/src/summary-service.ts:551 and ran npx vitest run (101 passed).';
const ES_RESPONSE = [
  '<tldr>',
  'PR #332 merged: the channel now shows a 3-line TL;DR.',
  'The full Executive Summary is posted inside the thread.',
  'Next: deploy to dev and check one real turn.',
  '</tldr>',
  '',
  '## SSOT',
  '```',
  '스레드 서피스에는 tldr만 출력',
  '```',
  '## Status',
  '- PR: https://github.com/2lab-ai/soma-work/pull/332 — Merged',
  '## Summary',
  BODY_MARKER,
].join('\n');

interface Captured {
  channel: string;
  ts?: string;
  text: string;
  blocks: any[];
  threadTs?: string;
}

function makeSlackApi() {
  const updates: Captured[] = [];
  const posts: Captured[] = [];
  return {
    updates,
    posts,
    getClient: vi.fn().mockReturnValue({}),
    getPermalink: vi.fn().mockResolvedValue('https://slack.example/p'),
    updateMessage: vi.fn(async (channel: string, ts: string, text: string, blocks: any[]) => {
      updates.push({ channel, ts, text, blocks });
    }),
    postMessage: vi.fn(async (channel: string, text: string, options: any) => {
      posts.push({ channel, text, blocks: options?.blocks ?? [], threadTs: options?.threadTs });
      return { ts: 'posted-ts' };
    }),
  };
}

function makeSession(): ConversationSession {
  return {
    sessionId: 'sess-1',
    channelId: 'C1',
    threadTs: ROOT_TS,
    threadRootTs: ROOT_TS,
    threadModel: 'bot-initiated',
    ownerId: 'U1',
    ownerName: 'zhuge',
    title: 'TL;DR demo',
    isActive: true,
    terminated: false,
    actionPanel: { channelId: 'C1', messageTs: ROOT_TS },
  } as ConversationSession;
}

/** Every mrkdwn/plain text string anywhere in a Block Kit payload, joined. */
function allText(node: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      const r = n as Record<string, unknown>;
      if (typeof r.type === 'string' && typeof r.text === 'string') out.push(r.text);
      Object.values(r).forEach(walk);
    }
  };
  walk(node);
  return out.join('\n');
}

async function fireSummaryTimer(response: string) {
  const session = makeSession();
  const slackApi = makeSlackApi();
  const surface = new ThreadSurface({
    slackApi: slackApi as any,
    claudeHandler: { getSessionByKey: vi.fn().mockReturnValue(session) } as any,
    requestCoordinator: { isRequestActive: vi.fn().mockReturnValue(false) } as any,
    todoManager: { getTodos: vi.fn().mockReturnValue([]), getEffectiveStatus: vi.fn() } as any,
  } as ThreadSurfaceDeps);
  const fork = vi.fn().mockResolvedValue(response);
  const summaryService = new SummaryService(fork, slackApi as any);
  const executor = new StreamExecutor({
    summaryService,
    threadPanel: { updatePanel: (s: any, k: string) => surface.updatePanel(s, k) },
  } as any);

  await (executor as any).onSummaryTimerFire(session, KEY);

  return { session, slackApi, fork };
}

describe('Executive Summary end to end — channel surface gets the TL;DR, the thread gets everything', () => {
  it('chat.update on the thread root carries only the 3 TL;DR lines', async () => {
    const { slackApi } = await fireSummaryTimer(ES_RESPONSE);

    // Every surface write goes to the thread root in this channel, and none
    // of them — not only the last — may leak the ES body.
    expect(slackApi.updates.length).toBeGreaterThan(0);
    for (const update of slackApi.updates) {
      expect(update).toMatchObject({ channel: 'C1', ts: ROOT_TS });
      expect(allText(update.blocks)).not.toContain(BODY_MARKER);
    }
    // Nothing is posted to the channel root: every post is a thread reply.
    for (const post of slackApi.posts) expect(post.threadTs).toBe(ROOT_TS);
    const surface = allText(slackApi.updates.at(-1)!.blocks);

    expect(surface).toContain('Executive Summary · TL;DR');
    expect(surface).toContain('PR #332 merged: the channel now shows a 3-line TL;DR.');
    expect(surface).toContain('The full Executive Summary is posted inside the thread.');
    expect(surface).toContain('Next: deploy to dev and check one real turn.');
    expect(surface).not.toContain(BODY_MARKER);
    expect(surface).not.toContain('스레드 서피스에는 tldr만 출력');
    expect(surface).not.toContain('pull/332 — Merged');
    expect(surface).not.toMatch(/<\/?tldr>/i);
  });

  it('chat.postMessage into the thread carries the TL;DR and the full summary', async () => {
    const { slackApi } = await fireSummaryTimer(ES_RESPONSE);

    const summaryPosts = slackApi.posts.filter((p) => allText(p.blocks).includes('Executive Summary'));
    expect(summaryPosts).toHaveLength(1);
    expect(summaryPosts[0]).toMatchObject({ channel: 'C1', threadTs: ROOT_TS });
    const thread = allText(summaryPosts[0].blocks);

    expect(thread).toContain('*TL;DR*');
    expect(thread).toContain('PR #332 merged: the channel now shows a 3-line TL;DR.');
    expect(thread).toContain('The full Executive Summary is posted inside the thread.');
    expect(thread).toContain('Next: deploy to dev and check one real turn.');
    expect(thread).toContain('스레드 서피스에는 tldr만 출력');
    expect(thread).toContain('pull/332 — Merged');
    expect(thread).toContain(BODY_MARKER);
    expect(thread).not.toMatch(/<\/?tldr>/i);
  });

  it('every summary fork is asked for the <tldr> block', async () => {
    const { fork } = await fireSummaryTimer(ES_RESPONSE);

    const prompt = fork.mock.calls[0][0] as string;
    expect(prompt).toContain('<tldr>');
    expect(prompt).toMatch(/exactly 3 lines/i);
  });

  it('a summary without a TL;DR still keeps the channel to one pointer line and the thread complete', async () => {
    const untagged = ES_RESPONSE.slice(ES_RESPONSE.indexOf('## SSOT'));
    const { slackApi } = await fireSummaryTimer(untagged);

    const surface = allText(slackApi.updates.filter((u) => u.ts === ROOT_TS).at(-1)!.blocks);
    expect(surface).toContain('TL;DR not generated');
    expect(surface).not.toContain(BODY_MARKER);

    const thread = allText(slackApi.posts.find((p) => p.threadTs === ROOT_TS)!.blocks);
    expect(thread).toContain(BODY_MARKER);
  });
});
