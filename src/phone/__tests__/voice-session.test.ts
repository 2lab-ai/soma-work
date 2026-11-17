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
import { OPENING_CUE } from '../phone-prompt';
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

function setup(plan: Partial<CallRunPlan> = {}, stt: string[] = []) {
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
  const voice: VoiceClient = {
    async transcribe() {
      return { text: stt.shift() ?? '', ms: 5 };
    },
    async speak(text) {
      spoken.push(text);
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
  return { run, clock, record, spoken, dialog: () => dialog as FakeDialog };
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

  it('puts down a call nothing was prepared for', async () => {
    const session = new PhoneVoiceSession(async () => null);
    const call = fakeCall();
    await session.start(call as unknown as CallSessionLike);
    expect(call.hungUp).toBe(1);
  });
});
