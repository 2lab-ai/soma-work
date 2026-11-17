/**
 * Phone audio helpers: a small energy-based voice activity detector (VAD) for the 8 kHz line, and a WAV
 * wrapper for the speech-to-text request (.prd/31-phone-calls-architecture.md §3).
 *
 * The line carries G.711 μ-law at 8 kHz in 20 ms frames. The SDK decodes nothing for a custom session, so the
 * session decodes each frame to PCM16 and feeds it here. The detector answers two questions per frame: did the
 * other party just start talking (barge-in), and did an utterance just end (send it to speech-to-text).
 *
 * Pure: no I/O, no timers — time is counted in frames, so tests drive it with synthetic audio.
 */

export const LINE_SAMPLE_RATE = 8000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (LINE_SAMPLE_RATE * FRAME_MS) / 1000; // 160

export interface VadOptions {
  /** Consecutive loud frames before speech counts as started. Default 3 (60 ms). */
  startFrames?: number;
  /** Quiet time after speech that ends an utterance. Default 700 ms. */
  endSilenceMs?: number;
  /** Shorter bursts are noise (a cough, a click), not an utterance. Default 300 ms. */
  minSpeechMs?: number;
  /** An utterance is cut here even if the speaker goes on. Default 30 s. */
  maxUtteranceMs?: number;
  /** Audio kept from before the start, so the first syllable is not clipped. Default 300 ms. */
  preRollMs?: number;
  /** Speech must be at least this loud (dBFS), whatever the noise floor. Default -45. */
  minDbfs?: number;
  /** Speech must be this far above the noise floor (dB). Default 12. */
  marginDb?: number;
  /**
   * Extra margin while the agent is talking, so its own voice echoing back from the handset does not count as
   * the caller interrupting. Default 8 dB.
   */
  echoMarginDb?: number;
}

export type VadEvent =
  | { type: 'speech_start' }
  | { type: 'utterance'; pcm: Buffer; speechMs: number; totalMs: number }
  | { type: 'noise'; speechMs: number };

/** Root-mean-square level of one PCM16 LE frame in dBFS (-100 for silence). */
export function rmsDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -100;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 1e-5 ? -100 : 20 * Math.log10(rms);
}

export class EnergyVad {
  private readonly startFrames: number;
  private readonly endSilenceFrames: number;
  private readonly minSpeechFrames: number;
  private readonly maxFrames: number;
  private readonly preRollFrames: number;
  private readonly minDbfs: number;
  private readonly marginDb: number;
  private readonly echoMarginDb: number;

  private pending: Buffer = Buffer.alloc(0);
  private floor = -60;
  private preRoll: Buffer[] = [];
  private loudRun = 0;
  private inSpeech = false;
  private utterance: Buffer[] = [];
  private speechFrames = 0;
  private silenceRun = 0;

  constructor(options: VadOptions = {}) {
    this.startFrames = options.startFrames ?? 3;
    this.endSilenceFrames = Math.ceil((options.endSilenceMs ?? 700) / FRAME_MS);
    this.minSpeechFrames = Math.ceil((options.minSpeechMs ?? 300) / FRAME_MS);
    this.maxFrames = Math.ceil((options.maxUtteranceMs ?? 30_000) / FRAME_MS);
    this.preRollFrames = Math.ceil((options.preRollMs ?? 300) / FRAME_MS);
    this.minDbfs = options.minDbfs ?? -45;
    this.marginDb = options.marginDb ?? 12;
    this.echoMarginDb = options.echoMarginDb ?? 8;
  }

  /** The current noise floor estimate (dBFS) — for the work log and tests. */
  get noiseFloor(): number {
    return this.floor;
  }

  /** True between `speech_start` and the end of that utterance. */
  get speaking(): boolean {
    return this.inSpeech;
  }

  /**
   * Feed PCM16 LE 8 kHz audio of any length. `agentSpeaking` raises the bar while the agent's own voice may be
   * echoing back. Returns the events the audio produced, in order.
   */
  push(pcm: Buffer, agentSpeaking = false): VadEvent[] {
    const events: VadEvent[] = [];
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    const frameBytes = SAMPLES_PER_FRAME * 2;
    while (this.pending.length >= frameBytes) {
      const frame = this.pending.subarray(0, frameBytes);
      this.pending = this.pending.subarray(frameBytes);
      this.frame(Buffer.from(frame), agentSpeaking, events);
    }
    return events;
  }

  /** Drop any partial utterance (the call ended, or the agent hung up). */
  reset(): void {
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.loudRun = 0;
    this.inSpeech = false;
    this.utterance = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
  }

  private frame(frame: Buffer, agentSpeaking: boolean, events: VadEvent[]): void {
    const db = rmsDbfs(frame);
    const threshold = Math.max(this.floor + this.marginDb + (agentSpeaking ? this.echoMarginDb : 0), this.minDbfs);
    const loud = db > threshold;

    if (!this.inSpeech) {
      // The floor follows quiet frames: down fast, up slowly, never while someone talks.
      this.floor = db < this.floor ? 0.7 * this.floor + 0.3 * db : 0.995 * this.floor + 0.005 * db;
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.startFrames) {
        this.inSpeech = true;
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = this.loudRun;
        this.silenceRun = 0;
        this.loudRun = 0;
        events.push({ type: 'speech_start' });
      }
      return;
    }

    this.utterance.push(frame);
    if (loud) {
      this.speechFrames++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }
    const ended = this.silenceRun >= this.endSilenceFrames;
    const tooLong = this.utterance.length >= this.maxFrames;
    if (!ended && !tooLong) return;

    const speechMs = this.speechFrames * FRAME_MS;
    if (this.speechFrames >= this.minSpeechFrames) {
      // Keep a little of the trailing quiet (the recogniser likes a soft ending), not all 700 ms of it.
      const keep = tooLong ? this.utterance.length : this.utterance.length - Math.max(0, this.silenceRun - 10);
      const pcm = Buffer.concat(this.utterance.slice(0, keep));
      events.push({ type: 'utterance', pcm, speechMs, totalMs: keep * FRAME_MS });
    } else {
      events.push({ type: 'noise', speechMs });
    }
    this.inSpeech = false;
    this.utterance = [];
    this.speechFrames = 0;
    this.silenceRun = 0;
  }
}

/** A mono PCM16 LE buffer wrapped as a WAV file. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Linear-interpolation resampler for mono PCM16 LE. Good enough for speech going to an 8 kHz phone line (the
 * line's own band limit hides the aliasing a better filter would remove). `carry` keeps the fractional position
 * between chunks of one stream so chunk boundaries do not click.
 */
export class StreamResampler {
  private pos = 0;
  private last: number | null = null;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number,
  ) {}

  push(pcm: Buffer): Buffer {
    const n = Math.floor(pcm.length / 2);
    if (n === 0) return Buffer.alloc(0);
    if (this.fromRate === this.toRate) return pcm.subarray(0, n * 2);
    const src = new Array<number>(n + (this.last === null ? 0 : 1));
    let offset = 0;
    if (this.last !== null) src[offset++] = this.last;
    for (let i = 0; i < n; i++) src[offset + i] = pcm.readInt16LE(i * 2);
    const step = this.fromRate / this.toRate;
    const out: number[] = [];
    let p = this.pos;
    while (p <= src.length - 2) {
      const i = Math.floor(p);
      const frac = p - i;
      out.push(Math.round(src[i] * (1 - frac) + src[i + 1] * frac));
      p += step;
    }
    // Next chunk starts with this chunk's last sample at index 0.
    this.pos = p - (src.length - 1);
    this.last = src[src.length - 1];
    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, out[i])), i * 2);
    return buf;
  }
}
