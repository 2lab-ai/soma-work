/**
 * 세션 링크 자동 기록 (SSOT 2026-11-02) — the issues, PRs and wikis an assistant reply names reach the host
 * (`onLinksMentioned`), so the task card can show them.
 *
 *   P1  a reply naming a PR, an issue and a wiki: the host gets the three links, each once
 *   P2  a reply with no such URL: no call; a throwing host callback never breaks the turn
 *   P3  what a reply quotes is not what it says: code blocks and a release_notes directive's shipped PRs are not counted
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../stream-processor';

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

function context(): StreamContext {
  return {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity: LOG_MINIMAL,
    say: vi.fn().mockResolvedValue({ ts: 'm' }) as unknown as StreamContext['say'],
  };
}

const REPLY =
  'PR을 열었습니다: https://github.com/2lab-ai/soma-work/pull/776 (이슈 https://2lab.atlassian.net/browse/PAY-12, ' +
  '설계 https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design). 다시: https://github.com/2lab-ai/soma-work/pull/776';

describe('onLinksMentioned', () => {
  it('P1 — a reply naming a PR, an issue and a wiki hands the host the three links', async () => {
    const seen: string[] = [];
    const onLinksMentioned = vi.fn((links: Array<{ url: string; type: string }>) => {
      for (const l of links) seen.push(`${l.type} ${l.url}`);
    });
    await new AgentStreamProcessor({ onLinksMentioned }).process(
      events([
        { type: 'assistant_delta', text: REPLY },
        { type: 'result', stopReason: 'end_turn', finalText: REPLY },
      ]),
      context(),
      new AbortController().signal,
    );
    expect(onLinksMentioned).toHaveBeenCalled();
    expect([...new Set(seen)]).toEqual([
      'pr https://github.com/2lab-ai/soma-work/pull/776',
      'issue https://2lab.atlassian.net/browse/PAY-12',
      'doc https://2lab.atlassian.net/wiki/spaces/PAY/pages/123456/Payment+Form+Design',
    ]);
  });

  it('P2 — no link, no call; a throwing host never breaks the turn', async () => {
    const quiet = vi.fn();
    await new AgentStreamProcessor({ onLinksMentioned: quiet }).process(
      events([
        { type: 'assistant_delta', text: '끝났습니다. https://example.com 참고' },
        { type: 'result', stopReason: 'end_turn', finalText: '끝났습니다.' },
      ]),
      context(),
      new AbortController().signal,
    );
    expect(quiet).not.toHaveBeenCalled();
    const boom = vi.fn(() => {
      throw new Error('boom');
    });
    const r = await new AgentStreamProcessor({ onLinksMentioned: boom }).process(
      events([
        { type: 'assistant_delta', text: REPLY },
        { type: 'result', stopReason: 'end_turn', finalText: REPLY },
      ]),
      context(),
      new AbortController().signal,
    );
    expect(boom).toHaveBeenCalled();
    expect(r.success).toBe(true);
  });

  it("P3 — code and a release_notes directive are not the reply's links", async () => {
    const notes = JSON.stringify({
      type: 'release_notes',
      repo: 'acme/App',
      target: 'deploy/dev',
      version: '1.0.0',
      tldr: ['a', 'b', 'c'],
      text: '- https://github.com/acme/App/pull/1\n- https://github.com/acme/App/pull/2',
    });
    const reply = [
      '배포했습니다: https://github.com/acme/App/pull/3',
      '```',
      'https://github.com/acme/App/pull/4',
      '```',
      notes,
    ].join('\n');
    const seen: string[] = [];
    await new AgentStreamProcessor({
      onLinksMentioned: (links) => {
        for (const l of links) seen.push(l.url);
      },
    }).process(
      events([
        { type: 'assistant_delta', text: reply },
        { type: 'result', stopReason: 'end_turn', finalText: reply },
      ]),
      context(),
      new AbortController().signal,
    );
    expect([...new Set(seen)]).toEqual(['https://github.com/acme/App/pull/3']);
  });
});
