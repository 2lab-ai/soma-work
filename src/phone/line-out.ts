/**
 * The agent's voice to the phone line (.prd/31-phone-calls-architecture.md §3.4).
 *
 * Frames go out in real time, never more than `leadMs` ahead of what is playing — the line plays whatever it has
 * been sent, so audio sent early can no longer be changed. Keeping the lead short is what lets the agent react like a
 * person when the other side starts talking: lower its voice at once ({@link duck}), carry on at full voice if that
 * was only a "네" ({@link restore}), or finish its word and fall silent when it was a real interruption
 * ({@link fadeOut}). The volume is applied as each frame is sent.
 */

const FRAME_MS = 20;
/** How low the voice goes while the other side may be interrupting. */
export const DUCK_GAIN = 0.3;
const DUCK_RAMP_MS = 100;
const RESTORE_RAMP_MS = 150;

export interface LineOutDeps {
  /** One μ-law frame to the line. */
  send(frame: Buffer): void;
  /** Drop what the line has buffered. */
  clear(): void;
  /** A frame as the line takes it (μ-law) → PCM16, and back: used only while the volume is not full. */
  decode(frame: Buffer): Buffer;
  encode(pcm: Buffer): Buffer;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The first frame of a tagged part has gone out: it is being heard from now on. */
  onStart?(tag: unknown): void;
  /** How far ahead of playback frames are sent. Default 200 ms (timer and network jitter). */
  leadMs?: number;
}

interface Frame {
  /** 20 ms as the line takes it. */
  data: Buffer;
  tag: unknown;
}

export class LineOut {
  private frames: Frame[] = [];
  /** When the last frame sent will have finished playing. */
  private sentUntil = 0;
  private timer: unknown = null;
  private gain = 1;
  private target = 1;
  /** Gain change per frame toward `target`. */
  private step = 1;
  private fadeDone: (() => void) | null = null;
  private readonly parts = new Map<unknown, { total: number; sent: number }>();
  private readonly lead: number;

  constructor(private readonly deps: LineOutDeps) {
    this.lead = deps.leadMs ?? 200;
  }

  /** Queue one 20 ms frame (as the line takes it), optionally tagged with the part of speech it belongs to. */
  push(frame: Buffer, tag?: unknown): void {
    this.frames.push({ data: frame, tag });
    if (tag !== undefined) {
      const p = this.parts.get(tag) ?? { total: 0, sent: 0 };
      p.total++;
      this.parts.set(tag, p);
    }
    if (this.timer === null) this.pump();
  }

  /** Tagged parts queued but not started (nothing of them heard yet). */
  unstarted(): unknown[] {
    return [...this.parts.entries()].filter(([, p]) => p.sent === 0 && p.total > 0).map(([t]) => t);
  }

  /** Something is still to be heard: queued, or sent and still playing. */
  get busy(): boolean {
    return this.frames.length > 0 || this.deps.now() < this.sentUntil;
  }

  /** When everything sent and queued will have played. */
  get playEndAt(): number {
    return Math.max(this.sentUntil, this.deps.now()) + this.frames.length * FRAME_MS;
  }

  /** The share of a tagged part that has gone out (≈ been heard: the lead is short). */
  sentFraction(tag: unknown): number {
    const p = this.parts.get(tag);
    return p?.total ? p.sent / p.total : 0;
  }

  /** The other side may be interrupting: go on, quieter. */
  duck(gain = DUCK_GAIN): void {
    if (this.fadeDone) return;
    this.rampTo(gain, DUCK_RAMP_MS);
  }

  /** It was only a "네": back to full voice. */
  restore(): void {
    if (this.fadeDone) return;
    this.rampTo(1, RESTORE_RAMP_MS);
  }

  /**
   * A real interruption: fall silent over `ms` (the word under way ends softly), then drop whatever is left unsent.
   * `onDone` runs once the last faded frame has gone out.
   */
  fadeOut(ms: number, onDone: () => void): void {
    this.fadeDone = onDone;
    this.rampTo(0, ms);
    if (this.timer === null) this.pump();
  }

  /** Drop everything now and clear the line (the call ended, or nothing may be heard any more). */
  stop(): void {
    this.frames = [];
    this.parts.clear();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.fadeDone = null;
    this.gain = this.target = 1;
    this.sentUntil = this.deps.now();
    this.deps.clear();
  }

  private rampTo(target: number, ms: number): void {
    this.target = target;
    this.step = Math.abs(target - this.gain) / Math.max(1, ms / FRAME_MS) || 1;
  }

  private pump(): void {
    this.timer = null;
    const now = this.deps.now();
    while (this.frames.length && this.sentUntil - now < this.lead) {
      const f = this.frames.shift() as Frame;
      this.sendOne(f, now);
      if (this.fadeDone && this.gain === 0) {
        // Faded out: what is left is never heard.
        this.frames = [];
        const done = this.fadeDone;
        this.fadeDone = null;
        this.gain = this.target = 1;
        done();
        break;
      }
    }
    if (this.frames.length) {
      this.timer = this.deps.setTimer(() => this.pump(), Math.max(FRAME_MS, this.sentUntil - this.lead - now));
    }
  }

  private sendOne(f: Frame, now: number): void {
    const from = this.gain;
    const to =
      this.target > this.gain
        ? Math.min(this.target, this.gain + this.step)
        : Math.max(this.target, this.gain - this.step);
    this.gain = to;
    let out = f.data;
    if (from !== 1 || to !== 1) {
      const pcm = this.deps.decode(f.data);
      const scaled = Buffer.alloc(pcm.length);
      const n = pcm.length / 2;
      for (let i = 0; i < n; i++) {
        const g = from + ((to - from) * (i + 1)) / n; // a ramp inside the frame: no click
        scaled.writeInt16LE(Math.round(pcm.readInt16LE(i * 2) * g), i * 2);
      }
      out = this.deps.encode(scaled);
    }
    if (f.tag !== undefined) {
      const p = this.parts.get(f.tag);
      if (p) {
        if (p.sent === 0) this.deps.onStart?.(f.tag);
        p.sent++;
      }
    }
    this.deps.send(out);
    this.sentUntil = Math.max(this.sentUntil, now) + FRAME_MS;
  }
}
