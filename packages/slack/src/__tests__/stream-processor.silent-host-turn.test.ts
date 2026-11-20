/**
 * A turn the host started (a cron fire, a pr-watch message, an environment hand-off waking its requester, a goal
 * continuation — `StreamContext.isUserInputTurn === false`) that changed nothing ends without a message
 * (common.prompt "Host-woken turns"). Models do not always stop silently: they write a placeholder such as
 * `(no message)` as the turn's text, and the host posted it into the thread as the answer and logged it as the
 * turn's `final` — live 2026-11-20 on a daily-run thread polled every 30 minutes, where the placeholder became the
 * thread's last line and the run looked dead while it waited on its QA lane.
 *
 * A placeholder alone is silence: nothing to Slack, no `final` in the work log, and no withheld narration promoted in
 * its place. The turn's text keeps what the model wrote — the conversation record and the goal loop read it as before
 * (an empty turn text means "cut short" there). A user's turn is untouched — a user's instruction always gets a reply.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { getVerbosityFlags, LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamContext } from '../stream-processor';
import type { WorkLogInput } from '../work-log';

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

/** A poll turn: read a lock, then end with `last` as the text segment and `finalText` on the result. */
function pollTurn(last: string | undefined, finalText: string | undefined, narration?: string): AgentStreamEvent[] {
  return [
    ...(narration ? [{ type: 'assistant_delta', text: narration } as AgentStreamEvent] : []),
    { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'cat lock/owner.txt' } },
    { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'session_1 full-deploy range=a..b' }] },
    ...(last !== undefined ? [{ type: 'assistant_delta', text: last } as AgentStreamEvent] : []),
    { type: 'result', stopReason: 'end_turn', ...(finalText !== undefined ? { finalText } : {}) },
  ];
}

function harness(opts: { isUserInputTurn?: boolean; logVerbosity?: number; stream?: boolean }) {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const appendText = vi.fn().mockResolvedValue(true);
  const log: WorkLogInput[] = [];
  const context: StreamContext = {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity: opts.logVerbosity ?? LOG_MINIMAL,
    say: say as unknown as StreamContext['say'],
    workLog: (entry) => {
      log.push(entry);
    },
    ...('isUserInputTurn' in opts ? { isUserInputTurn: opts.isUserInputTurn } : {}),
    ...(opts.stream === false
      ? {}
      : { turnId: 'C1:T1:turn-1', threadPanel: { isTurnSurfaceActive: () => true, appendText } }),
  };
  return { context, say, appendText, log };
}

type Harness = ReturnType<typeof harness>;

async function run(h: Harness, list: AgentStreamEvent[]) {
  return new AgentStreamProcessor({}).process(events(list), h.context, new AbortController().signal);
}

const posted = (h: Harness): number => h.say.mock.calls.length + h.appendText.mock.calls.length;

const PLACEHOLDERS = [
  '(no message)',
  '(no content)',
  '(no response)',
  'No response requested.',
  '(silent)',
  '_(no message)_',
  '  (No message)  \n',
  '(메시지 없음)',
  '(응답 없음)',
];

describe('a host-started turn that ends on a placeholder ends silently', () => {
  it.each(PLACEHOLDERS)('streamed segment == finalText %j: nothing posted, no final, text kept', async (text) => {
    const h = harness({ isUserInputTurn: false });

    const result = await run(h, pollTurn(text, text));

    expect(posted(h)).toBe(0);
    expect(h.log.filter((e) => e.kind === 'final' || e.kind === 'narration')).toEqual([]);
    expect(result.collectedText.trim()).toBe(text.trim());
  });

  it('the live 2026-11-20 shape on the legacy say path: no `(no message)` post', async () => {
    const h = harness({ isUserInputTurn: false, stream: false });

    await run(h, pollTurn('(no message)', '(no message)'));

    expect(h.say).not.toHaveBeenCalled();
  });

  it('at a verbosity that shows narration, the placeholder segment is still not posted', async () => {
    const h = harness({ isUserInputTurn: false, logVerbosity: getVerbosityFlags('verbose') });

    await run(h, pollTurn('(no message)', '(no message)'));

    expect(h.appendText.mock.calls.map((c) => c[1])).not.toContain('(no message)');
    expect(h.say.mock.calls.map((c) => (c[0] as { text?: string }).text)).not.toContain('(no message)');
  });

  it('a placeholder that only arrives as finalText (never streamed) is not posted', async () => {
    const h = harness({ isUserInputTurn: false });

    const result = await run(h, pollTurn(undefined, '(no message)'));

    expect(posted(h)).toBe(0);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([]);
    expect(result.collectedText).toBe('(no message)');
  });

  it('withheld narration is not promoted when the turn chose silence', async () => {
    const h = harness({ isUserInputTurn: false, logVerbosity: LOG_MINIMAL });

    await run(h, pollTurn('(no message)', '(no message)', 'Checking whether the lane lock is still ours.'));

    expect(posted(h)).toBe(0);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([]);
  });

  it.each([
    undefined,
    '',
  ])('a streamed placeholder and a result with finalText %j: withheld narration is not promoted', async (finalText) => {
    const h = harness({ isUserInputTurn: false, logVerbosity: LOG_MINIMAL });

    const result = await run(h, pollTurn('(no message)', finalText, 'Checking the lane lock.'));

    expect(posted(h)).toBe(0);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([]);
    expect(result.collectedText).toBe('Checking the lane lock.\n(no message)');
  });

  it('a real answer after an earlier placeholder is the answer (no finalText, minimal)', async () => {
    const h = harness({ isUserInputTurn: false, logVerbosity: LOG_MINIMAL });
    const answer = 'Lane done: 4/4 in QA (dev2).';

    await run(h, [
      { type: 'assistant_delta', text: '(no message)' },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'cat lock/owner.txt' } },
      { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'no lock' }] },
      { type: 'assistant_delta', text: answer },
      { type: 'result', stopReason: 'end_turn' },
    ]);

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', answer);
    expect(h.log.filter((e) => e.kind === 'final')).toMatchObject([{ text: answer }]);
  });

  it('a real finalText after a streamed placeholder is the answer (result-only)', async () => {
    const h = harness({ isUserInputTurn: false, logVerbosity: LOG_MINIMAL });
    const answer = 'Lane done: 4/4 in QA (dev2).';

    await run(h, pollTurn('(no message)', answer));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', answer);
    expect(h.log.filter((e) => e.kind === 'final')).toMatchObject([{ text: answer }]);
  });

  it('a host turn with a real answer still posts it', async () => {
    const h = harness({ isUserInputTurn: false });
    const answer = 'The QA lane finished: 4/4 moved to QA (dev2).';

    await run(h, pollTurn(answer, answer));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', answer);
  });

  it('text that merely mentions a placeholder is an answer, not silence', async () => {
    const h = harness({ isUserInputTurn: false });
    const answer = 'The last cron turn posted (no message) — that was the host, not the run.';

    await run(h, pollTurn(answer, answer));

    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', answer);
  });

  it('short prose around a placeholder (within the length cap) is an answer, not silence', async () => {
    const h = harness({ isUserInputTurn: false });
    const answer = 'Last reply: (no message)';

    await run(h, pollTurn(answer, answer));

    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', answer);
  });
});

describe("a user's turn always gets its reply", () => {
  it.each([true, undefined])('isUserInputTurn=%s: a placeholder is posted as written', async (isUserInputTurn) => {
    const h = harness({ isUserInputTurn });

    await run(h, pollTurn('(no message)', '(no message)'));

    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', '(no message)');
  });
});
