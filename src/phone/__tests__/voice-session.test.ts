/**
 * The call run (.prd/31-phone-calls-architecture.md §3): opening held until the other side has picked up,
 * hearing → dialog, barge-in, hang_up after the goodbye, the transcript and the work log.
 *
 * Fakes: the line's codec is identity (the tests feed PCM16 as if it were μ-law), the voice service returns canned
 * text and 8 kHz audio, the dialog is a queue the test writes events into, and time is a manual clock.
 */
import { describe, expect, it } from 'vitest';
import type { VoiceDialog, VoiceDialogEvent, VoiceDialogTool } from '../../agent-runtime/voice-dialog';
import type { PhoneCallRecord } from '../call-store';
import type { CallSessionLike } from '../koreaaitel';
import { OPENING_CUE, SILENCE_CUE } from '../phone-prompt';
import type { VoiceClient } from '../voice-client';
import { CallRun, type CallRunPlan, PhoneVoiceSession } from '../voice-session';

const RATE = 8000;
function tone(ms: number, amp: number): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / RATE) * amp * 32767), i * 2);
  return b;
}
const quiet = (ms: number) => tone(ms, 0.0005);

class Clock {
  t = 1_000_000;
  timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

class FakeDialog implements VoiceDialog {
  sent: string[] = [];
  interrupted = 0;
  closed = false;
  private queue: VoiceDialogEvent[] = [];
  private wake?: () => void;
  constructor(readonly tools: VoiceDialogTool[]) {}
  send(text: string) {
    this.sent.push(text);
    return true;
  }
  async interrupt() {
    this.interrupted++;
  }
  close() {
    this.closed = true;
    this.emit({ type: 'closed' });
  }
  emit(ev: VoiceDialogEvent) {
    this.queue.push(ev);
    this.wake?.();
  }
  reply(text: string) {
    this.emit({ type: 'text_delta', text });
    this.emit({ type: 'turn_end', isError: false });
  }
  get events(): AsyncIterable<VoiceDialogEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const ev = self.queue.shift();
          if (ev) {
            yield ev;
            if (ev.type === 'closed') return;
            continue;
          }
          await new Promise<void>((r) => {
            self.wake = r;
          });
        }
      },
    };
  }
  tool(name: string) {
    const t = this.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }
}

function fakeCall() {
  const call = {
    callId: 'CA1',
    fromNumber: '07000000000',
    toNumber: '01000000000',
    direction: 'outbound',
    status: 'active',
    endedStatus: null,
    endedDuration: null,
    frames: 0,
    cleared: 0,
    hungUp: 0,
    emitted: [] as Array<[string, string]>,
    sendAudio() {
      call.frames++;
    },
    clearAudio() {
      call.cleared++;
    },
    async hangup() {
      call.hungUp++;
    },
    async wait() {},
    _emit(_e: string, role: string, text: string) {
      call.emitted.push([role, text]);
    },
  };
  return call;
}

function setup(
  plan: Partial<CallRunPlan> = {},
  stt: string[] = [],
  opts: {
    speakGate?: () => Promise<void>;
    warm?: (signal?: AbortSignal) => Promise<void>;
    sttGate?: () => Promise<void>;
  } = {},
) {
  const clock = new Clock();
  const record: PhoneCallRecord = {
    id: 'CA1',
    env: 'e',
    direction: plan.direction ?? 'outbound',
    ourNumber: '07000000000',
    peerNumber: '01000000000',
    title: 't',
    status: 'dialing',
    createdAt: clock.t,
    transcript: [],
    work: [],
  };
  let dialog: FakeDialog | undefined;
  const spoken: string[] = [];
  const warmed: number[] = [];
  const voice: VoiceClient = {
    warm(signal) {
      warmed.push(clock.t);
      return opts.warm?.(signal);
    },
    async transcribe() {
      await opts.sttGate?.();
      return { text: stt.shift() ?? '', ms: 5 };
    },
    async speak(text) {
      spoken.push(text);
      await opts.speakGate?.();
      const pcm = tone(400, 0.2); // 400 ms of speech per sentence = 20 frames of 160 B (identity codec)
      return {
        sampleRate: RATE,
        headersMs: 1,
        chunks: (async function* () {
          yield pcm;
        })(),
      };
    },
  };
  const run = new CallRun(
    { callId: 'CA1', direction: 'outbound', maxMinutes: 5, ...plan },
    {
      ulawToPcm16: (b) => b,
      pcm16ToUlaw: (b) => b,
      voice,
      openDialog: (tools) => {
        dialog = new FakeDialog(tools);
        return dialog;
      },
      update: (m) => m(record),
      log: () => undefined,
      now: clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
    },
  );
  return { run, clock, record, spoken, warmed, dialog: () => dialog as FakeDialog };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function settleAll() {
  for (let i = 0; i < 20; i++) await settle();
}

describe('CallRun — outbound opening', () => {
  it('asks for the opening while ringing, holds it, and sends it when the line stays quiet after pickup', async () => {
    const { run, clock, record, spoken, dialog } = setup();
    run.begin();
    expect(dialog().sent).toEqual([OPENING_CUE]);
    dialog().reply('안녕하세요, 소마예요. 잠깐 통화 괜찮으세요?');
    await settleAll();
    expect(spoken).toEqual(['안녕하세요, 소마예요.', '잠깐 통화 괜찮으세요?']);
    expect(record.transcript).toEqual([]); // nobody has heard it yet

    const call = fakeCall();
    run.attach(call as unknown as CallSessionLike);
    expect(record.status).toBe('active');
    expect(call.frames).toBe(0);
    clock.advance(1300);
    await settleAll();
    expect(call.frames).toBe(80); // two sentences × 400 ms × 8 kHz × 2 B ÷ 160 B (the identity codec)
    expect(record.transcript.map((l) => [l.role, l.text])).toEqual([
      ['agent', '안녕하세요, 소마예요.'],
      ['agent', '잠깐 통화 괜찮으세요?'],
    ]);
    expect(call.emitted[0]).toEqual(['assistant', '안녕하세요, 소마예요.']);
    expect(record.work.some((w) => w.kind === 'reply')).toBe(true);
    expect(record.work.filter((w) => w.kind === 'tts')).toHaveLength(2);
  });

  it('waits for the other side to finish its hello, and does not send a bare hello to the model', async () => {
    const { run, clock, record, dialog } = setup({}, ['여보세요?']);
    run.begin();
    dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    run.attach(call as unknown as CallSessionLike);
    run.feedAudio(quiet(400));
    run.feedAudio(tone(500, 0.3)); // "여보세요?" starts before the 1.2 s opening wait
    clock.advance(1300);
    expect(call.frames).toBe(0); // still talking: hold
    run.feedAudio(quiet(800)); // the hello ended → release now
    await settleAll();
    expect(call.frames).toBe(40);
    expect(record.transcript.map((l) => l.role)).toEqual(['agent', 'peer']);
    expect(dialog().sent).toEqual([OPENING_CUE]); // "여보세요?" heard and logged, not a turn
  });
});

describe('CallRun — conversation', () => {
  async function talking() {
    const s = setup({}, ['오늘 회의가 두 개 있어요.', '잠깐만요']);
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000); // the opening has played out
    return { ...s, call };
  }

  it('hears an utterance, transcribes it and sends it to the dialog', async () => {
    const { run, record, dialog } = await talking();
    run.feedAudio(quiet(400));
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    expect(dialog().sent[dialog().sent.length - 1]).toBe('오늘 회의가 두 개 있어요.');
    expect(record.transcript[record.transcript.length - 1]).toMatchObject({
      role: 'peer',
      text: '오늘 회의가 두 개 있어요.',
    });
    expect(record.work.find((w) => w.kind === 'stt')).toMatchObject({ text: '오늘 회의가 두 개 있어요.', ms: 5 });
  });

  it('barge-in: stops playback, marks the cut line and interrupts a reply still being written', async () => {
    const { run, record, dialog, call } = await talking();
    run.feedAudio(quiet(300));
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    // The model starts a long answer; its first sentence plays.
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 그리고' });
    await settleAll();
    expect(call.frames).toBeGreaterThan(40);
    // The other side talks over it.
    run.feedAudio(tone(300, 0.6));
    await settleAll();
    expect(call.cleared).toBe(1);
    expect(dialog().interrupted).toBe(1);
    expect(record.transcript.find((l) => l.text === '네, 회의 두 개 확인했어요.')?.interrupted).toBe(true);
    expect(record.work.some((w) => w.kind === 'event' && w.text.includes('끼어듦'))).toBe(true);
  });

  it('a caller who goes on talking while the reply is still being written gets one answer to all of it', async () => {
    const s = setup({ direction: 'inbound' }, ['내일 회의 시간 알려 주세요', '아 그리고 장소도요']);
    s.run.begin();
    s.run.attach(fakeCall() as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    s.clock.advance(3000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800)); // a pause: the first part goes to the model
    await settleAll();
    expect(s.dialog().sent).toContain('내일 회의 시간 알려 주세요');
    s.dialog().emit({ type: 'text_delta', text: '내일 회' }); // it starts answering …
    await settleAll();
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800)); // … while the caller goes on
    await settleAll();
    expect(s.dialog().interrupted).toBe(1); // the answer to half a question is dropped
    expect(s.dialog().sent).not.toContain('아 그리고 장소도요'); // not before that turn has ended
    s.dialog().emit({ type: 'text_delta', text: '의는 세 시예요. ' });
    s.dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(s.spoken).not.toContain('내일 회의는 세 시예요.');
    expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('아 그리고 장소도요');
    s.dialog().reply('내일 회의는 세 시, 삼 층 회의실이에요.');
    await settleAll();
    expect(s.spoken.join(' ')).toContain('내일 회의는 세 시, 삼 층 회의실이에요.');
    expect(s.record.work.some((w) => w.kind === 'error')).toBe(false);
  });

  for (const order of ['handler first', 'event first'] as const) {
    it(`the goodbye of a reply that answered out-of-date words is not said, and the call goes on (${order})`, async () => {
      const s = setup({ direction: 'inbound' }, ['네 감사합니다', '아 잠깐만요, 하나 더 있어요']);
      s.run.begin();
      const call = fakeCall();
      s.run.attach(call as unknown as CallSessionLike);
      s.dialog().reply('네, 말씀하세요.');
      await settleAll();
      s.clock.advance(3000);
      s.run.feedAudio(tone(600, 0.3));
      s.run.feedAudio(quiet(800)); // "네 감사합니다"
      await settleAll();
      s.run.feedAudio(tone(600, 0.3));
      s.run.feedAudio(quiet(800)); // "… 하나 더 있어요" while the model is still on the first part
      await settleAll();
      // The model, still answering the first part, says goodbye and hangs up — the handler and the stream's
      // tool_use event may come in either order.
      s.dialog().emit({ type: 'text_delta', text: '네, 좋은 하루 보내세요.' });
      let result = '';
      if (order === 'handler first') result = String(await s.dialog().tool('hang_up').handler({ reason: '마무리' }));
      s.dialog().emit({ type: 'tool_use', name: 'hang_up', input: {} });
      await settleAll();
      if (order === 'event first') result = String(await s.dialog().tool('hang_up').handler({ reason: '마무리' }));
      s.dialog().emit({ type: 'turn_end', isError: false });
      await settleAll();
      s.clock.advance(5000);
      await settleAll();
      expect(call.hungUp).toBe(0);
      expect(result).toContain('끊지 않았다');
      expect(s.spoken).not.toContain('네, 좋은 하루 보내세요.');
      expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('아 잠깐만요, 하나 더 있어요');
    });
  }

  it('words heard while a dropped reply is still ending are all sent together, once, after it', async () => {
    const s = setup({ direction: 'inbound' }, ['내일 회의', '시간이랑', '장소 알려 주세요']);
    s.run.begin();
    s.run.attach(fakeCall() as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    s.clock.advance(3000);
    for (let i = 0; i < 3; i++) {
      s.run.feedAudio(tone(400, 0.3));
      s.run.feedAudio(quiet(800));
      await settleAll();
      if (i === 0) s.dialog().emit({ type: 'text_delta', text: '네, ' }); // it starts on "내일 회의"
      await settleAll();
    }
    expect(s.dialog().interrupted).toBe(1);
    const before = s.dialog().sent.length;
    s.dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(s.dialog().sent.slice(before)).toEqual(['시간이랑 장소 알려 주세요']);
  });

  it('newer words stop a reply that is playing its first sentence while the rest is still being written', async () => {
    const { run, record, dialog, call } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    run.feedAudio(tone(200, 0.3)); // the caller starts again before the reply makes a sound
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 그리고 ' }); // no turn_end: still writing
    await settleAll();
    expect(call.frames).toBeGreaterThan(0); // its first sentence plays over the caller
    const before = dialog().sent.length;
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // "잠깐만요" is transcribed
    await settleAll();
    expect(call.cleared).toBeGreaterThanOrEqual(1);
    expect(dialog().interrupted).toBe(1);
    expect(dialog().sent.length).toBe(before); // not before the dropped turn has ended
    const agentLines = record.transcript.filter((l) => l.role === 'agent');
    expect(agentLines[agentLines.length - 1]).toMatchObject({ text: '네, 회의 두 개 확인했어요.', interrupted: true });
    dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(dialog().sent.slice(before)).toEqual(['잠깐만요']);
  });

  it('newer words stop a reply that started playing while the caller was still talking', async () => {
    const { run, record, dialog, call, clock } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    run.feedAudio(tone(200, 0.3)); // the caller starts again before the reply makes a sound (no barge-in yet)
    dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    expect(call.frames).toBeGreaterThan(0); // the reply is playing over the caller
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // "잠깐만요" is transcribed
    await settleAll();
    expect(call.cleared).toBeGreaterThanOrEqual(1);
    expect(dialog().sent[dialog().sent.length - 1]).toBe('잠깐만요');
    const agentLines = record.transcript.filter((l) => l.role === 'agent');
    expect(agentLines[agentLines.length - 1]).toMatchObject({ text: '시간도 알려 드릴까요?', interrupted: true });
    expect(record.work.some((w) => w.kind === 'event' && w.text.includes('말을 이어감'))).toBe(true);
    clock.advance(1);
  });

  it('hang_up: says the goodbye first, then puts the phone down; text after it is not spoken', async () => {
    const { run, clock, dialog, call, spoken } = await talking();
    dialog().emit({ type: 'text_delta', text: '감사합니다. 좋은 하루 보내세요!' });
    // The CLI may run the tool before the page has read the words before it: the handler alone decides nothing.
    const result = await dialog().tool('hang_up').handler({ reason: 'done' });
    expect(result).toContain('끊는다');
    dialog().emit({ type: 'tool_use', name: 'mcp__phone__hang_up', input: { reason: 'done' } });
    dialog().emit({ type: 'text_delta', text: ' 통화를 종료했습니다.' });
    dialog().emit({ type: 'turn_end', isError: false });
    await settleAll();
    expect(spoken.slice(-2)).toEqual(['감사합니다.', '좋은 하루 보내세요!']);
    expect(call.hungUp).toBe(0);
    clock.advance(3000);
    await settleAll();
    expect(call.hungUp).toBe(1);
    void run;
  });

  it('stop() ends the dialog and every timer', async () => {
    const { run, clock, dialog, call } = await talking();
    run.stop();
    expect(dialog().closed).toBe(true);
    clock.advance(10 * 60_000);
    await settleAll();
    expect(call.hungUp).toBe(0);
  });

  it('time limit: asks the agent to wrap up, then cuts the line', async () => {
    const { clock, dialog, call } = await talking();
    clock.advance(5 * 60_000);
    expect(dialog().sent[dialog().sent.length - 1]).toContain('통화 시간 한도');
    clock.advance(26_000);
    await settleAll();
    expect(call.hungUp).toBe(1);
  });
});

describe('CallRun — a quiet line', () => {
  it('after the opening, a silent line gets one nudge, then is put down — even though the nudge was answered', async () => {
    const { run, clock, dialog } = setup();
    run.begin();
    dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    run.attach(call as unknown as CallSessionLike);
    clock.advance(1300); // released: the opening plays
    await settleAll();
    clock.advance(16_000);
    expect(dialog().sent[dialog().sent.length - 1]).toBe(SILENCE_CUE);
    dialog().reply('여보세요, 제 말 들리세요?');
    await settleAll();
    expect(call.hungUp).toBe(0);
    clock.advance(31_000);
    await settleAll();
    expect(call.hungUp).toBe(1);
  });

  it('never nudges while a later sentence of the same reply is still being spoken; nudges after it', async () => {
    let slow = false;
    let letGo!: () => void;
    const { run, clock, dialog } = setup({ direction: 'inbound' }, [], {
      speakGate: () =>
        slow
          ? new Promise<void>((r) => {
              letGo = r;
            })
          : Promise.resolve(),
    });
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    // The first sentence is spoken while the model is still writing: the queue drains and the timer is armed.
    dialog().emit({ type: 'text_delta', text: '정리해 드릴게요. ' });
    await settleAll();
    // The next sentence takes long to synthesize; the turn ends meanwhile (nothing is generating any more).
    slow = true;
    dialog().emit({ type: 'text_delta', text: '연락처와 용건을 담당자에게 그대로 전하겠습니다.' });
    dialog().emit({ type: 'turn_end', isError: false });
    await settleAll();
    clock.advance(16_000); // past the timer armed after the first sentence
    expect(dialog().sent.filter((t) => t === SILENCE_CUE)).toEqual([]);
    letGo();
    await settleAll();
    clock.advance(16_000); // the reply has played out: now the line is quiet
    expect(dialog().sent.filter((t) => t === SILENCE_CUE)).toEqual([SILENCE_CUE]);
  });

  it('after the inbound greeting, a silent caller is nudged', async () => {
    const { run, clock, dialog } = setup({
      direction: 'inbound',
      greeting: { text: '안녕하세요', frames: [Buffer.alloc(160), Buffer.alloc(160)] },
    });
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    clock.advance(16_000);
    expect(dialog().sent).toEqual([SILENCE_CUE]);
  });

  it('a sound that transcribes to nothing does not leave the line waiting forever', async () => {
    const { run, clock, dialog } = setup({ direction: 'inbound' }, ['']);
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    dialog().reply('네, 말씀하세요.');
    await settleAll();
    clock.advance(1000);
    run.feedAudio(quiet(300));
    run.feedAudio(tone(500, 0.3)); // a cough: the timer is cleared while it lasts
    run.feedAudio(quiet(800));
    await settleAll();
    clock.advance(16_000);
    expect(dialog().sent[dialog().sent.length - 1]).toBe(SILENCE_CUE);
  });
});

describe('CallRun — a warm voice engine', () => {
  it('wakes the speech engine once the other side is transcribed (not during it), at most once every few seconds', async () => {
    const { run, clock, warmed, dialog } = setup({ direction: 'inbound' }, ['네', '그리고요', '하나 더요']);
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    dialog().reply('네, 말씀하세요.');
    await settleAll();
    clock.advance(2_000); // the agent has finished speaking
    run.feedAudio(quiet(300));
    run.feedAudio(tone(400, 0.3)); // the caller talks: the engine sat idle meanwhile
    expect(warmed).toHaveLength(0);
    run.feedAudio(quiet(800)); // … and stops: transcription runs first (a wake-up now would slow it down)
    expect(warmed).toHaveLength(0);
    await settleAll(); // transcribed: the reply reaches the engine in ~1 s, wake it now
    expect(warmed).toHaveLength(1);
    clock.advance(2_900);
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // a second utterance 2.9 s later: still within the 3 s window, no second ping
    await settleAll();
    expect(warmed).toHaveLength(1);
    clock.advance(200);
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // 3.1 s after the first: wakes it again
    await settleAll();
    expect(warmed).toHaveLength(2);
  });

  it('wakes the engine only after a slow transcription has finished, then hands its words to the dialog', async () => {
    let heard!: () => void;
    const { run, clock, warmed, dialog } = setup({ direction: 'inbound' }, ['예약 확인하려고요'], {
      sttGate: () =>
        new Promise<void>((r) => {
          heard = r;
        }),
    });
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    dialog().reply('네, 말씀하세요.');
    await settleAll();
    clock.advance(2_000);
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // the caller stops: transcription starts and takes a while
    await settleAll();
    expect(warmed).toEqual([]); // nothing beside the transcription
    expect(dialog().sent).not.toContain('예약 확인하려고요');
    heard();
    await settleAll();
    expect(warmed).toHaveLength(1);
    expect(dialog().sent).toContain('예약 확인하려고요');
  });

  it('skips the wake-up while the agent is still synthesizing (the engine is awake)', async () => {
    let letGo!: () => void;
    const { run, warmed, dialog } = setup({}, ['여보세요?'], {
      speakGate: () =>
        new Promise<void>((r) => {
          letGo = r;
        }),
    });
    run.begin();
    dialog().reply('안녕하세요, 소마예요. 잠깐 통화 괜찮으세요?');
    await settleAll(); // the opening is being synthesized while it rings
    run.attach(fakeCall() as unknown as CallSessionLike);
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // "여보세요?" ends while the opening is still in synthesis
    await settleAll();
    expect(warmed).toEqual([]);
    letGo();
    await settleAll();
  });

  it('does not wait for the wake-up: the words reach the dialog while it runs, and it is cancelled with the call', async () => {
    let warmSignal: AbortSignal | undefined;
    const { run, clock, warmed, dialog } = setup({ direction: 'inbound' }, ['예약 확인하려고요'], {
      warm: (signal) => {
        warmSignal = signal;
        return new Promise<void>(() => undefined); // a voice service that never answers
      },
    });
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    dialog().reply('네, 말씀하세요.');
    await settleAll();
    clock.advance(2_000);
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    expect(warmed).toHaveLength(1);
    expect(dialog().sent).toContain('예약 확인하려고요');
    expect(warmSignal?.aborted).toBe(false);
    run.stop();
    expect(warmSignal?.aborted).toBe(true);
  });
});

describe('CallRun — inbound', () => {
  it('plays the prepared greeting the moment the line opens', async () => {
    const { run, record, dialog } = setup({
      direction: 'inbound',
      greeting: { text: '안녕하세요', frames: [Buffer.alloc(160), Buffer.alloc(160)] },
    });
    run.begin();
    expect(dialog().sent).toEqual([]);
    const call = fakeCall();
    run.attach(call as unknown as CallSessionLike);
    expect(call.frames).toBe(2);
    expect(record.transcript).toMatchObject([{ role: 'agent', text: '안녕하세요' }]);
  });

  it('without a prepared greeting, asks the dialog to greet', async () => {
    const { run, dialog } = setup({ direction: 'inbound' });
    run.begin();
    run.attach(fakeCall() as unknown as CallSessionLike);
    expect(dialog().sent[0]).toContain('걸려 온 전화');
  });
});

describe('PhoneVoiceSession', () => {
  it('routes the line to the registered run, one call at a time', async () => {
    const { run } = setup();
    run.begin();
    const session = new PhoneVoiceSession(async () => null);
    expect(session.busy).toBe(false);
    session.register(run);
    expect(session.busy).toBe(true);
    const call = fakeCall();
    await session.start(call as unknown as CallSessionLike);
    session.end('CA1');
    expect(session.busy).toBe(false);
  });

  it('prepares an unprepared call once, however many times the SDK starts it', async () => {
    const { run } = setup({ direction: 'inbound' });
    let made = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const session = new PhoneVoiceSession(async () => {
      made++;
      await gate;
      run.begin();
      return run;
    });
    const call = fakeCall();
    const a = session.start(call as unknown as CallSessionLike);
    const b = session.start(call as unknown as CallSessionLike);
    release();
    await Promise.all([a, b]);
    expect(made).toBe(1);
    expect(session.busy).toBe(true);
    await session.stop();
    expect(session.busy).toBe(false);
  });

  it('puts down a call nothing was prepared for', async () => {
    const session = new PhoneVoiceSession(async () => null);
    const call = fakeCall();
    await session.start(call as unknown as CallSessionLike);
    expect(call.hungUp).toBe(1);
  });
});
