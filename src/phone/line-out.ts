/**
 * The agent's voice to the phone line (.prd/31-phone-calls-architecture.md §3.4).
 *
 * Frames go out in real time, never more than 200 ms ahead of what is playing — the line plays whatever it has
 * been sent, so audio sent early can no longer be changed. Keeping the lead short is what lets the agent react like a
 * person when the other side starts talking: lower its voice at once ({@link duck}), carry on at full voice if that
 * was only a "네" ({@link restore}), or finish its word and fall silent when it was a real interruption
 * ({@link fadeOut}). The volume is applied as each frame is sent.
 */

const FRAME_MS = 20;
/** How far ahead of playback frames are sent: timer and network jitter. */
const LEAD_MS = 200;
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
  /** The other side is talking: nothing new starts (a part already sounding goes on). */
  private held = false;
  /** Frames at the head of the queue that belong to the fade under way (audio queued after it is not faded). */
  private fadeLeft = 0;
  private readonly parts = new Map<unknown, { total: number; sent: number }>();

  constructor(private readonly deps: LineOutDeps) {}

  /** Queue one 20 ms frame (as the line takes it), tagged with the part of speech it belongs to. */
  push(frame: Buffer, tag: unknown): void {
    this.frames.push({ data: frame, tag });
    const p = this.parts.get(tag) ?? { total: 0, sent: 0 };
    p.total++;
    this.parts.set(tag, p);
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

  /** When everything sent and queued will have played (a fade under way: its frames up to silence only). */
  get playEndAt(): number {
    const fadeHeard = this.fadeLeft ? Math.min(this.fadeLeft, Math.ceil(this.gain / this.step)) : 0;
    const queued = this.frames.length - this.fadeLeft + fadeHeard;
    return Math.max(this.sentUntil, this.deps.now()) + queued * FRAME_MS;
  }

  /**
   * The share of a tagged part that has gone out (≈ been heard: the lead is short). A part still being made is
   * measured against `expectedTotal` frames when that is more than it holds so far.
   */
  sentFraction(tag: unknown, expectedTotal = 0): number {
    const p = this.parts.get(tag);
    const total = Math.max(p?.total ?? 0, expectedTotal);
    return p && total ? p.sent / total : 0;
  }

  /** Fading out after a real interruption: what is left of the voice is going. */
  get fading(): boolean {
    return this.fadeLeft > 0;
  }

  /** The other side may be interrupting: go on, quieter. */
  duck(gain = DUCK_GAIN): void {
    if (this.fading) return;
    this.rampTo(gain, DUCK_RAMP_MS);
  }

  /** It was only a "네": back to full voice. */
  restore(): void {
    if (this.fading) return;
    this.rampTo(1, RESTORE_RAMP_MS);
  }

  /**
   * A real interruption: the part under way falls silent over `ms` (its word ends softly) and the rest of it is
   * dropped; parts not started yet are dropped at once — they are never heard. The fade ends when the voice is silent
   * or that part's audio runs out, whichever is first, and at once when nothing of it is left to send. Audio queued
   * after this call (the next reply) is not part of the fade: it plays at full voice when the fade is over.
   */
  fadeOut(ms: number): void {
    let keep = 0;
    while (keep < this.frames.length && (this.parts.get(this.frames[keep].tag)?.sent ?? 0) > 0) keep++;
    this.forget(this.frames.splice(keep));
    this.fadeLeft = keep;
    if (!keep) {
      this.gain = this.target = 1;
      return;
    }
    this.rampTo(0, ms);
    if (this.timer === null) this.pump();
  }

  /** The other side is talking: start nothing new until {@link release} — a person does not begin over someone. */
  hold(): void {
    this.held = true;
  }

  /** The other side's turn is over: what waited may start. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.timer === null) this.pump();
  }

  /** Drop everything now and clear the line (the call ended, or nothing may be heard any more). */
  stop(): void {
    this.frames = [];
    this.parts.clear();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.fadeLeft = 0;
    this.gain = this.target = 1;
    this.sentUntil = this.deps.now();
    this.deps.clear();
  }

  /** Faded out: what is left of the faded part is never heard. What was queued after the fade plays at full voice. */
  private endFade(): void {
    this.forget(this.frames.splice(0, this.fadeLeft));
    this.fadeLeft = 0;
    this.gain = this.target = 1;
  }

  /** Dropped frames: their parts do not wait to be said any more. */
  private forget(dropped: Frame[]): void {
    for (const f of dropped) this.parts.delete(f.tag);
  }

  private rampTo(target: number, ms: number): void {
    this.target = target;
    this.step = Math.abs(target - this.gain) / Math.max(1, ms / FRAME_MS) || 1;
  }

  private pump(): void {
    this.timer = null;
    const now = this.deps.now();
    while (this.frames.length && this.sentUntil - now < LEAD_MS) {
      if (this.held && !this.parts.get(this.frames[0].tag)?.sent) return; // waits for release()
      const f = this.frames.shift() as Frame;
      const fading = this.fadeLeft > 0;
      this.sendOne(f, now);
      if (fading && (--this.fadeLeft === 0 || this.gain === 0)) this.endFade();
    }
    if (this.frames.length) {
      this.timer = this.deps.setTimer(() => this.pump(), Math.max(FRAME_MS, this.sentUntil - LEAD_MS - now));
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
    const p = this.parts.get(f.tag);
    if (p) {
      if (p.sent === 0) this.deps.onStart?.(f.tag);
      p.sent++;
    }
    this.deps.send(out);
    this.sentUntil = Math.max(this.sentUntil, now) + FRAME_MS;
  }
}
