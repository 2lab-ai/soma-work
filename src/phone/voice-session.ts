/**
 * The phone call's voice: listen → transcribe → think → speak, for one call at a time
 * (.prd/31-phone-calls-architecture.md §3).
 *
 * The SDK gives every call the same session object, so {@link PhoneVoiceSession} is a thin switch that routes the
 * line's audio to the {@link CallRun} of the call in progress. A `CallRun` owns one call's state: the voice
 * activity detector, the dialog (`query()` through llmux), the queue of sentences to speak, and the call record.
 */

import type { VoiceDialog, VoiceDialogTool } from '../agent-runtime/voice-dialog';
import { EnergyVad, LINE_SAMPLE_RATE, pcm16ToWav, StreamResampler } from './audio';
import type { PhoneCallRecord, PhoneWorkEvent } from './call-store';
import type { CallSessionLike, SessionLike } from './koreaaitel';
import { LineOut } from './line-out';
import {
  dtmfCue,
  HANG_UP_TOOL,
  INBOUND_CUE,
  isBareGreeting,
  OPENING_CUE,
  SEND_DTMF_TOOL,
  SILENCE_CUE,
  TIME_UP_CUE,
} from './phone-prompt';
import { hasSpeech, SentenceSplitter, stripAcknowledgment, toSpeakable } from './speech-text';
import type { VoiceClient } from './voice-client';

const FRAME_BYTES = 160; // 20 ms of μ-law at 8 kHz
const FRAME_MS = 20;
/** After the other side picks up and says nothing for this long, the agent opens. */
const OPEN_AFTER_SILENCE_MS = 1200;
/** Quiet line after the agent finished speaking → one nudge to the dialog; twice as long → hang up. */
const SILENCE_NUDGE_MS = 15_000;
/** After `hang_up`, the line is held this long past the estimated end of playback, so the goodbye is heard. */
const HANGUP_TAIL_MS = 600;
/** After the time-up cue the agent gets this long to say goodbye before the line is cut. */
const TIME_UP_GRACE_MS = 25_000;
/**
 * Talking over the agent interrupts it only after this much speech. Shorter sounds over it — "네", "아, 예", a
 * hello, a cough — are not an interruption (a real call cut the agent six times for them).
 */
const BARGE_IN_MS = 600;
/** A real interruption: the agent's voice falls silent over this long (it ends its word), it is not cut dead. */
const FADE_OUT_MS = 300;
/**
 * The end of an utterance (0.5 s of quiet) is when its words are sent to be recognised; the turn is over only once
 * the line has stayed quiet this much longer. A person pauses inside a sentence: a real call answered the first half
 * of one, and said "네." over the second ("내가 말하던 중에 니가 치고 들어온다"). Recognising takes about as long
 * (0.45 s median), so the wait costs little: the words are ready when the turn ends.
 */
const TURN_HOLD_MS = 500;
/** Fewer letters than this ("네", "음", "아우, 네") are a backchannel, not something to say "네." to. */
const ACK_MIN_LETTERS = 4;
/** At most this much text goes into one synthesis (the rest of a reply is spoken as one piece, without gaps). */
const MAX_PIECE_CHARS = 400;
/**
 * How long the voice takes per character, in 20 ms frames, until a piece of this call has shown it (about 120 ms a
 * character at the 1.5x the lines use). Used to judge how much of a piece still being made was heard.
 */
const FRAMES_PER_CHAR = 6;
/** Pieces shorter than this say little about the voice's pace (punctuation, a pause at the end). */
const PACE_MIN_CHARS = 8;
/** At most this share of a piece still being made counts as heard: its end is not made yet. */
const UNFINISHED_MAX_SHARE = 0.9;

/**
 * The speech engine is woken at most this often. It slows down after a few idle seconds (VoiceClient.warm), so the
 * wake-up goes out once the other side's words are transcribed — ~1 s before the reply's first sentence arrives.
 */
const WARM_EVERY_MS = 3_000;

export interface CallRunDeps {
  ulawToPcm16(ulaw: Buffer): Buffer;
  pcm16ToUlaw(pcm: Buffer): Buffer;
  voice: VoiceClient;
  /** Opens the call's dialog with the tools the run supplies (auth and model are the caller's). */
  openDialog(tools: VoiceDialogTool[]): VoiceDialog;
  /** Mutate the call record (persisted and pushed by the store). */
  update(mutate: (record: PhoneCallRecord) => void): void;
  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
  now?: () => number;
  /** Timers (tests drive them). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface CallRunPlan {
  callId: string;
  direction: 'outbound' | 'inbound';
  maxMinutes: number;
  /** Inbound: the greeting already synthesized (μ-law frames) and its words. */
  greeting?: { text: string; frames: Buffer[] };
  /**
   * Short acknowledgments already synthesized ("네."): one is said when the other side's turn is over, while the
   * reply is still being made — the answer itself takes a few seconds.
   */
  fillers?: Array<{ text: string; frames: Buffer[] }>;
  /**
   * How much longer than the end of an utterance (0.5 s of quiet) the line must stay quiet before the other side's
   * turn is over. Default {@link TURN_HOLD_MS}.
   */
  turnHoldMs?: number;
  model?: string;
}

/** A piece of the agent's speech: its words, and its transcript line once it starts to sound. */
interface SpokenPart {
  text: string;
  /** An acknowledgment said while the reply is made ("네."). */
  filler?: boolean;
  /** All of its audio is made (its length is known). */
  done?: boolean;
  line?: { text: string; at: number; role: 'agent'; interrupted?: boolean };
}

/** Where an utterance's words go in the turn they belong to. */
interface TurnSlot {
  turn: { words: string[]; pending: number; over: boolean };
  index: number;
}

interface Buffered {
  part: SpokenPart;
  frames: Buffer[];
}

export class CallRun {
  readonly callId: string;
  private readonly deps: CallRunDeps;
  private readonly plan: CallRunPlan;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private call: CallSessionLike | null = null;
  private readonly vad = new EnergyVad();
  private dialog: VoiceDialog | null = null;
  private readonly splitter = new SentenceSplitter();

  private queue: string[] = [];
  private speaking = false;
  /** The agent's voice to the line, paced (see line-out.ts); made when the call is answered. */
  private out: LineOut | null = null;
  /** The piece of speech sounding now. */
  private sounding: SpokenPart | null = null;
  /** The piece being synthesized now (it may have sent nothing yet). */
  private making: SpokenPart | null = null;
  /** Said when the agent was cut: what the other side heard of it and what it did not get to say. */
  private cutNote: string | null = null;
  private fillerIndex = 0;
  /** The line refused audio once (reported); later refusals are not reported again. */
  private lineFailed = false;
  /** The voice's pace on this call, learnt from the pieces made so far. */
  private framesPerChar = FRAMES_PER_CHAR;
  /** An acknowledgment was just said: the reply should not open with another. */
  private acknowledged = false;
  /**
   * The other side's turn while it may still go on: the words recognised so far, the recognitions still running, and
   * whether the line has been quiet long enough since its last utterance.
   */
  private turn: { words: string[]; pending: number; over: boolean } | null = null;
  private turnTimer: unknown = null;
  private synthAbort: AbortController | null = null;

  /** Outbound: the opening is held until the other side has picked up and said hello (or stayed quiet). */
  private released: boolean;
  private held: Buffered[] = [];
  private peerUtterances = 0;
  private heldPeer: string[] = [];
  private answered = false;

  private generating = false;
  private dropTurn = false;
  /** Words that wait for the reply being written to end (dropped or not): sent together once it has. */
  private pendingPeer: string[] = [];
  /** Speech began over the agent: it interrupts once it has said {@link BARGE_IN_MS} worth (pauses not counted). */
  private bargeArmed = false;
  /** The agent was talking when the current utterance began. */
  private startedOverAgent = false;
  /** Transcriptions under way: words waiting for a reply go with theirs. */
  private sttInFlight = 0;
  private turnText = '';
  private turnStartAt = 0;
  private firstTokenAt = 0;
  private turnModel: string | undefined;

  private hangupRequested = false;
  private ended = false;
  private readonly timers = new Set<unknown>();
  private silenceTimer: unknown = null;
  private silenceNudged = false;
  private lastWarmAt = Number.NEGATIVE_INFINITY;
  /** Cancels a warm-up still running when the call ends. */
  private readonly warmAbort = new AbortController();

  constructor(plan: CallRunPlan, deps: CallRunDeps) {
    this.callId = plan.callId;
    this.plan = plan;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.released = plan.direction === 'inbound';
  }

  /** Open the dialog. Outbound: ask for the opening line now, while the phone rings. */
  begin(): void {
    this.dialog = this.deps.openDialog(this.tools());
    void this.pump(this.dialog);
    if (this.plan.direction === 'outbound') this.sendToDialog(OPENING_CUE);
  }

  /** The other side answered: the call's media is up. */
  attach(call: CallSessionLike): void {
    if (this.ended || this.call) return;
    this.call = call;
    this.answered = true;
    this.out = new LineOut({
      // Frames go out from timers now, outside any caller's try: a line that fails is reported here, once.
      send: (f) => this.toLine(() => this.call?.sendAudio(f)),
      clear: () => this.toLine(() => this.call?.clearAudio()),
      decode: (f) => this.deps.ulawToPcm16(f),
      encode: (p) => this.deps.pcm16ToUlaw(p),
      now: this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      onStart: (tag) => this.started(tag as SpokenPart),
    });
    const at = this.now();
    this.deps.update((r) => {
      r.status = 'active';
      r.answeredAt = at;
    });
    this.work({ kind: 'event', at, text: '상대가 전화를 받음' });
    if (this.plan.direction === 'inbound') {
      if (this.plan.greeting) {
        const part: SpokenPart = { text: this.plan.greeting.text, done: true };
        for (const f of this.plan.greeting.frames) this.sendFrame(f, part);
        this.armSilenceIfIdle();
      } else {
        this.sendToDialog(INBOUND_CUE);
      }
    }
    if (this.plan.direction === 'outbound') {
      this.later(() => {
        if (!this.released && !this.vad.speaking) this.release('상대가 조용해서 첫 마디 시작');
      }, OPEN_AFTER_SILENCE_MS);
    }
    this.later(() => this.timeUp(), this.plan.maxMinutes * 60_000);
  }

  feedAudio(ulaw: Buffer): void {
    if (this.ended || !this.answered) return;
    const pcm = this.deps.ulawToPcm16(ulaw);
    for (const ev of this.vad.push(pcm, this.agentSpeaking())) {
      if (ev.type === 'speech_start') {
        // The other side is talking: no silence timer, and the next quiet spell starts with a fresh nudge.
        this.clearSilence();
        this.silenceNudged = false;
        this.holdTurn(); // they go on: their turn is not over
        // Nobody starts talking over someone: nothing new goes out until their turn is over (what sounds goes on).
        this.out?.hold();
        this.startedOverAgent = this.released && this.agentSpeaking();
        this.bargeArmed = this.startedOverAgent;
        // Someone talks over the agent: it lowers its voice at once and goes on — a "네" brings it back, a real
        // interruption makes it fall silent (bargeIn).
        if (this.startedOverAgent) this.out?.duck();
      } else if (ev.type === 'utterance') {
        // All of it may have come in one packet: judge it as a whole before letting go of the arm.
        if (this.bargeArmed && ev.speechMs >= BARGE_IN_MS) this.interrupt();
        this.bargeArmed = false;
        const first = this.peerUtterances++ === 0;
        const releasedOpening = !this.released;
        if (releasedOpening) this.release('상대의 첫 말이 끝남');
        // A backchannel (short, begun over the agent) and the hello that released the opening leave what is being
        // said alone.
        const keepReply = releasedOpening || (this.startedOverAgent && ev.speechMs < BARGE_IN_MS);
        if (this.startedOverAgent) this.out?.restore(); // it was not an interruption (that would have faded it out)
        if (keepReply) this.out?.release(); // a "네" or the hello that released the opening: the agent goes on
        void this.transcribe(ev.pcm, ev.totalMs, first, keepReply, keepReply ? undefined : this.openTurn());
      } else if (ev.type === 'noise') {
        this.bargeArmed = false;
        if (this.startedOverAgent) this.out?.restore();
        if (this.turn)
          this.armTurnEnd(this.turn); // a cough in a pause: the turn still ends after quiet
        else this.out?.release(); // a click, not a turn: what waited may start
        if (!this.released) this.release('상대가 조용해서 첫 마디 시작');
        else if (!this.flushPending()) this.armSilenceIfIdle(); // its start cleared the quiet-line timer
      }
    }
    // Speech over the agent interrupts it once it has said enough to be meant — loud time only: the quiet the
    // recogniser waits through at the end of a short "네" does not make it longer.
    if (this.bargeArmed && this.vad.speechMsSoFar >= BARGE_IN_MS) this.interrupt();
  }

  /**
   * The other side has said enough over the agent to mean it. What plays stops; a reply still being written is
   * dropped even when nothing of it plays right now (between two of its sentences).
   */
  private interrupt(): void {
    this.bargeArmed = false;
    if (this.agentSpeaking()) this.bargeIn();
    else if (this.generating && !this.hangupRequested) this.dropReply();
  }

  /**
   * Words that waited for a reply to end go to the model — unless the other side is still talking or being
   * recognised: then they go together with those words (hear). Returns whether they were sent.
   */
  private flushPending(): boolean {
    if (!this.pendingPeer.length || this.generating || this.hangupRequested || this.ended) return false;
    if (this.turn) return false; // they go with the words of the turn still open (endTurn → hear)
    if (this.vad.speaking || this.sttInFlight > 0) return false;
    const words = this.pendingPeer.join(' ');
    this.pendingPeer = [];
    this.sendToDialog(words);
    return true;
  }

  feedDtmf(digits: string): void {
    this.sendToDialog(dtmfCue(digits));
  }

  /** The call is over (any reason): stop speaking, close the dialog, drop timers. */
  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.synthAbort?.abort('call-ended');
    this.warmAbort.abort('call-ended');
    this.queue = [];
    this.out?.stop();
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    this.vad.reset();
    this.dialog?.close();
  }

  // ── speaking ────────────────────────────────────────────────

  private agentSpeaking(): boolean {
    return this.speaking || this.queue.length > 0 || (this.out?.busy ?? false);
  }

  /** When everything the agent has said so far will have been heard. */
  private playEnd(): number {
    return this.out?.playEndAt ?? this.now();
  }

  /** Only an acknowledgment is sounding (nothing of a reply yet): newer words do not need to cut it. */
  private onlyAcknowledging(): boolean {
    return !!this.sounding?.filler && !this.speaking && this.queue.length === 0 && !this.out?.unstarted().length;
  }

  /**
   * The other side has stopped talking: say a short acknowledgment now, while the reply is made (end of speech →
   * first word of the answer takes a few seconds: recognising, the model's first words, synthesis).
   */
  private acknowledge(): void {
    const fillers = this.plan.fillers;
    if (!fillers?.length || !this.out || !this.released || this.hangupRequested || this.ended) return;
    if (this.agentSpeaking()) return;
    const f = fillers[this.fillerIndex++ % fillers.length];
    const part: SpokenPart = { text: f.text, filler: true, done: true };
    for (const frame of f.frames) this.sendFrame(frame, part);
    this.acknowledged = true;
  }

  private enqueue(sentence: string): void {
    if (this.ended || this.hangupRequestedAndDropping()) return;
    let spoken = toSpeakable(sentence);
    if (this.acknowledged) {
      // "네." was just said: a reply that opens with its own "네," would say it twice.
      this.acknowledged = false;
      spoken = stripAcknowledgment(spoken);
    }
    if (!hasSpeech(spoken)) return;
    this.queue.push(spoken);
    void this.speakQueue();
  }

  private hangupRequestedAndDropping(): boolean {
    return this.hangupRequested && this.dropAfterHangup;
  }

  /** Text the model writes after it called `hang_up` is not spoken. */
  private dropAfterHangup = false;

  private async speakQueue(): Promise<void> {
    if (this.speaking) return;
    this.speaking = true;
    try {
      while (this.queue.length && !this.ended) {
        // Everything written by now goes as one piece: the engine re-reads the voice before every request, so
        // sentence by sentence leaves a gap between them (measured: 0.45 s median on real calls).
        let text = this.queue.shift() as string;
        while (this.queue.length && text.length + this.queue[0].length < MAX_PIECE_CHARS) {
          text = `${text} ${this.queue.shift()}`;
        }
        await this.speakOne(text);
      }
    } finally {
      this.speaking = false;
    }
    if (!this.ended) {
      if (this.hangupRequested) this.finishWhenQuiet();
      else this.armSilence();
    }
  }

  private async speakOne(text: string): Promise<void> {
    const abort = new AbortController();
    this.synthAbort = abort;
    const started = this.now();
    let firstByteMs = -1;
    /** The engine streamed all of it (no error, not stopped). */
    let complete = false;
    let frames = 0;
    const resampler = new StreamResampler(44100, LINE_SAMPLE_RATE);
    let carry = Buffer.alloc(0);
    const part: SpokenPart = { text };
    this.making = part;
    const buffered: Buffered | null = this.released ? null : { part, frames: [] };
    try {
      const stream = await this.deps.voice.speak(text, abort.signal);
      const rs = stream.sampleRate === 44100 ? resampler : new StreamResampler(stream.sampleRate, LINE_SAMPLE_RATE);
      for await (const chunk of stream.chunks) {
        if (abort.signal.aborted || this.ended) break;
        if (firstByteMs < 0) firstByteMs = this.now() - started;
        const ulaw = this.deps.pcm16ToUlaw(rs.push(chunk));
        let data = carry.length ? Buffer.concat([carry, ulaw]) : ulaw;
        while (data.length >= FRAME_BYTES) {
          const frame = Buffer.from(data.subarray(0, FRAME_BYTES));
          data = data.subarray(FRAME_BYTES);
          frames++;
          if (buffered) buffered.frames.push(frame);
          else this.sendFrame(frame, part);
        }
        carry = Buffer.from(data);
      }
      if (carry.length && !abort.signal.aborted) {
        const frame = Buffer.concat([carry, Buffer.alloc(FRAME_BYTES - carry.length, 0xff)]);
        frames++;
        if (buffered) buffered.frames.push(frame);
        else this.sendFrame(frame, part);
      }
      complete = !abort.signal.aborted && !this.ended;
    } catch (err) {
      if (!abort.signal.aborted) this.fail('tts', err);
    } finally {
      if (this.synthAbort === abort) this.synthAbort = null;
      if (this.making === part) this.making = null;
    }
    if (complete && frames > 0) {
      part.done = true;
      if (text.length >= PACE_MIN_CHARS) this.framesPerChar = frames / text.length;
    }
    if (buffered && !this.released) this.held.push(buffered);
    else if (buffered && this.released && !abort.signal.aborted && !this.ended) {
      // Released while this sentence was being made: it goes out whole, after the ones released before it.
      for (const f of buffered.frames) this.sendFrame(f, buffered.part);
    }
    this.work({ kind: 'tts', at: started, text, firstByteMs: Math.max(0, firstByteMs), audioMs: frames * FRAME_MS });
  }

  private sendFrame(frame: Buffer, part: SpokenPart): void {
    if (!this.out || this.ended) return;
    this.out.push(frame, part);
  }

  private toLine(send: () => void): void {
    try {
      send();
    } catch (err) {
      if (this.lineFailed) return;
      this.lineFailed = true;
      this.fail('line', err);
    }
  }

  /** A piece starts to sound: from now on it is in the transcript (a piece never heard is not). */
  private started(part: SpokenPart): void {
    this.sounding = part;
    part.line = this.addAgentLine(part.text);
  }

  private addAgentLine(text: string): { text: string; at: number; role: 'agent'; interrupted?: boolean } {
    const line = { role: 'agent' as const, text, at: this.now() };
    this.deps.update((r) => {
      r.transcript.push(line);
    });
    this.call?._emit?.('transcript', 'assistant', text);
    return line;
  }

  /** Outbound opening: send what was made while ringing. */
  private release(why: string): void {
    if (this.released || this.ended) return;
    this.released = true;
    this.work({ kind: 'event', at: this.now(), text: why });
    for (const b of this.held) {
      for (const f of b.frames) this.sendFrame(f, b.part);
    }
    this.held = [];
    const peer = this.heldPeer.filter((t) => !isBareGreeting(t));
    this.heldPeer = [];
    if (peer.length) this.sendToDialog(peer.join(' '));
    else this.armSilenceIfIdle();
  }

  private bargeIn(): void {
    this.cutSpeech('상대가 끼어듦 — 말하기 멈춤');
    if (this.generating && !this.hangupRequested) this.dropReply();
  }

  /**
   * Stop speaking — not dead: the voice falls silent over {@link FADE_OUT_MS} (it ends its word), and what was not
   * yet said is dropped. The cut line is marked in the transcript, and the model is told with the next words what
   * the other side heard and what it did not get to say (like truncating a reply to what was played).
   */
  private cutSpeech(why: string): void {
    this.synthAbort?.abort('barge-in');
    const unsaid: string[] = [];
    let heard = '';
    const part = this.sounding;
    this.sounding = null;
    if (part && this.out) {
      // A piece still being made is judged by the length it would have had, not by what is made of it so far.
      const expected = part.done ? 0 : Math.ceil(part.text.length * this.framesPerChar);
      // Still being made, yet all of it heard by that measure: the voice ran slower than this call's pace — its end
      // is not made, so it was not all said.
      const share = Math.min(this.out.sentFraction(part, expected), part.done ? 1 : UNFINISHED_MAX_SHARE);
      if (share < 1) {
        const at = Math.round(part.text.length * share);
        heard = part.text.slice(0, at).trim();
        unsaid.push(part.text.slice(at).trim());
        this.markInterrupted(part);
      }
    }
    const waiting = (this.out?.unstarted() ?? []) as SpokenPart[];
    for (const p of waiting) if (!p.filler) unsaid.push(p.text);
    // Being made and nothing of it sent yet: not heard either.
    if (this.making && this.making !== part && !waiting.includes(this.making)) unsaid.push(this.making.text);
    this.making = null; // aborted: whatever it still returns is never said
    unsaid.push(...this.queue);
    this.queue = [];
    this.out?.fadeOut(FADE_OUT_MS);
    const rest = unsaid.filter(Boolean).join(' ').slice(0, 300);
    if (rest) {
      this.cutNote = heard
        ? `[시스템: 상대가 끼어들어 네 말이 "${heard}"에서 끊겼다. 못 한 말: "${rest}". 상대 말에 먼저 답하고, 못 한 말이 아직 필요하면 짧게 이어서 말하라.]`
        : `[시스템: 상대가 끼어들어 네 말 "${rest}"은 들리지 않았다. 상대 말에 먼저 답하고, 그 말이 아직 필요하면 짧게 말하라.]`;
    }
    this.work({ kind: 'event', at: this.now(), text: why });
  }

  private markInterrupted(part: SpokenPart): void {
    const line = part.line;
    if (!line || line.interrupted) return;
    this.deps.update((r) => {
      const hit = r.transcript.find((l) => l.at === line.at && l.role === 'agent' && l.text === line.text);
      if (hit) hit.interrupted = true;
    });
    line.interrupted = true;
  }

  /** The reply being written answers words that are out of date: nothing more of it is said. */
  private dropReply(): void {
    if (this.dropTurn) return;
    this.dropTurn = true;
    void this.dialog?.interrupt();
  }

  /**
   * The other side's words, for the model. Newer words supersede a reply to older ones — a caller who pauses in the
   * middle of a thought gets one answer to all of it, not one per pause:
   * - a reply still being written is dropped (interrupted), and the words go to the model once that turn has
   *   ended, so they are answered together with what came before;
   * - a reply already playing is cut.
   * Not every sound over the agent is a new thought: a backchannel ("네", "아, 예" — short, begun while the agent
   * talked) and the hello whose end released the opening leave what is being said alone; they reach the model
   * after the current reply.
   */
  private hear(text: string, keepReply = false): void {
    if (!this.generating && this.pendingPeer.length) {
      // Words that waited for the last reply go with these.
      text = [...this.pendingPeer, text].join(' ');
      this.pendingPeer = [];
    }
    if (keepReply) {
      // Not a correction or a new thought: what is being said goes on, and the words reach the model after it.
      if (this.generating) this.pendingPeer.push(text);
      else this.sendToDialog(text);
      return;
    }
    if (this.generating) {
      this.pendingPeer.push(text);
      if (!this.dropTurn) {
        if (this.agentSpeaking() && !this.onlyAcknowledging()) this.cutSpeech('상대가 말을 이어감 — 말하기 멈춤');
        else this.work({ kind: 'event', at: this.now(), text: '상대가 말을 이어감 — 쓰던 답을 버림' });
        this.dropReply();
      }
      return;
    }
    if (this.agentSpeaking() && !this.onlyAcknowledging()) this.cutSpeech('상대가 말을 이어감 — 말하기 멈춤');
    this.sendToDialog(text);
  }

  private warmEngine(): void {
    if (!this.deps.voice.warm || this.speaking) return; // synthesizing: the engine is awake
    const now = this.now();
    if (now - this.lastWarmAt < WARM_EVERY_MS) return;
    this.lastWarmAt = now;
    // Not awaited: the transcript goes to the dialog now, the wake-up runs beside it.
    void Promise.resolve(this.deps.voice.warm(this.warmAbort.signal)).catch(() => undefined);
  }

  // ── hearing ─────────────────────────────────────────────────

  /** An utterance of the other side's turn has ended: the turn is open (or goes on) until the line stays quiet. */
  /**
   * An utterance of the other side's turn has ended: the turn is open (or goes on) until the line stays quiet. Its
   * words get their place in the turn now — recognitions may answer out of order.
   */
  private openTurn(): TurnSlot {
    const turn = this.turn ?? { words: [], pending: 0, over: false };
    this.turn = turn;
    turn.pending++;
    const index = turn.words.push('') - 1;
    this.armTurnEnd(turn);
    return { turn, index };
  }

  private armTurnEnd(turn: NonNullable<CallRun['turn']>): void {
    this.holdTurn();
    const hold = this.plan.turnHoldMs ?? TURN_HOLD_MS;
    if (hold <= 0) {
      turn.over = true;
      this.endTurn(); // its words may all be in already (a click after them)
      return;
    }
    this.turnTimer = this.later(() => {
      this.turnTimer = null;
      turn.over = true;
      this.endTurn();
    }, hold);
  }

  /** The other side is talking again: the turn is not over yet. */
  private holdTurn(): void {
    if (this.turnTimer !== null) this.clearTimer(this.turnTimer);
    this.timers.delete(this.turnTimer);
    this.turnTimer = null;
    if (this.turn) this.turn.over = false;
  }

  /**
   * The turn is over once the line stayed quiet and all its words are in: the words go to the model — a reply made
   * meanwhile and held back is dropped by them (hear) — then the line is the agent's again, and "네.".
   */
  private endTurn(): void {
    const turn = this.turn;
    if (!turn?.over || turn.pending > 0) return;
    this.turn = null;
    const text = turn.words.filter(Boolean).join(' ');
    if (this.ended || this.hangupRequested || !text) {
      this.out?.release();
      if (!text && !this.ended && !this.hangupRequested && !this.flushPending()) this.armSilenceIfIdle();
      return;
    }
    this.hear(text);
    this.out?.release();
    if (text.replace(/[\s\p{P}\p{S}]/gu, '').length >= ACK_MIN_LETTERS) this.acknowledge();
  }

  private async transcribe(
    pcm: Buffer,
    audioMs: number,
    first = false,
    keepReply = false,
    slot?: TurnSlot,
  ): Promise<void> {
    const at = this.now();
    let text = '';
    let ms = 0;
    this.sttInFlight++;
    try {
      const t = await this.deps.voice.transcribe(pcm16ToWav(pcm, LINE_SAMPLE_RATE));
      text = t.text;
      ms = t.ms;
    } catch (err) {
      this.sttInFlight--;
      this.fail('stt', err);
      if (slot) return this.doneRecognising(slot);
      if (!this.flushPending()) this.armSilenceIfIdle();
      return;
    }
    this.sttInFlight--;
    if (this.ended) return;
    this.work({ kind: 'stt', at, text, ms, audioMs });
    if (!text) {
      // A cough or line noise: nothing for the model, but the line is quiet again (or words waited for this).
      if (slot) return this.doneRecognising(slot);
      if (!this.flushPending()) this.armSilenceIfIdle();
      return;
    }
    this.deps.update((r) => {
      // In time order: what the agent began to say after these words ended (the "네." said the moment they did)
      // comes after them, though the words are known only now.
      let i = r.transcript.length;
      while (i > 0 && r.transcript[i - 1].role === 'agent' && r.transcript[i - 1].at >= at) i--;
      r.transcript.splice(i, 0, { role: 'peer', text, at });
    });
    this.call?._emit?.('transcript', 'user', text);
    if (!this.released) {
      this.heldPeer.push(text);
      return;
    }
    if (this.hangupRequested) {
      if (slot) this.doneRecognising(slot); // the turn still closes: it holds the line the goodbye goes out on
      return;
    }
    // The reply's first sentence reaches the speech engine in ~1 s (first tokens). Wake it now — not earlier: on the
    // voice host the wake-up would compete with this transcription (measured: STT 0.9 s → 2.5 s).
    this.warmEngine();
    // The other side's "여보세요" as it picks up is heard and logged, but it is not a turn: the opening answers it.
    if (first && this.plan.direction === 'outbound' && isBareGreeting(text)) {
      if (slot) return this.doneRecognising(slot);
      this.armSilenceIfIdle();
      return;
    }
    if (slot) return this.doneRecognising(slot, text);
    this.hear(text, keepReply);
  }

  private doneRecognising(slot: TurnSlot, text = ''): void {
    slot.turn.words[slot.index] = text;
    slot.turn.pending--;
    this.endTurn();
  }

  // ── thinking ────────────────────────────────────────────────

  private sendToDialog(text: string): void {
    if (!this.dialog || this.ended) return;
    // A turn is coming: the line is not quiet. Whoever ends that turn arms the timer again.
    this.clearSilence();
    if (!this.generating) {
      this.turnStartAt = this.now();
      this.firstTokenAt = 0;
      this.turnText = '';
    }
    this.generating = true;
    if (this.cutNote) {
      text = `${this.cutNote}\n${text}`;
      this.cutNote = null;
    }
    this.dialog.send(text);
  }

  private async pump(dialog: VoiceDialog): Promise<void> {
    for await (const ev of dialog.events) {
      if (this.ended && ev.type !== 'closed') continue;
      switch (ev.type) {
        case 'text_delta':
          if (this.dropTurn || this.dropAfterHangup) break;
          if (!this.firstTokenAt) this.firstTokenAt = this.now();
          this.turnText += ev.text;
          for (const s of this.splitter.push(ev.text)) this.enqueue(s);
          break;
        case 'assistant':
          this.turnModel = ev.model ?? this.turnModel;
          break;
        case 'tool_use':
          // The tool's work is recorded by its handler. `hang_up` is acted on here, at its place in the stream:
          // every word written before it is queued (the goodbye), every word after it is dropped. The handler may
          // run before this event is read, so it must not decide that.
          if (ev.name === 'hang_up' || ev.name.endsWith('__hang_up')) {
            if (this.dropTurn) {
              // The goodbye of a reply that answered out-of-date words (the caller went on talking): not said,
              // and the call goes on. The handler refuses it too, if it runs after this event.
              this.hangupRequested = false;
              this.work({ kind: 'event', at: this.now(), text: '끊기 취소 — 상대가 말을 이어감' });
              break;
            }
            this.hangupRequested = true;
            if (!this.dropTurn && !this.dropAfterHangup) for (const s of this.splitter.flush()) this.enqueue(s);
            this.dropAfterHangup = true;
            this.finishWhenQuiet();
          }
          break;
        case 'turn_end': {
          if (!this.dropTurn && !this.dropAfterHangup) for (const s of this.splitter.flush()) this.enqueue(s);
          else this.splitter.flush();
          const at = this.now();
          if (this.turnText.trim()) {
            this.work({
              kind: 'reply',
              at: this.turnStartAt || at,
              text: this.turnText.trim(),
              model: this.turnModel ?? this.plan.model,
              firstTokenMs: this.firstTokenAt ? this.firstTokenAt - this.turnStartAt : undefined,
              ms: at - (this.turnStartAt || at),
            });
          }
          if (ev.isError && ev.message && !this.dropTurn)
            this.work({ kind: 'error', at, stage: 'dialog', message: ev.message });
          this.generating = false;
          this.dropTurn = false;
          // The "네." said for words still waiting belongs to their answer, not to the turn that ended.
          if (!this.pendingPeer.length) this.acknowledged = false;
          this.turnText = '';
          if (this.pendingPeer.length && !this.hangupRequested && !this.ended) {
            // Words that waited for this reply: answered now, all together — or with the words the other side is
            // still saying or being recognised for, if any (flushPending).
            this.flushPending();
          } else if (this.hangupRequested) {
            this.dropAfterHangup = true;
            this.finishWhenQuiet();
          } else {
            this.armSilenceIfIdle(); // a turn that said nothing; one that did arms it when its speech ends
          }
          break;
        }
        case 'closed':
          if (ev.message && !this.ended) this.fail('dialog', new Error(ev.message));
          return;
      }
    }
  }

  private tools(): VoiceDialogTool[] {
    return [
      {
        name: 'hang_up',
        description: HANG_UP_TOOL.description,
        params: { reason: { description: HANG_UP_TOOL.reason, optional: true } },
        handler: async (args) => {
          // A reply being dropped (the caller went on talking) does not end the call — whichever of this handler
          // and the stream's tool_use event comes first (see pump).
          if (this.dropTurn) {
            this.work({
              kind: 'tool',
              at: this.now(),
              name: 'hang_up',
              input: args,
              result: '끊지 않음 — 상대가 말을 이어감',
            });
            return HANG_UP_TOOL.cancelled;
          }
          this.hangupRequested = true;
          this.work({ kind: 'tool', at: this.now(), name: 'hang_up', input: args, result: '말을 마치면 끊음' });
          return HANG_UP_TOOL.result;
        },
      },
      {
        name: 'send_dtmf',
        description: SEND_DTMF_TOOL.description,
        params: { digits: { description: SEND_DTMF_TOOL.digits } },
        handler: async (args) => {
          const digits = (args.digits ?? '').replace(/[^0-9*#wW]/g, '');
          if (!digits || !this.call?.sendDtmfSequence) {
            this.work({ kind: 'tool', at: this.now(), name: 'send_dtmf', input: args, result: '보낼 수 없음' });
            return SEND_DTMF_TOOL.failed;
          }
          await this.call.sendDtmfSequence(digits);
          this.work({ kind: 'tool', at: this.now(), name: 'send_dtmf', input: args, result: 'sent' });
          return SEND_DTMF_TOOL.sent(digits);
        },
      },
    ];
  }

  // ── ending ──────────────────────────────────────────────────

  /** After `hang_up`: wait for the queue and the playback, then put the phone down. */
  private finishWhenQuiet(): void {
    if (this.ended || !this.hangupRequested) return;
    if (this.speaking || this.queue.length) return; // speakQueue calls back when done
    const wait = Math.max(0, this.playEnd() - this.now()) + HANGUP_TAIL_MS;
    this.later(() => {
      if (this.ended) return;
      if (this.speaking || this.queue.length) return;
      // Still going out (the timers ran late, e.g. a stalled event loop): wait for the goodbye to end.
      if (this.out?.busy) return this.finishWhenQuiet();
      void this.call?.hangup().catch((err) => this.fail('hangup', err));
    }, wait);
  }

  private timeUp(): void {
    if (this.ended) return;
    this.work({ kind: 'event', at: this.now(), text: `통화 시간 한도(${this.plan.maxMinutes}분) 도달` });
    this.sendToDialog(TIME_UP_CUE);
    this.later(() => {
      if (!this.ended) void this.call?.hangup().catch((err) => this.fail('hangup', err));
    }, TIME_UP_GRACE_MS);
  }

  /** Arm the silence timer unless the agent is still speaking or thinking (they arm it when they finish). */
  private armSilenceIfIdle(): void {
    if (this.ended || this.speaking || this.queue.length || this.generating || this.turn) return;
    this.armSilence();
  }

  /**
   * The line went quiet after the agent: nudge the dialog after {@link SILENCE_NUDGE_MS}; if the line is still quiet
   * after the nudge was answered, twice that and put the phone down. Only the other side's speech resets the nudge.
   */
  private armSilence(): void {
    this.clearSilence();
    if (!this.released || this.hangupRequested || this.ended) return;
    const wait = Math.max(0, this.playEnd() - this.now()) + SILENCE_NUDGE_MS * (this.silenceNudged ? 2 : 1);
    this.silenceTimer = this.later(() => {
      // Still talking (either side) or thinking: not a quiet line. The end of that speech arms the timer again.
      if (this.ended || this.vad.speaking || this.generating || this.speaking || this.agentSpeaking()) return;
      if (this.silenceNudged) {
        this.work({ kind: 'event', at: this.now(), text: '상대가 오래 말이 없어 통화를 끝냄' });
        void this.call?.hangup().catch((err) => this.fail('hangup', err));
        return;
      }
      this.silenceNudged = true;
      this.sendToDialog(SILENCE_CUE);
    }, wait);
  }

  private clearSilence(): void {
    if (this.silenceTimer !== null) {
      this.clearTimer(this.silenceTimer);
      this.timers.delete(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  // ── bookkeeping ─────────────────────────────────────────────

  private later(fn: () => void, ms: number): unknown {
    const handle = this.setTimer(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  private work(event: PhoneWorkEvent): void {
    this.deps.update((r) => {
      r.work.push(event);
    });
  }

  private fail(stage: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.deps.log('warn', `phone ${stage} failed`, { callId: this.callId, message });
    this.work({ kind: 'error', at: this.now(), stage, message });
  }
}

/**
 * The object the SDK holds as its `session`. One call at a time: the phone service registers a run before (or as)
 * the call starts, and this routes the SDK's calls to it.
 */
export class PhoneVoiceSession implements SessionLike {
  private readonly runs = new Map<string, CallRun>();
  /** Calls being prepared by the fallback: a second start() of the same call waits for the first. */
  private readonly starting = new Map<string, Promise<CallRun | null>>();
  private current: CallRun | null = null;

  constructor(private readonly fallback: (call: CallSessionLike) => Promise<CallRun | null>) {}

  register(run: CallRun): void {
    this.runs.set(run.callId, run);
  }

  runOf(callId: string): CallRun | undefined {
    return this.runs.get(callId);
  }

  /** True while a call is up or being set up — the phone takes one call at a time. */
  get busy(): boolean {
    return this.current !== null || this.runs.size > 0 || this.starting.size > 0;
  }

  /** Calls with a run (live or being set up). */
  get callIds(): string[] {
    return [...this.runs.keys()];
  }

  end(callId: string): void {
    const run = this.runs.get(callId);
    if (!run) return;
    run.stop();
    this.runs.delete(callId);
    if (this.current === run) this.current = null;
  }

  async prewarm(): Promise<void> {
    // Not used: the agent runs with `prewarmEnabled: false`; the outbound opening is prepared by the run itself.
  }

  async attach(call: CallSessionLike): Promise<void> {
    await this.start(call);
  }

  async start(call: CallSessionLike): Promise<void> {
    let run = this.runs.get(call.callId);
    if (!run) {
      const inFlight = this.starting.get(call.callId);
      if (inFlight) {
        await inFlight; // the first start() attaches it
        return;
      }
      const pending = this.fallback(call);
      this.starting.set(call.callId, pending);
      let made: CallRun | null = null;
      try {
        made = await pending;
      } finally {
        this.starting.delete(call.callId);
      }
      if (!made) {
        await call.hangup().catch(() => undefined);
        return;
      }
      run = made;
      this.runs.set(call.callId, run);
    }
    this.current = run;
    run.attach(call);
  }

  feedAudio(audio: Buffer): void {
    this.current?.feedAudio(audio);
  }

  async feedDtmf(digits: string): Promise<void> {
    this.current?.feedDtmf(digits);
  }

  async stop(): Promise<void> {
    // The SDK calls stop() when a call's media closes; the run is ended by the service's call_end / call_failed.
    if (this.current) {
      const id = this.current.callId;
      this.end(id);
    }
  }
}
