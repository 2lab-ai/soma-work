/**
 * #772 — `<display-lang>` is for the model only. A reply that echoes it at the
 * end never shows it: not in the Slack post, not in the text the recorder
 * keeps. The tag quoted inside a reply (an explanation of it) stays.
 *
 *   E1  a reply ending with the tag: posted and collected without it
 *   E2  the same when only the final result carries the reply
 *   E3  a reply that is only the tag shows nothing
 *   E4  the tag quoted mid-reply stays as written
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../stream-processor';

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

function context() {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const ctx: StreamContext = {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity: LOG_MINIMAL,
    say: say as unknown as StreamContext['say'],
  };
  return { ctx, posted: () => JSON.stringify(say.mock.calls) };
}

const ANSWER = '대시보드 토글을 하나로 바꿨습니다.';

describe('#772 — the model echoing <display-lang>', () => {
  it('E1 — a reply ending with the tag is posted and collected without it', async () => {
    const { ctx, posted } = context();
    const reply = `${ANSWER}\n\n<display-lang>ko</display-lang>`;
    const r = await new AgentStreamProcessor({}).process(
      events([
        { type: 'assistant_delta', text: reply },
        { type: 'result', stopReason: 'end_turn', finalText: reply },
      ]),
      ctx,
      new AbortController().signal,
    );
    expect(posted()).toContain('대시보드 토글을 하나로 바꿨습니다');
    expect(posted()).not.toContain('display-lang');
    expect(r.collectedText ?? '').not.toContain('display-lang');
  });

  it('E2 — the same when only the final result carries the reply', async () => {
    const { ctx, posted } = context();
    const r = await new AgentStreamProcessor({}).process(
      events([{ type: 'result', stopReason: 'end_turn', finalText: `${ANSWER}\n<display-lang>en</display-lang>\n` }]),
      ctx,
      new AbortController().signal,
    );
    expect(posted()).toContain('대시보드 토글을 하나로 바꿨습니다');
    expect(posted()).not.toContain('display-lang');
    expect(r.collectedText ?? '').not.toContain('display-lang');
  });

  it('E3 — a reply that is only the tag shows nothing', async () => {
    const { ctx, posted } = context();
    await new AgentStreamProcessor({}).process(
      events([
        { type: 'assistant_delta', text: '<display-lang>ko</display-lang>' },
        { type: 'result', stopReason: 'end_turn', finalText: '<display-lang>ko</display-lang>' },
      ]),
      ctx,
      new AbortController().signal,
    );
    expect(posted()).not.toContain('display-lang');
  });

  it('E4 — the tag quoted mid-reply stays as written', async () => {
    const { ctx, posted } = context();
    const reply = '첫 프롬프트 맨 아래에 `<display-lang>ko</display-lang>`를 붙입니다. 끝.';
    await new AgentStreamProcessor({}).process(
      events([
        { type: 'assistant_delta', text: reply },
        { type: 'result', stopReason: 'end_turn', finalText: reply },
      ]),
      ctx,
      new AbortController().signal,
    );
    expect(posted()).toContain('<display-lang>ko</display-lang>');
  });
});
