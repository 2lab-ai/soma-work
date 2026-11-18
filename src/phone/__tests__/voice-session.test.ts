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
  /** The event loop was blocked: time jumps, then every timer that came due fires — late. */
  lag(ms: number) {
    this.t += ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > this.t) break;
      this.timers.shift();
      next.fn();
    }
  }
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
    /** Peak level (0..1) of every frame sent (the identity codec: the frames are PCM). */
    levels: [] as number[],
    emitted: [] as Array<[string, string]>,
    sendAudio(b: Buffer) {
      call.frames++;
      let m = 0;
      for (let i = 0; i + 1 < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i)));
      call.levels.push(m / 32767);
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
    /** Length of the audio each synthesis returns. Default 400 ms. */
    speakMs?: number;
    warm?: (signal?: AbortSignal) => Promise<void>;
    sttGate?: () => Promise<void>;
    /** The audio a synthesis streams, chunk by chunk (default: one chunk of `speakMs`). */
    speakChunks?: (text: string) => AsyncGenerator<Buffer>;
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
      const text = stt.shift() ?? ''; // the words of this utterance, whenever the recogniser answers
      await opts.sttGate?.();
      return { text, ms: 5 };
    },
    async speak(text) {
      spoken.push(text);
      await opts.speakGate?.();
      const pcm = tone(opts.speakMs ?? 400, 0.2); // 400 ms of speech per sentence = 20 frames of 160 B (identity codec)
      return {
        sampleRate: RATE,
        headersMs: 1,
        chunks:
          opts.speakChunks?.(text) ??
          (async function* () {
            yield pcm;
          })(),
      };
    },
  };
  const run = new CallRun(
    // No turn hold unless a test asks for one: the words of an utterance go on as soon as they are recognised.
    { callId: 'CA1', direction: 'outbound', maxMinutes: 5, turnHoldMs: 0, ...plan },
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
    expect(call.frames).toBeGreaterThan(0); // sent in real time, a short lead ahead of playback …
    expect(call.frames).toBeLessThan(80);
    clock.advance(2000);
    expect(call.frames).toBe(80); // … all of it: two sentences × 400 ms × 8 kHz × 2 B ÷ 160 B (the identity codec)
    expect(record.transcript.map((l) => [l.role, l.text])).toEqual([
      ['agent', '안녕하세요, 소마예요.'],
      ['agent', '잠깐 통화 괜찮으세요?'],
    ]);
    expect(call.emitted[0]).toEqual(['assistant', '안녕하세요, 소마예요.']);
    expect(record.work.some((w) => w.kind === 'reply')).toBe(true);
    expect(record.work.filter((w) => w.kind === 'tts')).toHaveLength(2);
  });

  it('does not cut the opening for the words that released it (a hello the recogniser did not know as one)', async () => {
    const s = setup({}, ['네, 여기서요']);
    s.run.begin();
    s.dialog().reply('안녕하세요, 홍길동님 맞으시죠? 김민수님이 보내서 전화드렸어요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.run.feedAudio(tone(700, 0.3)); // "네, 여보세요" as the phone is picked up
    s.run.feedAudio(quiet(600)); // its end releases the opening
    await settleAll(); // … and its transcript arrives while the opening plays
    expect(call.cleared).toBe(0);
    expect(s.record.transcript.filter((l) => l.role === 'agent').every((l) => !l.interrupted)).toBe(true);
    expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('네, 여기서요'); // answered after the opening
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
    clock.advance(1000);
    expect(call.frames).toBe(40);
    expect(record.transcript.map((l) => l.role)).toEqual(['peer', 'agent']); // the hello, then the opening it released
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

  it('barge-in: lowers the voice, then fades out and stops; marks the cut line and interrupts the reply', async () => {
    const { run, record, dialog, call, clock } = await talking();
    run.feedAudio(quiet(300));
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    // The model starts a long answer; its first sentence plays.
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 그리고' });
    await settleAll();
    expect(call.frames).toBeGreaterThan(40);
    // A short sound over it ("네", "아, 예") is not an interruption …
    run.feedAudio(tone(300, 0.6));
    await settleAll();
    expect(call.cleared).toBe(0);
    // … talking over it for more than half a second is: the voice fades out (it ends its word) and stops.
    run.feedAudio(tone(400, 0.6));
    await settleAll();
    const atCut = call.frames;
    clock.advance(3000);
    await settleAll();
    expect(call.frames - atCut).toBeLessThanOrEqual(10 + 15 + 1); // the lead already sent + a 300 ms fade
    expect(call.levels[call.levels.length - 1]).toBeLessThan(0.1);
    expect(call.cleared).toBe(0); // not cut dead
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

  it('a short "네" while the agent talks does not stop it; the words reach the model after this reply', async () => {
    const { run, dialog, call } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 시간도 알려 드릴게요. ' });
    await settleAll();
    expect(call.frames).toBeGreaterThan(0);
    const before = dialog().sent.length;
    run.feedAudio(tone(300, 0.6)); // "네" over the agent
    run.feedAudio(quiet(800));
    await settleAll();
    expect(call.cleared).toBe(0);
    expect(dialog().interrupted).toBe(0);
    expect(dialog().sent.length).toBe(before); // the reply is still being written: the "네" waits for it
    dialog().emit({ type: 'turn_end', isError: false });
    await settleAll();
    expect(dialog().sent.slice(before)).toEqual(['잠깐만요']);
  });

  /** Feed audio the way the line does: 20 ms frames (160 B of μ-law; the identity codec keeps the bytes). */
  function frames(run: { feedAudio(b: Buffer): void }, pcm: Buffer) {
    for (let off = 0; off < pcm.length; off += 160) run.feedAudio(pcm.subarray(off, off + 160));
  }

  it('in 20 ms frames, a 500 ms "네" and the quiet after it do not add up to an interruption', async () => {
    const { run, dialog, call } = await talking();
    frames(run, tone(600, 0.3));
    frames(run, quiet(800));
    await settleAll();
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 시간도 알려 드릴게요. ' });
    await settleAll();
    frames(run, tone(500, 0.6)); // just under the bar …
    frames(run, quiet(800)); // … and the recogniser's wait for the end: quiet, not speech
    await settleAll();
    expect(call.cleared).toBe(0);
    expect(dialog().interrupted).toBe(0);
  });

  it('two short "네"s over the same reply do not add up to an interruption; both reach the model after it', async () => {
    const s = setup({ direction: 'inbound' }, ['내일 회의는요?', '네', '네네']);
    s.run.begin();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    s.clock.advance(3000);
    frames(s.run, tone(600, 0.3));
    frames(s.run, quiet(800));
    await settleAll();
    s.dialog().emit({ type: 'text_delta', text: '내일 회의는 세 시예요. 장소는 삼 층 회의실이고요. ' });
    await settleAll();
    const before = s.dialog().sent.length;
    for (let i = 0; i < 2; i++) {
      frames(s.run, tone(400, 0.6)); // 400 + 400 ms: more than the bar together, not alone
      frames(s.run, quiet(800));
      await settleAll();
    }
    expect(call.cleared).toBe(0);
    expect(s.dialog().interrupted).toBe(0);
    s.dialog().emit({ type: 'turn_end', isError: false });
    await settleAll();
    expect(s.dialog().sent.slice(before)).toEqual(['네 네네']);
  });

  it('a real interruption between two sentences of a reply still being written drops that reply', async () => {
    const { run, dialog, call, clock } = await talking();
    frames(run, tone(600, 0.3));
    frames(run, quiet(800));
    await settleAll();
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. ' }); // its first sentence plays …
    await settleAll();
    frames(run, tone(200, 0.6)); // … the caller starts over it
    clock.advance(5000); // the sentence has played out; the model is still writing the next
    frames(run, tone(500, 0.6)); // the caller goes on: a real interruption, with nothing playing right now
    await settleAll();
    expect(dialog().interrupted).toBe(1);
    dialog().emit({ type: 'text_delta', text: '그리고 시간도 알려 드릴게요.' }); // what it still writes is not said
    dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(call.frames).toBeGreaterThan(0);
  });

  it('a whole interruption arriving in one packet interrupts at once, not when its words are recognised', async () => {
    let slow = false;
    const s = setup({ direction: 'inbound' }, ['오늘 회의가 두 개 있어요.', '잠깐만요'], {
      sttGate: () => (slow ? new Promise<void>(() => undefined) : Promise.resolve()),
    });
    s.run.begin();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    s.clock.advance(3000);
    frames(s.run, tone(600, 0.3));
    frames(s.run, quiet(800));
    await settleAll();
    s.dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 그리고 ' });
    await settleAll();
    slow = true; // its words will not be recognised in time
    s.run.feedAudio(Buffer.concat([tone(700, 0.6), quiet(800)])); // speech start and its end in one push
    await settleAll();
    expect(s.dialog().interrupted).toBe(1);
    const atCut = call.frames;
    s.clock.advance(3000);
    expect(call.frames - atCut).toBeLessThanOrEqual(10 + 15 + 1); // faded out at once, the rest never sent
  });

  it('a "네" waiting for the reply is not answered on its own when a real interruption follows', async () => {
    let heard!: () => void;
    let gate: Promise<void> | null = null;
    const s = setup({ direction: 'inbound' }, ['내일 회의는요?', '네', '아니 잠깐만요 장소를 바꿔야 해요'], {
      sttGate: () => gate ?? Promise.resolve(),
    });
    s.run.begin();
    s.run.attach(fakeCall() as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    s.clock.advance(3000);
    frames(s.run, tone(600, 0.3));
    frames(s.run, quiet(800));
    await settleAll();
    s.dialog().emit({ type: 'text_delta', text: '내일 회의는 세 시예요. 장소는 삼 층이고요. ' });
    await settleAll();
    frames(s.run, tone(300, 0.6)); // "네" over it: waits for the reply
    frames(s.run, quiet(800));
    await settleAll();
    gate = new Promise<void>((r) => {
      heard = r;
    }); // the next words take long to recognise
    frames(s.run, tone(900, 0.6)); // a real interruption
    frames(s.run, quiet(800));
    await settleAll();
    const before = s.dialog().sent.length;
    s.dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(s.dialog().sent.length).toBe(before); // the "네" is not sent alone while the caller's words are pending
    heard();
    await settleAll();
    const sent = s.dialog().sent.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^\[시스템: 상대가 끼어들어 네 말이 "[^"]*"에서 끊겼다/); // what was cut, for the model
    expect(sent[0].endsWith('\n네 아니 잠깐만요 장소를 바꿔야 해요')).toBe(true);
  });

  it('a sound that interrupted nothing still leaves the line watched: the quiet-line nudge comes', async () => {
    const { run, clock, dialog } = await talking();
    clock.advance(3000); // the opening has played out; the agent waits
    run.feedAudio(tone(100, 0.6)); // a click on the line: speech starts, then turns out to be noise
    run.feedAudio(quiet(800));
    await settleAll();
    clock.advance(16_000);
    await settleAll();
    expect(dialog().sent[dialog().sent.length - 1]).toBe(SILENCE_CUE);
  });

  it('a reply still being written does not start over a caller who talks again; newer words drop it', async () => {
    const { run, record, dialog, call } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    const atReply = call.frames;
    run.feedAudio(tone(200, 0.3)); // the caller starts again before the reply makes a sound
    dialog().emit({ type: 'text_delta', text: '네, 회의 두 개 확인했어요. 그리고 ' }); // no turn_end: still writing
    await settleAll();
    expect(call.frames).toBe(atReply); // its first sentence is made, but not said over the caller
    const before = dialog().sent.length;
    run.feedAudio(tone(400, 0.3));
    run.feedAudio(quiet(800)); // "잠깐만요" is transcribed
    await settleAll();
    expect(call.frames).toBe(atReply); // never said
    expect(record.work.some((w) => w.kind === 'event' && w.text.includes('말을 이어감'))).toBe(true);
    expect(dialog().interrupted).toBe(1);
    expect(dialog().sent.length).toBe(before); // not before the dropped turn has ended
    expect(record.transcript.some((l) => l.role === 'agent' && l.text === '네, 회의 두 개 확인했어요.')).toBe(false);
    dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    const last = dialog().sent[dialog().sent.length - 1];
    expect(last).toContain('"네, 회의 두 개 확인했어요."'); // the model hears it was not heard
    expect(last.endsWith('\n잠깐만요')).toBe(true);
    expect(dialog().sent.slice(before)).toHaveLength(1);
  });

  it('a real interruption fades a playing reply; the model hears what was heard and what was not said', async () => {
    const { run, record, dialog, call, clock } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    expect(call.frames).toBeGreaterThan(0); // the reply plays
    run.feedAudio(tone(900, 0.6)); // talking over it: "잠깐만요"
    const atCut = call.frames;
    run.feedAudio(quiet(800));
    await settleAll();
    clock.advance(3000);
    expect(call.frames - atCut).toBeLessThanOrEqual(10 + 15 + 1); // faded out, the rest never sent
    // The model hears what was cut: the words go with a note of what the caller heard and what was not said.
    const last = dialog().sent[dialog().sent.length - 1];
    expect(last).toMatch(
      /^\[시스템: 상대가 끼어들어 네 말이 "[^"]*"에서 끊겼다\. 못 한 말: "[^"]*시간도 알려 드릴까요\?"/,
    );
    expect(last.endsWith('\n잠깐만요')).toBe(true);
    const agentLines = record.transcript.filter((l) => l.role === 'agent');
    // Only what started to sound is in the transcript: the cut piece is marked, the unheard one is not there.
    expect(agentLines[agentLines.length - 1]).toMatchObject({ text: '네, 회의 두 개 확인했어요.', interrupted: true });
    expect(agentLines.some((l) => l.text === '시간도 알려 드릴까요?')).toBe(false);
    expect(record.work.some((w) => w.kind === 'event' && w.text.includes('끼어듦'))).toBe(true);
    clock.advance(1);
  });

  it('a second interruption tells the model about the reply it cut, not again about the one cut before', async () => {
    const s = setup({}, ['오늘 회의가 두 개 있어요.', '잠깐만요', '아니 그게 아니라']);
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    s.clock.advance(100);
    s.run.feedAudio(tone(900, 0.6)); // a real interruption: the second piece is never heard
    s.run.feedAudio(quiet(800));
    await settleAll();
    // Its words were recognised while the voice was still fading: the note keeps what was heard of the first piece.
    expect(s.dialog().sent[s.dialog().sent.length - 1]).toMatch(
      /네 말이 "[^"]+"에서 끊겼다\. 못 한 말: "[^"]*시간도 알려 드릴까요\?"/,
    );
    s.clock.advance(3000);
    s.dialog().reply('알겠어요. 무엇을 바꿀까요? 말씀해 주세요.');
    await settleAll();
    s.clock.advance(100);
    s.run.feedAudio(tone(900, 0.6)); // cut again
    s.run.feedAudio(quiet(800));
    await settleAll();
    const last = s.dialog().sent[s.dialog().sent.length - 1];
    expect(last).toContain('무엇을 바꿀까요?');
    expect(last).not.toContain('시간도 알려 드릴까요?');
    expect(last.endsWith('\n아니 그게 아니라')).toBe(true);
  });

  it('a cut before the next reply makes a sound tells the model that reply went unheard — not the earlier one', async () => {
    let gate: Promise<void> | null = null;
    const s = setup({}, ['오늘 회의가 두 개 있어요.', '잠깐만요', '아니 그게 아니라'], {
      speakGate: () => gate ?? Promise.resolve(),
    });
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    s.clock.advance(100);
    s.run.feedAudio(tone(900, 0.6)); // cut while its first piece plays
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.clock.advance(3000);
    let started: () => void = () => undefined;
    gate = new Promise<void>((r) => {
      started = r;
    }); // the voice engine is slow to start the next piece
    s.dialog().emit({ type: 'text_delta', text: '무엇을 바꿀지 말씀해 주시겠어요? ' });
    await settleAll();
    expect(s.spoken[s.spoken.length - 1]).toBe('무엇을 바꿀지 말씀해 주시겠어요?'); // being made
    const before = call.frames;
    s.run.feedAudio(tone(900, 0.6)); // cut again, before a sound of it
    s.run.feedAudio(quiet(800));
    await settleAll();
    expect(call.frames).toBe(before);
    s.dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    const last = s.dialog().sent[s.dialog().sent.length - 1];
    expect(last).toContain('"무엇을 바꿀지 말씀해 주시겠어요?"');
    expect(last).not.toContain('회의 두 개 확인했어요');
    expect(last.endsWith('\n아니 그게 아니라')).toBe(true);
    // The cut piece's engine call returns late (it was aborted): nothing of it is said.
    gate = null;
    started();
    await settleAll();
    // The answer to the new words plays whole, at full voice: the cut left nothing behind to fade it.
    const at = call.levels.length;
    s.dialog().reply('알겠어요, 어떻게 바꿀까요?');
    await settleAll();
    s.clock.advance(3000);
    const answer = call.levels.slice(at);
    expect(answer.length).toBeGreaterThanOrEqual(39);
    expect(Math.min(...answer.slice(1, -1))).toBeGreaterThan(0.18);
  });

  it('a piece cut while still being made: what was heard is judged by the length it would have had', async () => {
    const long = '이번 분기 매출은 지난 분기보다 조금 늘었고 비용은 줄어서 이익이 꽤 좋아졌어요.';
    const s = setup({}, ['실적 어때요?', '잠깐만요'], {
      speakChunks: (text) =>
        (async function* () {
          if (text !== long) {
            yield tone(400, 0.2);
            return;
          }
          yield tone(1000, 0.2); // the first second of it …
          await new Promise(() => undefined); // … and the engine is still making the rest
        })(),
    });
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.'); // 400 ms for 11 characters: how fast this voice speaks
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply(long);
    await settleAll();
    s.clock.advance(800); // half of what is made so far has played — a third of the whole sentence
    s.run.feedAudio(tone(900, 0.6));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const last = s.dialog().sent[s.dialog().sent.length - 1];
    const heard = /네 말이 "([^"]*)"에서 끊겼다/.exec(last)?.[1] ?? '';
    // About a third: judged by this voice's pace (learnt from the opening), not by a fixed guess.
    expect(heard.length).toBeGreaterThan(long.length * 0.25);
    expect(heard.length).toBeLessThan(long.length * 0.4);
  });

  it('a piece still being made whose sound so far has all played is still cut: the model hears it was', async () => {
    const piece = '이번 주 일정은 월요일 회의 하나뿐이에요.';
    const s = setup({}, ['이번 주 일정이요?', '잠깐만요'], {
      speakChunks: (text) =>
        (async function* () {
          // More of the piece is made than this voice's pace would give its words; then the engine stalls.
          yield tone(text === piece ? 1000 : 400, 0.2);
          if (text === piece) await new Promise(() => undefined);
        })(),
    });
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply(piece);
    await settleAll();
    s.clock.advance(3000); // what was made of it has played; the rest is not made yet
    s.run.feedAudio(tone(900, 0.6));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const last = s.dialog().sent[s.dialog().sent.length - 1];
    expect(last).toMatch(/^\[시스템: 상대가 끼어들어 네 말이 "[^"]*"에서 끊겼다\. 못 한 말: "[^"]+"/);
    expect(s.record.transcript.find((l) => l.text === piece)?.interrupted).toBe(true);
  });

  it('a short piece made in full is judged by its own length, not by the pace of the voice', async () => {
    const s = setup({}, ['괜찮을까요?', '잠깐만요'], {
      speakChunks: (text) =>
        (async function* () {
          yield tone(text === '안녕하세요, 소마예요.' ? 2000 : 400, 0.2); // a slow opening, a quick short answer
        })(),
    });
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(5000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply('네, 좋아요.');
    await settleAll();
    s.clock.advance(300); // more than half of it has played
    s.run.feedAudio(tone(900, 0.6));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const heard = /네 말이 "([^"]*)"에서 끊겼다/.exec(s.dialog().sent[s.dialog().sent.length - 1])?.[1] ?? '';
    expect(heard.length).toBeGreaterThanOrEqual(3);
  });

  it('an answer that comes while the cut voice is still fading plays whole, at full voice', async () => {
    const { run, dialog, call, clock } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    clock.advance(100);
    run.feedAudio(tone(900, 0.6)); // cut: the voice starts to fade …
    run.feedAudio(quiet(800)); // … and "잠깐만요" goes to the model at once
    await settleAll();
    const at = call.levels.length;
    dialog().reply('네, 말씀하세요.'); // answered before the fade is over
    await settleAll();
    clock.advance(3000);
    // The answer is 40 frames (400 ms of identity-codec PCM): all of them go out at full voice, after the fade.
    const answer = call.levels.slice(at);
    const full = answer.filter((l) => l > 0.19);
    expect(full.length).toBeGreaterThanOrEqual(39);
    expect(Math.min(...answer.slice(-39))).toBeGreaterThan(0.19);
  });

  it('newer words while the cut voice still fades drop a quick answer that came meanwhile; the model hears so', async () => {
    const s = setup({}, ['오늘 회의가 두 개 있어요.', '잠깐만요', '아니 그게 아니라']);
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    s.clock.advance(100);
    s.run.feedAudio(tone(900, 0.6)); // cut: the voice fades …
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply('네, 말씀하세요.'); // … a quick answer comes before the fade is over …
    await settleAll();
    const at = call.levels.length;
    s.run.feedAudio(tone(900, 0.6)); // … and the caller cuts in again, still in the fade
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.clock.advance(3000);
    expect(call.levels.slice(at).filter((l) => l > 0.19).length).toBeLessThan(5); // the quick answer is not heard
    const last = s.dialog().sent[s.dialog().sent.length - 1];
    expect(last).toContain('"네, 말씀하세요."');
    expect(last.endsWith('\n아니 그게 아니라')).toBe(true);
  });

  it('a piece the voice engine failed on part-way is not taken as made in full', async () => {
    const long = '이번 분기 매출은 지난 분기보다 조금 늘었고 비용은 줄어서 이익이 꽤 좋아졌어요.';
    const s = setup({}, ['실적 어때요?', '잠깐만요'], {
      speakChunks: (text) =>
        (async function* () {
          if (text !== long) {
            yield tone(400, 0.2);
            return;
          }
          yield tone(1000, 0.2); // the first second of it …
          throw new Error('engine dropped the stream'); // … then the engine fails
        })(),
    });
    s.run.begin();
    s.dialog().reply('안녕하세요, 소마예요.');
    await settleAll();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.clock.advance(1300);
    await settleAll();
    s.clock.advance(1000);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    s.dialog().reply(long);
    await settleAll();
    s.clock.advance(800);
    s.run.feedAudio(tone(900, 0.6));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const heard = /네 말이 "([^"]*)"에서 끊겼다/.exec(s.dialog().sent[s.dialog().sent.length - 1])?.[1] ?? '';
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.length).toBeLessThan(long.length * 0.4); // judged by its words, not by the second that was made
  });

  it('a line that fails to take audio on a timer is reported once and never throws out of the timer', async () => {
    const { run, dialog, call, clock, record } = await talking();
    run.feedAudio(tone(600, 0.3));
    run.feedAudio(quiet(800));
    await settleAll();
    dialog().reply('네, 회의 두 개 확인했어요. 시간도 알려 드릴까요?');
    await settleAll();
    call.sendAudio = () => {
      throw new Error('socket closed');
    };
    expect(() => clock.advance(3000)).not.toThrow();
    const errors = record.work.filter((w) => w.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ stage: 'line', message: 'socket closed' });
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

  it('hang_up after the event loop stalled: the goodbye still plays out before the phone goes down', async () => {
    const { clock, dialog, call } = await talking();
    const before = call.frames;
    let atHangup = -1;
    call.hangup = async () => {
      atHangup = call.frames;
      call.hungUp++;
    };
    dialog().emit({ type: 'text_delta', text: '감사합니다. 좋은 하루 보내세요!' });
    await dialog().tool('hang_up').handler({ reason: 'done' });
    dialog().emit({ type: 'tool_use', name: 'mcp__phone__hang_up', input: { reason: 'done' } });
    dialog().emit({ type: 'turn_end', isError: false });
    await settleAll();
    clock.lag(2300); // the hang-up deadline passes while most of the goodbye is still to go out
    await settleAll();
    clock.advance(5000);
    await settleAll();
    expect(call.hungUp).toBe(1);
    expect(atHangup - before).toBe(80); // both sentences (40 frames each) went out first
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

describe('CallRun — like a live call', () => {
  /** Feed audio the way the line does (20 ms frames), moving the clock with it. */
  function live(s: { run: { feedAudio(b: Buffer): void }; clock: Clock }, pcm: Buffer) {
    for (let off = 0; off < pcm.length; off += 320) {
      s.run.feedAudio(pcm.subarray(off, off + 320));
      s.clock.advance(20);
    }
  }
  async function answering(
    stt: string[],
    extra: {
      speakMs?: number;
      fillers?: CallRunPlan['fillers'];
      turnHoldMs?: number;
      sttGate?: () => Promise<void>;
    } = {},
  ) {
    const s = setup(
      {
        direction: 'inbound',
        fillers: extra.fillers,
        ...(extra.turnHoldMs === undefined ? {} : { turnHoldMs: extra.turnHoldMs }),
      },
      stt,
      { speakMs: extra.speakMs, sttGate: extra.sttGate },
    );
    s.run.begin();
    const call = fakeCall();
    s.run.attach(call as unknown as CallSessionLike);
    s.dialog().reply('네, 말씀하세요.');
    await settleAll();
    // The greeting has played out (with the identity codec a 160 B frame holds 10 ms of PCM but plays as 20 ms).
    s.clock.advance(2 * (extra.speakMs ?? 400) + 3000);
    return { ...s, call };
  }

  it('a "네" over the agent lowers its voice at once and brings it back after; nothing is cut', async () => {
    const s = await answering(['내일 회의 시간이요', '네'], { speakMs: 4000 });
    live(s, tone(600, 0.3));
    live(s, quiet(600));
    await settleAll();
    s.dialog().reply('내일 회의는 세 시예요.');
    await settleAll();
    live(s, quiet(1000)); // the answer plays at full voice
    const full = Math.max(...s.call.levels.slice(-10));
    live(s, tone(300, 0.6)); // "네" over it
    live(s, quiet(200));
    const ducked = Math.max(...s.call.levels.slice(-8));
    expect(ducked).toBeLessThan(full * 0.5);
    live(s, quiet(800)); // it was only a "네"
    await settleAll();
    const back = Math.max(...s.call.levels.slice(-5));
    expect(back).toBeGreaterThan(full * 0.9);
    expect(s.call.cleared).toBe(0);
    expect(s.dialog().interrupted).toBe(0);
    expect(s.record.transcript.filter((l) => l.role === 'agent').some((l) => l.interrupted)).toBe(false);
  });

  it('says a short acknowledgment once the turn is over, then the answer without a second "네"', async () => {
    const fillers = [{ text: '네.', frames: [tone(20, 0.5), tone(20, 0.5), tone(20, 0.5)] }];
    const s = await answering(['내일 회의 시간이요'], { fillers });
    s.run.feedAudio(tone(600, 0.3));
    const before = s.call.frames;
    s.run.feedAudio(quiet(800));
    await settleAll(); // the words are in and the turn is over: "네." goes out now, the answer is being written
    expect(s.call.frames - before).toBe(3);
    expect(s.record.transcript[s.record.transcript.length - 1]).toMatchObject({ role: 'agent', text: '네.' });
    s.dialog().reply('네, 내일 회의는 세 시예요.');
    await settleAll();
    expect(s.spoken[s.spoken.length - 1]).toBe('내일 회의는 세 시예요.');
  });

  it('uses acknowledgments made after the call began (they are made when the line opens, in the background)', async () => {
    const fillers: NonNullable<CallRunPlan['fillers']> = [];
    const s = await answering(['내일 회의 시간이요'], { fillers });
    fillers.push({ text: '네.', frames: [tone(20, 0.5)] }); // ready now
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    expect(s.record.transcript.some((l) => l.role === 'agent' && l.text === '네.')).toBe(true);
  });

  it('keeps the transcript in time order: the words come before the "네." said after them', async () => {
    const fillers = [{ text: '네.', frames: [tone(20, 0.5)] }];
    const s = await answering(['내일 회의 시간이요'], { fillers });
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll(); // recognised after "네." went out
    const tail = s.record.transcript.slice(-2).map((l) => [l.role, l.text]);
    expect(tail).toEqual([
      ['peer', '내일 회의 시간이요'],
      ['agent', '네.'],
    ]);
  });

  it('the recognised words arriving while the acknowledgment still sounds do not cut it', async () => {
    const fillers = [{ text: '네.', frames: Array.from({ length: 30 }, () => tone(20, 0.5)) }]; // 600 ms
    const s = await answering(['그리고 장소는요'], { fillers });
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll(); // recognised while "네." is still going out
    s.clock.advance(1000);
    expect(s.record.transcript.filter((l) => l.role === 'agent').some((l) => l.interrupted)).toBe(false);
    expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('그리고 장소는요');
  });

  it('a "네." said for words that wait on a dropped reply still keeps their answer from opening with "네,"', async () => {
    const fillers = [{ text: '네.', frames: [tone(20, 0.5)] }];
    const s = await answering(['내일 회의 시간이요', '그리고 장소도요'], { fillers });
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800)); // "네." — the answer is being written
    await settleAll();
    s.clock.advance(500);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800)); // more words before it comes: "네." again, and that answer is dropped
    await settleAll();
    s.dialog().emit({ type: 'turn_end', isError: true, message: 'interrupted' });
    await settleAll();
    expect(s.dialog().sent[s.dialog().sent.length - 1]).toContain('그리고 장소도요');
    s.dialog().reply('네, 내일 세 시에 삼 층이에요.');
    await settleAll();
    expect(s.spoken[s.spoken.length - 1]).toBe('내일 세 시에 삼 층이에요.');
  });

  // A real call (owner, 2026-11-18): "내가 말하던 중에 니가 치고 들어온다" — a half-second pause inside a sentence
  // was taken for the end of the turn: "네." and an answer to half of it, while the owner was still talking.
  describe('whose turn it is', () => {
    const fillers = () => [{ text: '네.', frames: [tone(20, 0.5)] }];
    const agentSaid = (s: { record: PhoneCallRecord }, text: string) =>
      s.record.transcript.filter((l) => l.role === 'agent' && l.text === text).length;

    it('a half-second pause inside a sentence is not the end of it: no "네.", no answer, one turn for the model', async () => {
      const s = await answering(['내일 회의가', '몇 시인지 알려 주세요'], { fillers: fillers(), turnHoldMs: 500 });
      const sent = s.dialog().sent.length;
      live(s, tone(800, 0.3));
      live(s, quiet(700)); // a pause: 0.5 s ends the utterance (it is recognised), the turn may go on
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(0);
      expect(s.dialog().sent.length).toBe(sent);
      live(s, tone(800, 0.3)); // … and it does
      live(s, quiet(1200));
      await settleAll();
      expect(s.dialog().sent.slice(sent)).toEqual(['내일 회의가 몇 시인지 알려 주세요']);
      expect(agentSaid(s, '네.')).toBe(1);
    });

    it('after a second of quiet the turn is over: then "네." and the words go to the model', async () => {
      const s = await answering(['내일 회의 몇 시예요?'], { fillers: fillers(), turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(800));
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(0); // 0.8 s of quiet: not yet
      live(s, quiet(400));
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(1);
      expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('내일 회의 몇 시예요?');
    });

    it('words still being recognised when the quiet is long enough go on as soon as they are in', async () => {
      let heard: () => void = () => undefined;
      let gate: Promise<void> | null = new Promise<void>((r) => {
        heard = r;
      });
      const s = await answering(['내일 회의 몇 시예요?'], {
        fillers: fillers(),
        turnHoldMs: 500,
        sttGate: () => gate ?? Promise.resolve(),
      });
      live(s, tone(800, 0.3));
      live(s, quiet(1500));
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(0);
      gate = null;
      heard();
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(1);
      expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('내일 회의 몇 시예요?');
    });

    it('a caller who says only "네" or "음" gets no "네." back; the words still reach the model', async () => {
      const s = await answering(['음.'], { fillers: fillers(), turnHoldMs: 500 });
      live(s, tone(500, 0.3));
      live(s, quiet(1200));
      await settleAll();
      expect(agentSaid(s, '네.')).toBe(0);
      expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('음.');
    });

    it('a cough in the pause does not end the turn early or lose its first half', async () => {
      const s = await answering(['내일 회의가', '몇 시인지 알려 주세요'], { fillers: fillers(), turnHoldMs: 500 });
      const sent = s.dialog().sent.length;
      live(s, tone(800, 0.3));
      live(s, quiet(560));
      live(s, tone(100, 0.3)); // a click: noise, not speech
      live(s, quiet(560));
      await settleAll();
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      expect(s.dialog().sent.slice(sent)).toEqual(['내일 회의가 몇 시인지 알려 주세요']);
    });

    it('a cough in the pause, then quiet: the turn still ends, with what was said', async () => {
      const s = await answering(['내일 회의 몇 시예요?'], { fillers: fillers(), turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(560));
      live(s, tone(100, 0.3)); // a click in the pause
      live(s, quiet(1200));
      await settleAll();
      expect(s.dialog().sent[s.dialog().sent.length - 1]).toBe('내일 회의 몇 시예요?');
      expect(agentSaid(s, '네.')).toBe(1);
    });

    it('a "네" that waited for a reply goes with the next turn when that turn is still open as the reply ends', async () => {
      const s = await answering(['내일 회의 시간이요', '네', '그리고 장소도요'], { turnHoldMs: 500, speakMs: 1000 });
      live(s, tone(800, 0.3));
      live(s, quiet(1200)); // turn over: the words go to the model
      await settleAll();
      const n = s.dialog().sent.length;
      s.dialog().emit({ type: 'text_delta', text: '내일 회의는 세 시예요. ' }); // still writing; this plays
      await settleAll();
      live(s, tone(300, 0.6)); // "네" over it: waits for the reply
      live(s, quiet(600));
      await settleAll();
      live(s, quiet(2500)); // the sentence has played
      live(s, tone(800, 0.3));
      live(s, quiet(560)); // more words; their turn is still open …
      await settleAll();
      s.dialog().emit({ type: 'turn_end', isError: false }); // … when the reply ends
      await settleAll();
      live(s, quiet(600));
      await settleAll();
      expect(s.dialog().sent.slice(n)).toEqual(['네 그리고 장소도요']);
    });

    // The owner again, the same day: "사람이 말하고 있을때 끼어들면 안됨". A reply ready while the caller talks
    // waits for the end of their turn — and is dropped if what they said is new.
    it('a reply ready while the caller is talking again does not start; their new words drop it', async () => {
      const s = await answering(['내일 회의 시간이요', '아 그리고 장소도요'], { turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(1200)); // turn over: the words go to the model
      await settleAll();
      live(s, tone(400, 0.3)); // they go on talking …
      const before = s.call.frames;
      s.dialog().reply('내일 회의는 세 시예요.'); // … while the answer is ready
      await settleAll();
      live(s, tone(400, 0.3));
      expect(s.call.frames).toBe(before); // not a sound over them
      live(s, quiet(1200));
      await settleAll();
      s.clock.advance(2000);
      expect(s.call.frames).toBe(before); // the old answer is never said
      const last = s.dialog().sent[s.dialog().sent.length - 1];
      expect(last).toContain('"내일 회의는 세 시예요."');
      expect(last.endsWith('\n아 그리고 장소도요')).toBe(true);
    });

    it('a reply held back by a click on the line plays once the line is quiet again', async () => {
      const s = await answering(['내일 회의 시간이요'], { turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      const n = s.dialog().sent.length;
      live(s, tone(100, 0.3)); // a click: it might be speech …
      const before = s.call.frames;
      s.dialog().reply('내일 회의는 세 시예요.');
      await settleAll();
      expect(s.call.frames).toBe(before); // … so the answer waits
      live(s, quiet(700)); // it was noise
      await settleAll();
      s.clock.advance(2000);
      expect(s.call.frames - before).toBeGreaterThanOrEqual(40); // the whole answer
      expect(s.dialog().sent.length).toBe(n);
    });

    it('a sound the recogniser makes nothing of releases a held reply too', async () => {
      const s = await answering(['내일 회의 시간이요', ''], { turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      live(s, tone(400, 0.3)); // a sound long enough to be recognised …
      const before = s.call.frames;
      s.dialog().reply('내일 회의는 세 시예요.');
      await settleAll();
      expect(s.call.frames).toBe(before);
      live(s, quiet(1200)); // … into nothing
      await settleAll();
      s.clock.advance(2000);
      expect(s.call.frames - before).toBeGreaterThanOrEqual(40);
    });

    it('two parts recognised out of order still reach the model in the order they were said', async () => {
      let first: () => void = () => undefined;
      const slow = new Promise<void>((r) => {
        first = r;
      });
      let calls = 0;
      const s = await answering(['내일 회의가', '몇 시인지 알려 주세요'], {
        turnHoldMs: 500,
        sttGate: () => (calls++ === 0 ? slow : Promise.resolve()), // the first part takes longer to recognise
      });
      const n = s.dialog().sent.length;
      live(s, tone(800, 0.3));
      live(s, quiet(600));
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      expect(s.dialog().sent.length).toBe(n); // the first part is not in yet
      first();
      await settleAll();
      expect(s.dialog().sent.slice(n)).toEqual(['내일 회의가 몇 시인지 알려 주세요']);
    });

    it('words said while the goodbye is due do not keep it from playing, nor the phone from going down', async () => {
      const s = await answering(['내일 회의 시간이요', '잠깐만요'], { turnHoldMs: 500 });
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      const before = s.call.frames;
      s.dialog().emit({ type: 'text_delta', text: '네, 세 시예요. 좋은 하루 보내세요!' });
      await s.dialog().tool('hang_up').handler({ reason: 'done' });
      s.dialog().emit({ type: 'tool_use', name: 'mcp__phone__hang_up', input: { reason: 'done' } });
      s.dialog().emit({ type: 'turn_end', isError: false });
      live(s, tone(400, 0.3)); // the caller says something as it starts
      await settleAll();
      live(s, quiet(1200));
      await settleAll();
      s.clock.advance(10_000);
      await settleAll();
      expect(s.call.frames - before).toBeGreaterThanOrEqual(80); // the whole goodbye
      expect(s.call.hungUp).toBe(1);
    });

    it('a recogniser that fails releases a held reply', async () => {
      let fail = false;
      const s = await answering(['내일 회의 시간이요', '?'], {
        turnHoldMs: 500,
        sttGate: () => (fail ? Promise.reject(new Error('stt down')) : Promise.resolve()),
      });
      live(s, tone(800, 0.3));
      live(s, quiet(1200));
      await settleAll();
      fail = true;
      live(s, tone(400, 0.3));
      const before = s.call.frames;
      s.dialog().reply('내일 회의는 세 시예요.');
      await settleAll();
      live(s, quiet(1200));
      await settleAll();
      s.clock.advance(2000);
      expect(s.call.frames - before).toBeGreaterThanOrEqual(40);
    });

    it('with no hold, a turn whose words are in still ends when a click follows them', async () => {
      const s = await answering(['내일 회의 몇 시예요?'], { turnHoldMs: 0 });
      const n = s.dialog().sent.length;
      s.run.feedAudio(tone(600, 0.3));
      s.run.feedAudio(quiet(800)); // the utterance: being recognised …
      s.run.feedAudio(tone(100, 0.3)); // … when a click starts
      await settleAll(); // recognised while the click goes on
      s.run.feedAudio(quiet(800)); // the click ends as noise
      await settleAll();
      expect(s.dialog().sent.slice(n)).toEqual(['내일 회의 몇 시예요?']);
    });

    it('while the words of a turn are still being recognised, the quiet line is not nudged', async () => {
      const s = await answering(['내일 회의 몇 시예요?'], {
        fillers: fillers(),
        turnHoldMs: 500,
        sttGate: () => new Promise<void>(() => undefined), // the recogniser hangs
      });
      live(s, tone(800, 0.3));
      live(s, quiet(560));
      live(s, tone(100, 0.3)); // a click: the quiet-line timer would start here
      live(s, quiet(600));
      s.clock.advance(20_000);
      await settleAll();
      expect(s.dialog().sent).not.toContain(SILENCE_CUE);
    });
  });

  it('the rest of a reply goes in pieces of at most 400 characters', async () => {
    const s = await answering(['일정 알려 주세요']);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const n = s.spoken.length;
    const sentence = (word: string) => `${`${word} 일정을 차례대로 정리해 드릴게요 `.repeat(7).trim()}.`; // ~150 characters
    const [a, b, c, d] = ['월요일', '화요일', '수요일', '목요일'].map(sentence);
    s.dialog().reply(`${a} ${b} ${c} ${d}`);
    await settleAll();
    expect(s.spoken.slice(n)).toEqual([a, `${b} ${c}`, d]);
  });

  it('after the first piece of a reply, the rest is synthesized as one piece (no gap between sentences)', async () => {
    const s = await answering(['일정 알려 주세요']);
    s.run.feedAudio(tone(600, 0.3));
    s.run.feedAudio(quiet(800));
    await settleAll();
    const n = s.spoken.length;
    s.dialog().reply('오늘은 회의가 두 개예요. 오후 두 시에 하나, 네 시에 하나. 저녁엔 리뷰가 있어요.');
    await settleAll();
    expect(s.spoken.slice(n)).toEqual([
      '오늘은 회의가 두 개예요.',
      '오후 두 시에 하나, 네 시에 하나. 저녁엔 리뷰가 있어요.',
    ]);
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
