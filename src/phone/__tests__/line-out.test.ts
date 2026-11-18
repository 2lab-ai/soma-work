/**
 * The agent's voice to the line (.prd/31-phone-calls-architecture.md §3): paced in real time with a short lead, so
 * what is still unsent can be ducked when the other side starts talking, brought back when that was only a "네",
 * and faded out — not cut dead — when it was a real interruption.
 */
import { describe, expect, it } from 'vitest';
import { LineOut } from '../line-out';

const FRAME = 320; // 20 ms of PCM16 at 8 kHz

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

/** A steady tone frame at `amp` (0..1); the identity codec keeps PCM so the test can read levels back. */
function frame(amp: number): Buffer {
  const b = Buffer.alloc(FRAME);
  for (let i = 0; i < FRAME / 2; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / 8000) * amp * 32767), i * 2);
  return b;
}
function peak(b: Buffer): number {
  let m = 0;
  for (let i = 0; i < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i)));
  return m / 32767;
}

function setup() {
  const clock = new Clock();
  const sent: { at: number; pcm: Buffer }[] = [];
  let cleared = 0;
  const started: unknown[] = [];
  const out = new LineOut({
    send: (b) => sent.push({ at: clock.t, pcm: b }),
    clear: () => cleared++,
    decode: (b) => b,
    encode: (b) => b,
    now: clock.now,
    setTimer: clock.set,
    clearTimer: clock.clear,
    onStart: (tag) => started.push(tag),
  });
  return { clock, out, sent, cleared: () => cleared, started };
}

describe('LineOut', () => {
  it('sends in real time, never more than the lead ahead of what is playing', () => {
    const { clock, out, sent } = setup();
    for (let i = 0; i < 100; i++) out.push(frame(0.5)); // 2 s of speech
    expect(sent).toHaveLength(10); // 200 ms ahead, no more
    clock.advance(1000);
    expect(sent.length).toBeGreaterThanOrEqual(58);
    expect(sent.length).toBeLessThanOrEqual(61);
    clock.advance(1200);
    expect(sent).toHaveLength(100);
    expect(out.busy).toBe(false);
  });

  it('knows when what it holds will have played, and tells when a tagged part starts to sound', () => {
    const { clock, out, started } = setup();
    out.push(frame(0.5), 'a');
    for (let i = 0; i < 49; i++) out.push(frame(0.5), 'a'); // 1 s
    for (let i = 0; i < 50; i++) out.push(frame(0.5), 'b'); // 1 s
    expect(out.playEndAt).toBe(clock.t + 2000);
    expect(started).toEqual(['a']);
    clock.advance(1000);
    expect(started).toEqual(['a', 'b']);
    expect(out.sentFraction('a')).toBe(1);
    expect(out.sentFraction('b')).toBeGreaterThan(0.15);
    expect(out.sentFraction('b')).toBeLessThan(0.3);
  });

  it('ducks what is still unsent when the other side starts talking, and brings it back after a "네"', () => {
    const { clock, out, sent } = setup();
    for (let i = 0; i < 150; i++) out.push(frame(0.8));
    clock.advance(500);
    out.duck();
    clock.advance(600);
    const ducked = sent.slice(-5).map((s) => peak(s.pcm));
    for (const p of ducked) expect(p).toBeLessThan(0.8 * 0.35);
    out.restore();
    clock.advance(800);
    const back = sent.slice(-5).map((s) => peak(s.pcm));
    for (const p of back) expect(p).toBeGreaterThan(0.75);
    // No jump: from frame to frame the level changes smoothly.
    for (let i = 1; i < sent.length; i++)
      expect(Math.abs(peak(sent[i].pcm) - peak(sent[i - 1].pcm))).toBeLessThan(0.25);
  });

  it('a real interruption fades out over a moment and then stops — the rest is never sent', () => {
    const { clock, out, sent, cleared } = setup();
    for (let i = 0; i < 250; i++) out.push(frame(0.8), 'reply'); // 5 s
    clock.advance(1000);
    out.fadeOut(300);
    expect(out.fading).toBe(true);
    clock.advance(1000);
    expect(out.fading).toBe(false);
    expect(out.busy).toBe(false);
    // What went out after the fade began: falling step by step to silence over the 300 ms asked (15 frames), not
    // faster and not cut dead.
    const tail = sent.slice(60).map((s) => peak(s.pcm));
    expect(tail.length).toBeGreaterThanOrEqual(14);
    expect(tail.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < tail.length; i++) expect(tail[i]).toBeLessThan(tail[i - 1]);
    expect(tail[Math.floor(tail.length / 2)]).toBeGreaterThan(0.2); // halfway through it is still heard
    expect(sent.length).toBeLessThan(50 + 10 + 15 + 2);
    expect(peak(sent[sent.length - 1].pcm)).toBeLessThan(0.1); // the last word ends softly
    expect(cleared()).toBe(0); // nothing loud is left in the line's buffer to throw away
    expect(out.sentFraction('reply')).toBeLessThan(0.4);
  });

  it('forgets the parts a fade-out dropped: they are not waiting to be said any more', () => {
    const { clock, out } = setup();
    for (let i = 0; i < 50; i++) out.push(frame(0.8), 'a');
    for (let i = 0; i < 50; i++) out.push(frame(0.8), 'b');
    clock.advance(300);
    expect(out.unstarted()).toEqual(['b']);
    out.fadeOut(300);
    clock.advance(1000);
    expect(out.unstarted()).toEqual([]);
  });

  it('a part still being made: its share is counted against the length it is expected to have', () => {
    const { clock, out } = setup();
    for (let i = 0; i < 50; i++) out.push(frame(0.5), 'a'); // 1 s made so far
    clock.advance(400);
    const sent = out.sentFraction('a');
    expect(sent).toBeGreaterThan(0.5); // of what is made so far
    expect(out.sentFraction('a', 200)).toBeCloseTo((sent * 50) / 200, 5); // of the 4 s it will have
    expect(out.sentFraction('a', 10)).toBe(sent); // never less than what is already made
  });

  it('a fade with nothing left to send ends at once: the next reply plays at full voice', () => {
    const { clock, out, sent } = setup();
    for (let i = 0; i < 5; i++) out.push(frame(0.8), 'old');
    clock.advance(500); // all of it sent and played
    out.fadeOut(300);
    expect(out.fading).toBe(false);
    for (let i = 0; i < 20; i++) out.push(frame(0.8), 'next');
    clock.advance(1000);
    expect(sent).toHaveLength(25);
    for (const s of sent.slice(5)) expect(peak(s.pcm)).toBeGreaterThan(0.75);
  });

  it('a fade whose audio runs out before silence ends with it: the next reply is not faded or dropped', () => {
    const { clock, out, sent } = setup();
    for (let i = 0; i < 12; i++) out.push(frame(0.8), 'old'); // 10 go out at once, 2 wait
    out.fadeOut(300);
    clock.advance(500);
    expect(out.fading).toBe(false);
    for (let i = 0; i < 20; i++) out.push(frame(0.8), 'next');
    clock.advance(1000);
    expect(sent).toHaveLength(32);
    for (const s of sent.slice(12)) expect(peak(s.pcm)).toBeGreaterThan(0.75);
    out.duck(); // and the voice can be lowered again
    for (let i = 0; i < 20; i++) out.push(frame(0.8), 'more');
    clock.advance(1000);
    expect(peak(sent[sent.length - 1].pcm)).toBeLessThan(0.8 * 0.35);
  });

  it('stop() drops everything at once and clears the line (call ended, hang-up)', () => {
    const { clock, out, sent, cleared } = setup();
    for (let i = 0; i < 100; i++) out.push(frame(0.5));
    out.stop();
    clock.advance(2000);
    expect(sent).toHaveLength(10);
    expect(cleared()).toBe(1);
    expect(out.busy).toBe(false);
  });
});
