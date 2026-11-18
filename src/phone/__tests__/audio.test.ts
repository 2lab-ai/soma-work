import { describe, expect, it } from 'vitest';
import { EnergyVad, pcm16ToWav, rmsDbfs, StreamResampler, TimeStretcher } from '../audio';

const RATE = 8000;

/** PCM16 LE: a sine at `amp` (0..1) for `ms`, or silence. */
function tone(ms: number, amp: number, freq = 440): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * amp * 32767), i * 2);
  return b;
}
const silence = (ms: number) => tone(ms, 0);
/** Line noise: a quiet, steady hiss. */
function hiss(ms: number, amp = 0.002): Buffer {
  const n = Math.round((RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    b.writeInt16LE(Math.round(((seed / 0x7fffffff) * 2 - 1) * amp * 32767), i * 2);
  }
  return b;
}

describe('rmsDbfs', () => {
  it('reads a full-scale sine near -3 dBFS and silence as -100', () => {
    expect(rmsDbfs(tone(20, 1))).toBeGreaterThan(-3.2);
    expect(rmsDbfs(tone(20, 1))).toBeLessThan(-2.8);
    expect(rmsDbfs(silence(20))).toBe(-100);
  });
});

describe('EnergyVad', () => {
  it('hears speech start, then one utterance after 500 ms of quiet (not before)', () => {
    const vad = new EnergyVad();
    expect(vad.push(hiss(1000))).toEqual([]);
    const start = vad.push(tone(600, 0.3));
    expect(start).toEqual([{ type: 'speech_start' }]);
    expect(vad.speaking).toBe(true);
    expect(vad.push(hiss(440))).toEqual([]); // a pause inside a sentence
    const end = vad.push(hiss(100));
    expect(end).toHaveLength(1);
    expect(end[0].type).toBe('utterance');
    const u = end[0] as { pcm: Buffer; speechMs: number; totalMs: number };
    expect(u.speechMs).toBeGreaterThanOrEqual(560);
    // Pre-roll (300 ms) + speech + at most 200 ms of trailing quiet.
    expect(u.totalMs).toBeLessThanOrEqual(300 + 600 + 200 + 20);
    expect(u.pcm.length).toBe((u.totalMs * RATE * 2) / 1000);
    expect(vad.speaking).toBe(false);
  });

  it('calls a short click noise, not an utterance', () => {
    const vad = new EnergyVad();
    vad.push(hiss(500));
    const ev = [...vad.push(tone(100, 0.4)), ...vad.push(hiss(800))];
    expect(ev.map((e) => e.type)).toEqual(['speech_start', 'noise']);
  });

  it('raises the bar while the agent speaks (echo of its own voice)', () => {
    const quietVoice = 0.012; // about -41 dBFS, 17 dB over the hiss: speech when the line is ours to hear
    const a = new EnergyVad();
    a.push(hiss(1000));
    expect(a.push(tone(300, quietVoice)).map((e) => e.type)).toEqual(['speech_start']);
    const b = new EnergyVad();
    b.push(hiss(1000));
    expect(b.push(tone(300, quietVoice), true)).toEqual([]);
    expect(b.push(tone(300, 0.3), true).map((e) => e.type)).toEqual(['speech_start']);
  });

  it('cuts an utterance that runs past the maximum', () => {
    const vad = new EnergyVad({ maxUtteranceMs: 1000 });
    vad.push(hiss(400));
    const ev = vad.push(tone(1500, 0.3));
    // Cut at 1 s; the speaker goes on, so the rest starts the next utterance.
    expect(ev.map((e) => e.type)).toEqual(['speech_start', 'utterance', 'speech_start']);
    expect((ev[1] as { totalMs: number }).totalMs).toBe(1000);
  });

  it('accepts audio in any chunk size', () => {
    const vad = new EnergyVad();
    const all = Buffer.concat([hiss(800), tone(500, 0.3), hiss(900)]);
    const events = [];
    for (let off = 0; off < all.length; off += 37) events.push(...vad.push(all.subarray(off, off + 37)));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'utterance']);
  });
});

describe('pcm16ToWav', () => {
  it('writes a 44-byte RIFF header for mono PCM16', () => {
    const wav = pcm16ToWav(Buffer.alloc(320), 8000);
    expect(wav.length).toBe(364);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(320);
  });
});

describe('StreamResampler', () => {
  it('turns 44.1 kHz into 8 kHz, chunk boundaries included', () => {
    const src = Buffer.alloc(44100 * 2); // 1 s
    for (let i = 0; i < 44100; i++)
      src.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / 44100) * 10000), i * 2);
    const rs = new StreamResampler(44100, 8000);
    let total = 0;
    for (let off = 0; off < src.length; off += 4410) total += rs.push(src.subarray(off, off + 4410)).length / 2;
    expect(Math.abs(total - 8000)).toBeLessThanOrEqual(2);
  });

  it('passes the rate through when nothing changes, holding a split sample for the next chunk', () => {
    const rs = new StreamResampler(8000, 8000);
    const a = rs.push(Buffer.from([1, 0, 2, 0, 3]));
    const b = rs.push(Buffer.from([0, 4, 0]));
    expect([...Buffer.concat([a, b])]).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
  });

  /** Samples of a 1 s 300 Hz sine at `rate`. */
  function sine(rate: number): Buffer {
    const b = Buffer.alloc(rate * 2);
    for (let i = 0; i < rate; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / rate) * 10000), i * 2);
    return b;
  }
  const samples = (b: Buffer) => Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
  function chunked(src: Buffer, sizes: number[]): Buffer {
    const rs = new StreamResampler(44100, 8000);
    const out: Buffer[] = [];
    let off = 0;
    for (let k = 0; off < src.length; k++) {
      const n = sizes[k % sizes.length];
      out.push(rs.push(src.subarray(off, off + n)));
      off += n;
    }
    return Buffer.concat(out);
  }

  it('gives the same samples whatever the chunk sizes — odd byte counts and split samples included', () => {
    const src = sine(44100);
    const whole = samples(new StreamResampler(44100, 8000).push(src));
    // Network chunks: odd sizes split a sample across two chunks; 2010 and 8192 leave a fractional last interval.
    for (const sizes of [[8192], [2010], [1001, 7, 333], [1, 2, 3]]) {
      const got = samples(chunked(src, sizes));
      expect(got.length).toBe(whole.length);
      const worst = got.reduce((m, v, i) => Math.max(m, Math.abs(v - whole[i])), 0);
      expect(worst, `chunks ${sizes.join('/')}`).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the waveform: the 8 kHz samples are the 44.1 kHz sine read at the new rate', () => {
    const got = samples(new StreamResampler(44100, 8000).push(sine(44100)));
    for (const i of [1, 17, 400, 7999]) {
      const expected = Math.sin((2 * Math.PI * 300 * i) / 8000) * 10000;
      expect(Math.abs(got[i] - expected)).toBeLessThan(60);
    }
  });
});

describe('TimeStretcher', () => {
  const R = 44100;
  /** A voiced sound: 180 Hz with harmonics and a slow loudness sway (deterministic). */
  function voiced(ms: number): Buffer {
    const n = Math.round((R * ms) / 1000);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / R;
      const v =
        (Math.sin(2 * Math.PI * 180 * t) +
          0.5 * Math.sin(2 * Math.PI * 360 * t) +
          0.25 * Math.sin(2 * Math.PI * 540 * t)) *
        (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
      b.writeInt16LE(Math.round(v * 0.35 * 32767), i * 2);
    }
    return b;
  }
  const ms = (b: Buffer) => (b.length / 2 / R) * 1000;
  /** Zero crossings per second of the middle half (the pitch, for this signal 2 × 180). */
  function crossingsPerSecond(b: Buffer): number {
    const n = b.length / 2;
    let c = 0;
    let prev = b.readInt16LE(Math.floor(n / 4) * 2);
    for (let i = Math.floor(n / 4) + 1; i < Math.floor((3 * n) / 4); i++) {
      const v = b.readInt16LE(i * 2);
      if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) c++;
      prev = v;
    }
    return c / (n / 2 / R);
  }
  function stretch(input: Buffer, speed: number, chunks: number[] = [input.length]): Buffer {
    const ts = new TimeStretcher(R, speed);
    const out: Buffer[] = [];
    let off = 0;
    for (let i = 0; off < input.length; i++) {
      const size = chunks[i % chunks.length];
      out.push(ts.push(input.subarray(off, off + size)));
      off += size;
    }
    out.push(ts.flush());
    return Buffer.concat(out);
  }

  it('refuses a sample rate it cannot work at, instead of looping forever', () => {
    expect(() => new TimeStretcher(1, 1.5)).toThrow(RangeError);
    expect(() => new TimeStretcher(192000, 1.5)).toThrow(RangeError); // its search would cost ~19x 44.1 kHz
    expect(() => new TimeStretcher(44100, 0)).toThrow(RangeError);
  });

  it('passes audio through untouched at speed 1', () => {
    const input = voiced(300);
    expect(stretch(input, 1).equals(input)).toBe(true);
  });

  it('says the same thing 1.5x faster: two thirds of the time, same pitch, same loudness', () => {
    const input = voiced(3000);
    const out = stretch(input, 1.5);
    expect(ms(out)).toBeGreaterThan(2000 * 0.97);
    expect(ms(out)).toBeLessThan(2000 * 1.03);
    const pitchIn = crossingsPerSecond(input);
    expect(Math.abs(crossingsPerSecond(out) - pitchIn) / pitchIn).toBeLessThan(0.05);
    const dbIn = rmsDbfs(input);
    expect(Math.abs(rmsDbfs(out) - dbIn)).toBeLessThan(1.5);
  });

  it('slows down too: at 0.5 it takes twice the time, same pitch, same loudness, however it is chunked', () => {
    const input = voiced(1500);
    const out = stretch(input, 0.5);
    expect(ms(out)).toBeGreaterThan(3000 * 0.97);
    expect(ms(out)).toBeLessThan(3000 * 1.03);
    const pitchIn = crossingsPerSecond(input);
    expect(Math.abs(crossingsPerSecond(out) - pitchIn) / pitchIn).toBeLessThan(0.05);
    expect(Math.abs(rmsDbfs(out) - rmsDbfs(input))).toBeLessThan(1.5);
    expect(stretch(input, 0.5, [999, 7, 4096]).equals(out)).toBe(true);
  });

  it('gives the same audio however the stream is chunked (odd byte splits included)', () => {
    const input = voiced(1500);
    const whole = stretch(input, 1.5);
    const chunked = stretch(input, 1.5, [4097, 13, 2048, 777, 1]);
    expect(chunked.equals(whole)).toBe(true);
  });
});
