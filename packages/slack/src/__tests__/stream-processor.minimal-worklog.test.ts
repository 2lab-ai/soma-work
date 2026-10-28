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

async function* events(list: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const event of list) yield event;
}

const NO_FINAL_TEXT = Symbol('no finalText property');

/**
 * narration → tool use → tool result → final text segment → result(finalText).
 * Pass {@link NO_FINAL_TEXT} for a result event with NO `finalText` property at
 * all (a plain `undefined` argument would fall back to the default).
 */
function toolTurn(finalSegment = FINAL, finalText: string | typeof NO_FINAL_TEXT = FINAL): AgentStreamEvent[] {
  return [
    { type: 'assistant_delta', text: NARRATION },
    { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: { file_path: '/repo/config.ts' } },
    { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'export const timeout = 30;' }] },
    { type: 'assistant_delta', text: finalSegment },
    { type: 'result', stopReason: 'end_turn', ...(finalText === NO_FINAL_TEXT ? {} : { finalText }) },
  ];
}

const DIRECTIVE_SEGMENT = 'Deployed.\n```json\n{"type":"channel_message","text":"Release notes"}\n```';

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

    // The final answer is recorded once — as `final`, not also as narration.
    expect(h.log.map((e) => e.kind)).toEqual(['narration', 'tool', 'tool_result', 'final']);
    expect(h.log[0]).toMatchObject({ kind: 'narration', text: NARRATION });
    expect(h.log[1]).toMatchObject({ kind: 'tool', tool: 'Read' });
    expect(h.log[1]?.text).toContain('/repo/config.ts');
    expect(h.log[2]).toMatchObject({ kind: 'tool_result', tool: 'Read', ok: true });
    expect(h.log[3]).toMatchObject({ kind: 'final', text: FINAL });
    // SSOT 2026-10-23 T1 — a call and its result carry the same tool-use id, so the
    // dashboard's artifact capture pairs an upload with its reply exactly.
    expect(h.log[1]?.toolUseId).toBe('tu_1');
    expect(h.log[2]?.toolUseId).toBe('tu_1');
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

    await run(h, toolTurn(DIRECTIVE_SEGMENT, DIRECTIVE_SEGMENT), { onChannelMessageDetected });

    expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', 'Deployed.');
  });

  it('a finalText equal to the CLEANED segment (directive stripped) is still posted once', async () => {
    const h = harness(LOG_MINIMAL);
    const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);

    await run(h, toolTurn(DIRECTIVE_SEGMENT, 'Deployed.'), { onChannelMessageDetected });

    expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', 'Deployed.');
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: 'Deployed.' })]);
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
    // In the work log once — as an `error`, never as the answer.
    expect(h.log).toEqual([expect.objectContaining({ kind: 'error', text: 'Prompt is too long' })]);
  });

  it('a leaked transport error as the final never brings withheld narration onto Slack', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, [
      { type: 'assistant_delta', text: NARRATION },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
      { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
      { type: 'assistant_delta', text: 'Prompt is too long' },
      { type: 'result', stopReason: 'end_turn', finalText: 'Prompt is too long' },
    ]);

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
  });

  it('a directive-ONLY final segment: the withheld narration is posted instead of nothing', async () => {
    const h = harness(LOG_MINIMAL);
    const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);
    const directiveOnly = '```json\n{"type":"channel_message","text":"Release notes"}\n```';

    await run(h, toolTurn(directiveOnly, directiveOnly), { onChannelMessageDetected });

    expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', NARRATION);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: NARRATION })]);
  });

  // Work-log contract (spec 10 §3.3, docs/misc/guides/verbosity-matrix.md):
  // the final answer is recorded once as `final`. A segment already recorded
  // as `narration` because the turn moved on, then posted by the fallback,
  // appears once as narration and once as final — never two of either.
  it.each([
    ['with a tool in between', true],
    ['with no tool in between', false],
  ])('narration → directive-only final %s: one narration + one final for the posted text', async (_label, withTool) => {
    const h = harness(LOG_MINIMAL);
    const directiveOnly = '```json\n{"type":"channel_message","text":"Release notes"}\n```';
    const turn: AgentStreamEvent[] = withTool
      ? toolTurn(directiveOnly, directiveOnly)
      : [
          { type: 'assistant_delta', text: NARRATION },
          { type: 'usage', usage: { lastTurnInputTokens: 10 } },
          { type: 'assistant_delta', text: directiveOnly },
          { type: 'result', stopReason: 'end_turn', finalText: directiveOnly },
        ];

    await run(h, turn);

    expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([NARRATION]);
    const forText = h.log.filter((e) => e.text === NARRATION).map((e) => e.kind);
    expect(forText).toEqual(['narration', 'final']);
    expect(h.log.filter((e) => e.kind === 'final')).toHaveLength(1);
  });

  it('a whitespace-only final segment: the withheld narration is posted instead of nothing', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, toolTurn('   \n', '   \n'));

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', NARRATION);
  });

  it('a choice form the HOST posted this turn suppresses the fallback (no narration under the form)', async () => {
    const h = harness(LOG_MINIMAL);
    h.context.hostChoicePosted = () => true;

    await run(h, toolTurn(FINAL, ''));

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
    expect(h.log.some((e) => e.kind === 'final')).toBe(false);
  });

  // Question-form policy: once the HOST posted a question form this turn, no
  // withheld narration is promoted onto Slack under it — whatever finalText is.
  it.each([
    ['a finalText equal to the withheld segment', FINAL],
    ['an empty finalText', ''],
    ['no finalText property', NO_FINAL_TEXT],
  ] as const)('after a host question form, %s posts nothing', async (_label, finalText) => {
    const h = harness(LOG_MINIMAL);
    let asked = false;
    h.context.hostChoicePosted = () => asked;
    const turn = toolTurn(FINAL, finalText);

    // The form is posted from the tool result (ASK_USER_QUESTION), before the
    // final segment streams.
    await run(h, turn, {
      onToolResult: async () => {
        asked = true;
      },
    });

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
  });

  it('a final text the stream never carried still posts after a host question (it is new text)', async () => {
    const h = harness(LOG_MINIMAL);
    h.context.hostChoicePosted = () => true;

    await run(h, toolTurn('Draft wording.', FINAL));

    expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([FINAL]);
  });

  // Terminal suppression: a turn whose last text was a leak the guards kept
  // off Slack ends on that error — no earlier narration is promoted.
  for (const [leak, label] of [
    ['Prompt is too long', 'prompt-too-long'],
    ['Error: Error during compaction: boom', 'compaction failure'],
    ['API Error: 400 messages: text content blocks must be non-empty', 'empty-text-block 400'],
  ] as const) {
    it.each([
      ['an empty finalText', ''],
      ['no finalText property', NO_FINAL_TEXT],
    ] as const)(`withheld narration → ${label} leak → %s: nothing posted`, async (_l, finalText) => {
      const h = harness(LOG_MINIMAL);

      await run(h, toolTurn(leak, finalText));

      expect(h.appendText).not.toHaveBeenCalled();
      expect(h.say).not.toHaveBeenCalled();
    });

    it(`withheld narration → ${label} leak → no result at all: nothing posted`, async () => {
      const h = harness(LOG_MINIMAL);

      await run(h, toolTurn(leak).slice(0, 4));

      expect(h.appendText).not.toHaveBeenCalled();
      expect(h.say).not.toHaveBeenCalled();
    });
  }

  it('a result event with NO finalText property posts the last withheld segment, logged as one final', async () => {
    const h = harness(LOG_MINIMAL);
    const turn = toolTurn(FINAL, NO_FINAL_TEXT);
    const result = turn[turn.length - 1];
    expect(result?.type).toBe('result');
    expect(result).not.toHaveProperty('finalText');

    await run(h, turn);

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
  });

  it('a result event whose finalText is explicitly undefined posts the last withheld segment', async () => {
    const h = harness(LOG_MINIMAL);
    const turn = toolTurn(FINAL, NO_FINAL_TEXT);
    const result = { ...turn[turn.length - 1], finalText: undefined } as AgentStreamEvent;
    expect(result).toHaveProperty('finalText', undefined);

    await run(h, [...turn.slice(0, -1), result]);

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
  });

  it('a result event with an EMPTY finalText posts the last withheld segment, logged as one final', async () => {
    const h = harness(LOG_MINIMAL);
    const turn = toolTurn(FINAL, '');
    expect(turn[turn.length - 1]).toMatchObject({ type: 'result', finalText: '' });

    await run(h, turn);

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
  });

  it('a stream that ends without a result posts the last withheld segment, logged as one final', async () => {
    const h = harness(LOG_MINIMAL);
    const turn = toolTurn().slice(0, 4);
    expect(turn.some((e) => e.type === 'result')).toBe(false);

    await run(h, turn);

    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.appendText).toHaveBeenCalledWith('C1:T1:turn-1', FINAL);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
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

describe('work-log raw — the full tool input and result behind each one-line entry', () => {
  const resultOf = (h: Harness) => h.log.find((e) => e.kind === 'tool_result');

  /** One Bash call whose result arrives as SDK content `rawOutput`. */
  async function runResult(rawOutput: unknown): Promise<Harness> {
    const h = harness(LOG_MINIMAL);
    await run(h, [
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', toolCallId: 'tu_1', content: [], rawOutput },
    ]);
    return h;
  }

  it('a tool entry carries its whole input as pretty JSON; the one-line text is unchanged', async () => {
    const h = harness(LOG_MINIMAL);
    const input = { command: 'x'.repeat(5000), description: 'long one', _internal: 'kept' };

    await run(h, [{ type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input }]);

    const tool = h.log.find((e) => e.kind === 'tool');
    expect(tool?.raw).toBe(JSON.stringify(input, null, 2));
    expect(tool?.text.length).toBeLessThanOrEqual(200);
    expect(tool?.text.startsWith('Bash {"command":"xxx')).toBe(true);
  });

  it('the default tool turn: tool raw is the input JSON, tool_result raw is the result text', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, toolTurn());

    expect(h.log[1]).toMatchObject({
      kind: 'tool',
      raw: JSON.stringify({ file_path: '/repo/config.ts' }, null, 2),
    });
    expect(h.log[2]).toMatchObject({ kind: 'tool_result', text: 'Read ok', raw: 'export const timeout = 30;' });
    // Narration and final carry no raw: their text is the content.
    expect(h.log[0]).not.toHaveProperty('raw');
    expect(h.log[3]).not.toHaveProperty('raw');
  });

  it('an input JSON cannot encode falls back to String(input)', async () => {
    const h = harness(LOG_MINIMAL);
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;

    await run(h, [{ type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input }]);

    expect(h.log.find((e) => e.kind === 'tool')?.raw).toBe('[object Object]');
  });

  it('a tool call without input carries no raw', async () => {
    const h = harness(LOG_MINIMAL);

    await run(h, [{ type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: undefined }]);

    expect(h.log.find((e) => e.kind === 'tool')).not.toHaveProperty('raw');
  });

  it('string result content is the raw as-is', async () => {
    const h = await runResult('line 1\n\tline 2\u0001');
    expect(resultOf(h)).toMatchObject({ kind: 'tool_result', text: 'Bash ok', raw: 'line 1\n\tline 2\u0001' });
  });

  it('block-array content: text blocks joined by newlines, images as [image], other blocks as JSON', async () => {
    const other = { type: 'document', source: { kind: 'file', id: 'f1' } };
    const h = await runResult([
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      other,
      { type: 'text', text: 'last' },
    ]);
    expect(resultOf(h)?.raw).toBe(`first\n[image]\n${JSON.stringify(other)}\nlast`);
    // Within the cap the store measures the size itself.
    expect(resultOf(h)).not.toHaveProperty('rawBytes');
  });

  it('a block array past the 256 KiB cap stops accumulating; rawBytes reports the whole output', async () => {
    const KIB = 1024;
    const a = 'a'.repeat(200 * KIB);
    const b = '한'.repeat(30 * KIB); // 90 KiB in UTF-8: the join passes the cap here
    const c = 'c'.repeat(50 * KIB);
    const other = { type: 'document', n: 1 };
    const h = await runResult([
      { type: 'text', text: a },
      { type: 'text', text: b },
      { type: 'text', text: c },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      other,
    ]);

    const result = resultOf(h);
    expect(result?.raw).toBe(`${a}\n${b}`);
    const whole = `${a}\n${b}\n${c}\n[image]\n${JSON.stringify(other)}`;
    expect(result?.rawBytes).toBe(Buffer.byteLength(whole));
  });

  it('an object result is pretty JSON', async () => {
    const h = await runResult({ stdout: 'ok', code: 0 });
    expect(resultOf(h)?.raw).toBe(JSON.stringify({ stdout: 'ok', code: 0 }, null, 2));
  });

  it('a result with no content (undefined / null) carries no raw', async () => {
    for (const rawOutput of [undefined, null]) {
      const h = harness(LOG_MINIMAL);
      await run(h, [
        { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'true' } },
        { type: 'tool_result', toolCallId: 'tu_1', content: undefined as never, rawOutput },
      ]);
      expect(resultOf(h)).toMatchObject({ kind: 'tool_result', ok: true });
      expect(resultOf(h)).not.toHaveProperty('raw');
    }
  });

  it('without rawOutput the neutral content blocks are the result (text joined, json blocks as JSON)', async () => {
    const h = harness(LOG_MINIMAL);
    await run(h, [
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      {
        type: 'tool_result',
        toolCallId: 'tu_1',
        content: [
          { type: 'text', text: 'a.ts' },
          { type: 'json', value: { n: 1 } },
        ],
      },
    ]);
    expect(resultOf(h)?.raw).toBe(`a.ts\n${JSON.stringify({ type: 'json', value: { n: 1 } })}`);
  });
});

describe('result-time dedup is against what was delivered, at every level', () => {
  for (const level of ['minimal', 'compact', 'detail', 'verbose'] as const) {
    it(`${level}: a directive segment whose raw text is the finalText dispatches once and posts once`, async () => {
      const h = harness(getVerbosityFlags(level));
      const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);

      const result = await run(
        h,
        [
          { type: 'assistant_delta', text: DIRECTIVE_SEGMENT },
          { type: 'result', stopReason: 'end_turn', finalText: DIRECTIVE_SEGMENT },
        ],
        { onChannelMessageDetected },
      );

      expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual(['Deployed.']);
      expect(h.say).not.toHaveBeenCalled();
      expect(result.collectedText).toBe('Deployed.');
    });

    it(`${level}: a directive-ONLY segment whose raw text is the finalText dispatches once and posts nothing`, async () => {
      const h = harness(getVerbosityFlags(level));
      const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);
      const directiveOnly = '```json\n{"type":"channel_message","text":"Root post only"}\n```';

      await run(
        h,
        [
          { type: 'assistant_delta', text: directiveOnly },
          { type: 'result', stopReason: 'end_turn', finalText: directiveOnly },
        ],
        { onChannelMessageDetected },
      );

      expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
      expect(h.appendText).not.toHaveBeenCalled();
      expect(h.say).not.toHaveBeenCalled();
    });
  }

  it('detail (legacy say path): the directive segment posts once', async () => {
    const h = harness(getVerbosityFlags('detail'), { stream: false });
    const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);

    await run(
      h,
      [
        { type: 'assistant_delta', text: DIRECTIVE_SEGMENT },
        { type: 'result', stopReason: 'end_turn', finalText: DIRECTIVE_SEGMENT },
      ],
      { onChannelMessageDetected },
    );

    expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
    expect(h.say).toHaveBeenCalledTimes(1);
    expect(h.say.mock.calls[0]?.[0]).toMatchObject({ text: 'Deployed.' });
  });
});

describe('compact and above — narration still streams to Slack (unchanged)', () => {
  for (const level of ['compact', 'detail', 'verbose'] as const) {
    it(`${level}: narration and final both stream; the identical finalText is not reposted`, async () => {
      const h = harness(getVerbosityFlags(level));

      await run(h, toolTurn());

      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([NARRATION, FINAL]);
      expect(h.log.map((e) => e.kind)).toEqual(['narration', 'tool', 'tool_result', 'final']);
    });
  }

  it('no mask (legacy session) behaves as detail: narration streams', async () => {
    const h = harness(LOG_MINIMAL);
    delete h.context.logVerbosity;

    await run(h, toolTurn());

    expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([NARRATION, FINAL]);
  });
});

/**
 * The executor's recovery for a transport error surfaced as content reads the
 * turn's text. When narration preceded the leak, collectedText is
 * "narration\nleak" and the executor's guards (≤160 chars / starts-with)
 * missed it — the turn ended silent with no recovery. The processor now hands
 * the leak itself back as `transportLeak`.
 */
describe('transportLeak — the suppressed segment the turn ended on', () => {
  const LONG_NARRATION =
    'I will start by reading the deployment configuration, then the three service manifests it references, and finally compare their timeout values against the load-balancer settings.';

  for (const level of ['minimal', 'compact', 'detail'] as const) {
    it(`${level}: narration > 160 chars → tool → leak → result(finalText = leak) returns the leak`, async () => {
      const h = harness(getVerbosityFlags(level));
      expect(LONG_NARRATION.length).toBeGreaterThan(160);

      const result = await run(h, [
        { type: 'assistant_delta', text: LONG_NARRATION },
        { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
        { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'assistant_delta', text: 'Prompt is too long' },
        { type: 'result', stopReason: 'end_turn', finalText: 'Prompt is too long' },
      ]);

      expect(result.transportLeak).toBe('Prompt is too long');
    });
  }

  it('no result after the leak: still returned', async () => {
    const h = harness(LOG_MINIMAL);

    const result = await run(h, toolTurn('Prompt is too long').slice(0, 4));

    expect(result.transportLeak).toBe('Prompt is too long');
  });

  it('a turn that went on to real text after a leak, and an ordinary turn, return none', async () => {
    const leakThenText = await run(harness(LOG_MINIMAL), [
      { type: 'assistant_delta', text: 'Prompt is too long' },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
      { type: 'assistant_delta', text: FINAL },
      { type: 'result', stopReason: 'end_turn', finalText: FINAL },
    ]);
    expect(leakThenText.transportLeak).toBeUndefined();

    const ordinary = await run(harness(LOG_MINIMAL), toolTurn());
    expect(ordinary.transportLeak).toBeUndefined();
  });
});

/**
 * A transport-error leak is never posted and never recorded as the answer:
 * whatever the turn's ending, the work log holds it once, as `error` (spec 10
 * §3.3, docs/misc/guides/verbosity-matrix.md). Covers the three leak classes
 * the processor suppresses.
 */
describe('leak handling at every ending', () => {
  const SHORT_NARRATION = 'Let me check.';
  const LEAKS = [
    ['prompt-too-long', 'Prompt is too long', false],
    [
      'compaction failure (compact turn)',
      'Error: Error during compaction: Error: Conversation too long. Press esc twice to go up a few messages and try again.',
      true,
    ],
    [
      'empty-text-block 400',
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: text content blocks must be non-empty"}}',
      false,
    ],
  ] as const;
  const TAILS = ['finalText = leak', 'finalText = ""', 'no finalText', 'no result'] as const;

  function leakTurn(leak: string, tail: (typeof TAILS)[number]): AgentStreamEvent[] {
    const base: AgentStreamEvent[] = [
      { type: 'assistant_delta', text: SHORT_NARRATION },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
      { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
      { type: 'assistant_delta', text: leak },
    ];
    if (tail === 'no result') return base;
    if (tail === 'no finalText') return [...base, { type: 'result', stopReason: 'end_turn' }];
    return [...base, { type: 'result', stopReason: 'end_turn', finalText: tail === 'finalText = leak' ? leak : '' }];
  }

  for (const [label, leak, isCompactTurn] of LEAKS) {
    for (const tail of TAILS) {
      it(`${label}, ${tail}: nothing posted, returned as transportLeak, logged once as error`, async () => {
        const h = harness(LOG_MINIMAL);
        h.context.isCompactTurn = isCompactTurn;

        const result = await run(h, leakTurn(leak, tail));

        expect(h.appendText).not.toHaveBeenCalled();
        expect(h.say).not.toHaveBeenCalled();
        expect(result.transportLeak).toBe(leak);
        expect(h.log.filter((e) => e.text === leak)).toEqual([expect.objectContaining({ kind: 'error' })]);
        expect(h.log.some((e) => e.kind === 'final')).toBe(false);
      });
    }
  }

  // A leak that arrives ONLY as finalText (never streamed) used to be posted
  // through the final-answer path, at every level.
  for (const level of ['minimal', 'compact', 'detail', 'verbose'] as const) {
    it(`${level}: a leak that arrives only as finalText is never posted and is returned as transportLeak`, async () => {
      const h = harness(getVerbosityFlags(level));

      const result = await run(h, [
        { type: 'assistant_delta', text: NARRATION },
        { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
        { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'result', stopReason: 'end_turn', finalText: 'Prompt is too long' },
      ]);

      const posted = [...h.appendText.mock.calls.map((c) => c[1]), ...h.say.mock.calls.map((c) => c[0]?.text)];
      expect(posted).not.toContain('Prompt is too long');
      expect(posted).toEqual(level === 'minimal' ? [] : [NARRATION]);
      expect(result.transportLeak).toBe('Prompt is too long');
      expect(h.log.filter((e) => e.text === 'Prompt is too long')).toEqual([
        expect.objectContaining({ kind: 'error' }),
      ]);
    });
  }

  // A leak, then a result carrying a NEW real answer (never streamed): the
  // turn recovered — the answer posts once and nothing is handed to recovery.
  for (const level of ['minimal', 'compact'] as const) {
    it(`${level}: leak → result with a new real finalText: answer posted once, no transportLeak`, async () => {
      const h = harness(getVerbosityFlags(level));

      const result = await run(h, [
        { type: 'assistant_delta', text: 'Prompt is too long' },
        { type: 'result', stopReason: 'end_turn', finalText: FINAL },
      ]);

      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([FINAL]);
      expect(result.transportLeak).toBeUndefined();
      expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
    });
  }
});

describe('guardText — what the executor content guards read', () => {
  it('excludes suppressed segments: leak → real answer gives the answer alone', async () => {
    const result = await run(harness(LOG_MINIMAL), [
      { type: 'assistant_delta', text: 'Prompt is too long' },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
      { type: 'assistant_delta', text: FINAL },
      { type: 'result', stopReason: 'end_turn', finalText: FINAL },
    ]);

    expect(result.collectedText).toBe(`Prompt is too long\n${FINAL}`);
    expect(result.guardText).toBe(FINAL);
  });

  it('is the leak itself when the turn ended on one', async () => {
    const result = await run(harness(LOG_MINIMAL), toolTurn('Prompt is too long', ''));

    expect(result.guardText).toBe('Prompt is too long');
  });

  // A directive-only ending shows nothing, so the turn still ENDED on the
  // leak: guardText (and transportLeak) is the leak, recovery must fire.
  const DIRECTIVE_ONLY = '```json\n{"type":"channel_message","text":"Release notes"}\n```';
  // Adjacent deltas join into one segment, so a leak or a directive split
  // across them must behave exactly like the whole-segment fixtures.
  const LEAK_PARTS = {
    whole: ['Prompt is too long'],
    fragmented: ['Prompt is ', 'too long'],
  } as const;
  const DIRECTIVE_PARTS = {
    whole: [DIRECTIVE_ONLY],
    fragmented: ['```json\n{"type":"channel_message",', '"text":"Release notes"}\n```'],
  } as const;
  // Endings: a STREAMED directive-only segment (fragmentable like the leak),
  // or a result whose finalText is one complete directive (a finalText is a
  // single string — there is nothing to fragment).
  const ENDINGS = [
    ...(['whole', 'fragmented'] as const).map((directive) => ({
      label: `streamed ${directive} directive-only segment`,
      streamed: DIRECTIVE_PARTS[directive] as readonly string[],
    })),
    { label: 'result-only complete-directive finalText', streamed: [] as readonly string[] },
  ];
  for (const leak of ['whole', 'fragmented'] as const) {
    for (const ending of ENDINGS) {
      for (const level of ['minimal', 'detail'] as const) {
        it(`${level}: ${leak} leak → ${ending.label}: guardText is the leak, directive dispatched once`, async () => {
          const h = harness(getVerbosityFlags(level));
          const onChannelMessageDetected = vi.fn().mockResolvedValue(undefined);
          const delta = (text: string): AgentStreamEvent => ({ type: 'assistant_delta', text });

          const result = await run(
            h,
            [
              delta(NARRATION),
              { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
              ...LEAK_PARTS[leak].map(delta),
              { type: 'tool_call', toolCallId: 'tu_2', name: 'Read', input: {} },
              ...ending.streamed.map(delta),
              { type: 'result', stopReason: 'end_turn', finalText: DIRECTIVE_ONLY },
            ],
            { onChannelMessageDetected },
          );

          expect(result.guardText).toBe('Prompt is too long');
          expect(result.transportLeak).toBe('Prompt is too long');
          expect(onChannelMessageDetected).toHaveBeenCalledTimes(1);
          expect(onChannelMessageDetected).toHaveBeenCalledWith('Release notes', h.context);
          const posted = [...h.appendText.mock.calls.map((c) => c[1]), ...h.say.mock.calls.map((c) => c[0]?.text)];
          expect(posted).not.toContain('Prompt is too long');
          expect(posted).toEqual(level === 'minimal' ? [] : [NARRATION]);
          // Work log: the leak once as `error`, no `final` (nothing was the answer).
          expect(h.log.filter((e) => e.kind === 'error')).toEqual([
            expect.objectContaining({ text: 'Prompt is too long' }),
          ]);
          expect(h.log.some((e) => e.kind === 'final')).toBe(false);
        });
      }
    }
  }

  it('equals collectedText for an ordinary turn', async () => {
    const result = await run(harness(LOG_MINIMAL), toolTurn());

    expect(result.guardText).toBe(result.collectedText);
  });
});

describe('a finalText that differs from the streamed leak only by whitespace', () => {
  it('is the same leak: logged once as error, nothing posted, returned as transportLeak', async () => {
    const h = harness(LOG_MINIMAL);

    const result = await run(h, [
      { type: 'assistant_delta', text: NARRATION },
      { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
      { type: 'assistant_delta', text: 'Prompt is too long' },
      { type: 'result', stopReason: 'end_turn', finalText: '  Prompt is too long\n' },
    ]);

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
    expect(h.log.filter((e) => e.kind === 'error')).toHaveLength(1);
    expect(result.transportLeak).toBe('Prompt is too long');
  });
});

/**
 * Spec 10 §3.2-3 (updated): if a final answer reached Slack this turn, the
 * turn did not end on a leak and no recovery runs. A known (streamed,
 * non-suppressed) segment accepted as the final becomes the terminal segment.
 */
describe('a known final answer after a suppressed leak is the terminal segment', () => {
  for (const level of ['minimal', 'detail'] as const) {
    it(`${level}: A withheld/streamed → leak L suppressed → result(finalText = A): A posted once, no recovery`, async () => {
      const h = harness(getVerbosityFlags(level));
      const LEAK = 'Prompt is too long';

      const result = await run(h, [
        { type: 'assistant_delta', text: FINAL },
        { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
        { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
        { type: 'assistant_delta', text: LEAK },
        { type: 'result', stopReason: 'end_turn', finalText: FINAL },
      ]);

      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([FINAL]);
      expect(result.transportLeak).toBeUndefined();
      expect(result.guardText).not.toBe(LEAK);
      expect(result.guardText).not.toContain(LEAK);
      expect(h.log.filter((e) => e.kind === 'error')).toEqual([expect.objectContaining({ text: LEAK })]);
      expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
    });
  }
});

/**
 * "If the turn's answer IS that segment, it is recorded only as final":
 * bookkeeping frames (status, compact_boundary, usage) between the answer and
 * `result` do not move the turn on — only a tool, thinking or more text does.
 */
describe('bookkeeping frames do not settle the held answer as narration', () => {
  for (const [label, frame] of [
    ['a status frame', { type: 'status', status: 'working' }],
    ['a compact_boundary frame', { type: 'compact_boundary', metadata: { trigger: 'auto' } }],
  ] as const) {
    it(`${label} between the answer and result: the answer is recorded once, as final`, async () => {
      const h = harness(LOG_MINIMAL);

      await run(h, [
        { type: 'assistant_delta', text: FINAL },
        frame as AgentStreamEvent,
        { type: 'result', stopReason: 'end_turn', finalText: FINAL },
      ]);

      expect(h.log.filter((e) => e.text === FINAL).map((e) => e.kind)).toEqual(['final']);
      expect(h.appendText.mock.calls.map((c) => c[1])).toEqual([FINAL]);
    });
  }
});

/**
 * Spec 10 §3.2-3: if the final answer or a question form reached Slack this
 * turn, the turn did not end on a leak. If posting the answer throws, the
 * turn fails on that error instead.
 */
describe('what makes the accepted final the terminal segment', () => {
  const LEAK = 'Prompt is too long';
  const withheldThenLeak = (): AgentStreamEvent[] => [
    { type: 'assistant_delta', text: FINAL },
    { type: 'tool_call', toolCallId: 'tu_1', name: 'Read', input: {} },
    { type: 'tool_result', toolCallId: 'tu_1', content: [{ type: 'text', text: 'ok' }] },
    { type: 'assistant_delta', text: LEAK },
    { type: 'result', stopReason: 'end_turn', finalText: FINAL },
  ];

  it('a host question form reached Slack: A is not posted under it, and no recovery (no transportLeak)', async () => {
    const h = harness(LOG_MINIMAL);
    let asked = false;
    h.context.hostChoicePosted = () => asked;

    const result = await run(h, withheldThenLeak(), {
      onToolResult: async () => {
        asked = true;
      },
    });

    expect(h.appendText).not.toHaveBeenCalled();
    expect(h.say).not.toHaveBeenCalled();
    expect(result.transportLeak).toBeUndefined();
    expect(result.guardText).not.toContain(LEAK);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
    expect(h.log.filter((e) => e.kind === 'error')).toEqual([expect.objectContaining({ text: LEAK })]);
  });

  // What production observes: the post error escapes process() — no
  // StreamResult, so the executor's catch runs handleError on that error and
  // no leak recovery runs this turn.
  it('the promotion runs but posting the answer throws: process() rejects with the post error', async () => {
    const h = harness(LOG_MINIMAL);
    h.appendText.mockRejectedValue(new Error('slack down'));

    await expect(
      new AgentStreamProcessor().process(events(withheldThenLeak()), h.context, new AbortController().signal),
    ).rejects.toThrow('slack down');
    // The promotion branch ran: A was recorded as the answer before the post.
    expect(h.appendText).toHaveBeenCalledTimes(1);
    expect(h.log.filter((e) => e.kind === 'final')).toEqual([expect.objectContaining({ text: FINAL })]);
  });
});
