/**
 * Spec 10 §3.2-3 + §3.3 — at `minimal` the Slack thread gets the turn's final
 * answer and nothing of the model's running narration; the narration, the tool
 * calls and the final answer all go to the work log (`StreamContext.workLog`),
 * at every verbosity.
 *
 * "Posted to Slack" is tracked apart from `currentMessages` (the recorder's
 * copy): a withheld segment that equals the SDK `finalText` is still in
 * `currentMessages`, yet must be posted once at the result event.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentStreamEvent } from '../agent-stream-types';
import { getVerbosityFlags, LOG_MINIMAL } from '../output-flags';
import { AgentStreamProcessor, type StreamCallbacks, type StreamContext } from '../stream-processor';
import type { WorkLogInput } from '../work-log';

const NARRATION = 'Let me read the config first.';
const FINAL = 'The timeout is 30s; I raised it to 60s.';

function* events(list: AgentStreamEvent[]): Generator<AgentStreamEvent> {
  for (const event of list) yield event;
}

/** narration → tool use → tool result → final text segment → result(finalText). */
function toolTurn(finalSegment = FINAL, finalText: string | undefined = FINAL): AgentStreamEvent[] {
  return [
    { type: 'assistant_delta', text: NARRATION },
    { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/repo/config.ts' } },
    { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'export const timeout = 30;' }] },
    { type: 'assistant_delta', text: finalSegment },
    { type: 'result', stopReason: 'end_turn', ...(finalText === undefined ? {} : { finalText }) },
  ];
}

interface Harness {
  context: StreamContext;
  say: ReturnType<typeof vi.fn>;
  appendText: ReturnType<typeof vi.fn>;
  log: WorkLogInput[];
}

/** PHASE>=1 production shape: an open B1 turn stream plus the legacy `say`. */
function harness(logVerbosity: number, opts: { stream?: boolean } = {}): Harness {
  const say = vi.fn().mockResolvedValue({ ts: 'm' });
  const appendText = vi.fn().mockResolvedValue(true);
  const log: WorkLogInput[] = [];
  const context: StreamContext = {
    channel: 'C1',
    threadTs: 'T1',
    sessionKey: 'C1:T1',
    sessionId: 's1',
    incidentAttempt: false,
    logVerbosity,
    say: say as unknown as StreamContext['say'],
    workLog: (entry) => {
      log.push(entry);
    },
    ...(opts.stream === false
      ? {}
      : { turnId: 'C1:T1:turn-1', threadPanel: { isTurnSurfaceActive: () => true, appendText } }),
  };
  return { context, say, appendText, log };
}

async function run(h: Harness, list: AgentStreamEvent[], callbacks: StreamCallbacks = {}) {
  return new AgentStreamProcessor(callbacks).process(events(list), h.context, new AbortController().signal);
}

describe('minimal verbosity — narration goes to the work log, Slack gets the final answer', () => {
  it('narration → tool → final segment == finalText → result: exactly ONE append, the final text', async () => {
    const h = harness(getVerbosityFlags('minimal'));

    const result = await run(h, toolTurn());

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
    expect(h.say).not.toHaveBeenCalled();
    // The recorder still gets the whole turn.
    expect(result.collectedText).toBe(`${NARRATION}\n${FINAL}`);

    expect(h.log.map((e) => e.kind)).toEqual(['narration', 'tool', 'tool_result', 'narration', 'final']);
    expect(h.log[0]).toMatchObject({ kind: 'narration', text: NARRATION });
    expect(h.log[1]).toMatchObject({ kind: 'tool', tool: 'Read' });
    expect(h.log[1]?.text).toContain('/repo/config.ts');
    expect(h.log[2]).toMatchObject({ kind: 'tool_result', tool: 'Read', ok: true });
    expect(h.log[4]).toMatchObject({ kind: 'final', text: FINAL });
    for (const entry of h.log) {
      expect(entry.turnId).toBe('C1:T1:turn-1');
      expect(typeof entry.ts).toBe('number');
    }
  });

  it('legacy say path (PHASE=0): exactly one post, the final text', async () => {
    const h = harness(LOG_MINIMAL, { stream: false });

    await run(h, toolTurn());

    expect(h.say).toHaveBeenCalledTimes(1);
    expect(h.say.mock.calls[0]?.[0]).toMatchObject({ text: FINAL, thread_ts: 'T1' });
  });

  it('a final text the stream never carried is posted once (existing new-text path)', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, toolTurn('Draft wording.', FINAL));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
  });

  it('the withheld final goes through the final-answer path (footer appended)', async () => {
    const h = harness(LOG_MINIMAL);
    const buildFinalResponseFooter = vi.fn().mockResolvedValue('_footer_');

    await run(h, toolTurn(), { buildFinalResponseFooter });

    expect(buildFinalResponseFooter).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', `${FINAL}\n\n_footer_`);
  });

  it('a directive in the final segment is dispatched exactly once, and the cleaned text is posted', async () => {
    const h = harness(LOG_MINIMAL);
    const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);
    const withDirective = `Deployed.\n\`\`\`json\n{"type":"channel_message","text":"Release notes"}\n\`\`\``;

    await run(h, toolTurn(withDirective, withDirective), { onChannelMessageDetected });

    expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', 'Deployed.');
  });

  it('a choice prompt mid-turn still posts (text + choice), and is not reposted at the result', async () => {
    const h = harness(LOG_MINIMAL);
    const choice = JSON.stringify({
      type: 'user_choice',
      question: 'Which option?',
      choices: [
        { id: '1', label: 'A' },
        { id: '2', label: 'B' },
      ],
    });
    const segment = `Pick one\n\`\`\`json\n${choice}\n\`\`\``;

    const result = await run(h, [
      { type: 'assistant_delta', text: segment },
      { type: 'result', stopReason: 'end_turn', finalText: segment },
    ]);

    expect(result.hasUserChoice).toBe(true);
    expect(h.say).toHaveBeenCalledTimes(2);
    expect(h.say.mock.calls[0]?.[0]).toMatchObject({ text: 'Pick one' });
    expect(h.say.mock.calls[1]?.[0]).toMatchObject({ text: '', attachments: expect.any(Array) });
    expect(h.appendText).not.toHaveBeenCalled();
  });

  it('a leaked transport error equal to finalText stays off Slack', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, [
      { type: 'assistant_delta', text: 'Prompt is too long' },
      { type: 'result', stopReason: 'end_turn', finalText: 'Prompt is too long' },
    ]);

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
    // Still in the work log — "before any suppression".
    expect(h.log.map((e) => e.kind)).toEqual(['narration', 'final']);
  });

  it('a result with no finalText posts the last withheld segment instead of nothing', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, toolTurn(FINAL, undefined));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
  });

  it('a stream that ends without a result posts the last withheld segment', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, toolTurn().slice(0, 4));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
  });

  it('a result error posts no withheld narration (the executor surfaces the error)', async () => {
    const h = harness(LOG_MINIMAL);

    const result = await run(h, [
      { type: 'assistant_delta', text: NARRATION },
      { type: 'result', stopReason: 'end_turn', error: { subtype: 'error_max_turns', errors: [] } },
    ]);

    expect(result.sdkResultError?.subtype).toBe('error_max_turns');
    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
  });

  it('an explicit interrupt keeps the partial text in the work log and off Slack (no lost-rescue failure)', async () => {
    const h = harness(LOG_MINIMAL);
    const controller = new AbortController();
    async function* interrupted(): AsyncGenerator<AgentStreamEvent> {
      yield { type: 'assistant_delta', text: 'half an answer' };
      controller.abort('user-interrupted');
      await new Promise<never>(() => {});
    }

    const result = await new AgentStreamProcessor().process(interrupted(), h.context, controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.interruptFlushFailed).toBeUndefined();
    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
    expect(h.log).toEqual([expect.objectContaining({ kind: 'narration', text: 'half an answer' })]);
  });

  it('a throwing work log never breaks the stream', async () => {
    const h = harness(LOG_MINIMAL);
    h.context.workLog = () => {
      throw new Error('disk full');
    };

    const result = await run(h, toolTurn());

    expect(result.success).toBe(true);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
  });

  it('a tool input summary is capped at 200 chars', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, [{ type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'x'.repeat(5000) } }]);

    const tool = h.log.find((e) => e.kind === 'tool');
    expect(tool?.tool).toBe('Bash');
    expect(tool?.text.length).toBeLessThanOrEqual(200);
  });

  it('a failed tool result is logged with ok=false', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, [
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'false' } },
      { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'exit 1' }], isError: true },
    ]);

    expect(h.log.find((e) => e.kind === 'tool_result')).toMatchObject({ tool: 'Bash', ok: false });
  });
});

describe('compact and above — narration still streams to Slack (unchanged)', () => {
  for (const level of ['compact', 'detail', 'verbose'] as const) {
    it(`${level}: narration and final both stream; the identical finalText is not reposted`, async () => {
      const h = harness(getVerbosityFlags(level));

      await run(h, toolTurn());

      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([NARRATION, FINAL]);
      expect(h.log.map((e) => e.kind)).toEqual(['narration', 'tool', 'tool_result', 'narration', 'final']);
    });
  }

  it('no mask (legacy session) behaves as detail: narration streams', async () => {
    const h = harness(LOG_MINIMAL);
    delete h.context.logVerbosity;

    await run(h, toolTurn());

    expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([NARRATION, FINAL]);
  });
});
