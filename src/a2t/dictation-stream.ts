/**
 * 서버 위스퍼 live dictation — the stream policy (epic #737, #739).
 *
 * The browser streams its microphone at 16 kHz; Whisper is not a streaming model, so the open segment is
 * transcribed again every step while speech lasts, and words settle when two hypotheses in a row agree on them
 * (LocalAgreement-2, as in whisper_streaming). A pause closes the segment — its last transcription is final and the
 * next segment starts empty — so a transcription never grows past a sentence or two.
 *
 * Whisper makes words up on silence ("감사합니다", "시청해주셔서 감사합니다"): silence is never sent, and those
 * phrases are dropped when a whole short burst is nothing else.
 */

export interface DictationText {
  /** Everything settled so far in this stream. */
  final: string;
  /** The words of the open segment still being heard. */
  interim: string;
}

export interface DictationStreamOptions {
  /** Transcribe 16 kHz mono PCM; prompt is the end of what is already final (context for Whisper). */
  transcribe: (pcm: Int16Array, prompt: string) => Promise<string>;
  onText: (text: DictationText) => void;
  onError?: (message: string) => void;
  /** Samples per second of the PCM pushed. */
  sampleRate?: number;
  /** New speech between two transcriptions of the open segment. */
  stepMs?: number;
  /** Silence after speech that closes the segment. */
  silenceMs?: number;
  /** A segment this long is closed anyway. */
  maxSegmentMs?: number;
  /** Audio kept from before the first voiced frame (the start of a word). */
  preRollMs?: number;
  /** Frame RMS (0–1) that counts as voice. */
  voiceRms?: number;
}

const FRAME_MS = 20;
const PROMPT_CHARS = 120;
/** A short burst that is only one of these is Whisper's silence talking. */
const SILENCE_PHRASES =
  /^(감사합니다|고맙습니다|시청해\s?주셔서 감사합니다|구독과 좋아요 부탁드립니다|mbc 뉴스[^.]*|자막[^.]*|thank you|thanks for watching)[.!。]?$/i;
const SILENCE_PHRASE_MAX_VOICED_MS = 2000;

/** A word for agreement: punctuation and case do not count. */
function norm(w: string): string {
  return w.replace(/[.,!?。、…"'“”‘’()[\]]/g, '').toLowerCase();
}
function words(text: string): string[] {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export class DictationStream {
  private readonly opts: Required<Omit<DictationStreamOptions, 'onError'>> & Pick<DictationStreamOptions, 'onError'>;
  private readonly frame: number;
  // The open segment.
  private chunks: Int16Array[] = [];
  private length = 0;
  private voicedSamples = 0;
  private silenceRun = 0;
  private sinceRun = 0;
  private voicedSinceRun = 0;
  private preRoll: Int16Array[] = [];
  private preRollLength = 0;
  private committed: string[] = [];
  private previous: string[] = [];
  private interim: string[] = [];
  private generation = 0;
  // Closed segments.
  private done: string[] = [];
  private placeholder = '';
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  private lastSent = '';
  private carry: Int16Array = new Int16Array(0);

  constructor(options: DictationStreamOptions) {
    this.opts = {
      sampleRate: 16000,
      stepMs: 500,
      silenceMs: 800,
      maxSegmentMs: 25000,
      preRollMs: 300,
      voiceRms: 0.012,
      ...options,
    };
    this.frame = Math.round((this.opts.sampleRate * FRAME_MS) / 1000);
  }

  /** A transcription is running or queued. */
  get busy(): boolean {
    return this.running > 0;
  }

  /** Audio from the browser, any length. */
  push(chunk: Int16Array): void {
    let data = chunk;
    if (this.carry.length) {
      data = new Int16Array(this.carry.length + chunk.length);
      data.set(this.carry);
      data.set(chunk, this.carry.length);
    }
    let at = 0;
    for (; at + this.frame <= data.length; at += this.frame) this.frameIn(data.subarray(at, at + this.frame));
    this.carry = data.slice(at);
  }

  /** The stream ends: the open segment is finalized; resolves with everything final. */
  async finish(): Promise<{ final: string }> {
    if (this.carry.length) {
      this.frameIn(this.carry);
      this.carry = new Int16Array(0);
    }
    if (this.voicedSamples > 0) this.close();
    await this.chain;
    const final = this.text().final;
    this.emit(true);
    return { final };
  }

  private ms(samples: number): number {
    return (samples * 1000) / this.opts.sampleRate;
  }

  private frameIn(f: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += (f[i] / 32768) ** 2;
    const voiced = Math.sqrt(sum / f.length) >= this.opts.voiceRms;
    if (this.voicedSamples === 0 && !voiced) {
      // Before speech: keep only the last pre-roll of it.
      this.preRoll.push(f.slice());
      this.preRollLength += f.length;
      const keep = (this.opts.sampleRate * this.opts.preRollMs) / 1000;
      while (this.preRoll.length && this.preRollLength - this.preRoll[0].length >= keep) {
        this.preRollLength -= (this.preRoll.shift() as Int16Array).length;
      }
      return;
    }
    if (this.voicedSamples === 0) {
      for (const p of this.preRoll) this.add(p);
      this.preRoll = [];
      this.preRollLength = 0;
    }
    this.add(f.slice());
    this.sinceRun += f.length;
    if (voiced) {
      this.voicedSamples += f.length;
      this.voicedSinceRun += f.length;
      this.silenceRun = 0;
    } else {
      this.silenceRun += f.length;
    }
    if (this.ms(this.silenceRun) >= this.opts.silenceMs || this.ms(this.length) >= this.opts.maxSegmentMs) {
      this.close();
      return;
    }
    if (!this.busy && this.voicedSinceRun > 0 && this.ms(this.sinceRun) >= this.opts.stepMs) this.step();
  }

  private add(f: Int16Array): void {
    this.chunks.push(f);
    this.length += f.length;
  }

  private snapshot(): Int16Array {
    const out = new Int16Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  private prompt(): string {
    const before = [...this.done, this.placeholder].filter(Boolean).join(' ');
    return before.slice(-PROMPT_CHARS);
  }

  /** Whisper's silence talking: a short burst that is one of its phrases and nothing else. */
  private silencePhrase(text: string, voicedSamples: number): boolean {
    return this.ms(voicedSamples) < SILENCE_PHRASE_MAX_VOICED_MS && SILENCE_PHRASES.test(text.trim());
  }

  private queue(job: () => Promise<void>): void {
    this.running++;
    this.chain = this.chain.then(job).then(
      () => {
        this.running--;
      },
      () => {
        this.running--;
      },
    );
  }

  /** Transcribe the open segment again; settle the words two hypotheses agree on. */
  private step(): void {
    const gen = this.generation;
    const pcm = this.snapshot();
    const voiced = this.voicedSamples;
    this.sinceRun = 0;
    this.voicedSinceRun = 0;
    this.queue(async () => {
      let text: string;
      try {
        text = await this.opts.transcribe(pcm, this.prompt());
      } catch (e) {
        this.opts.onError?.((e as Error).message || String(e));
        return;
      }
      if (gen !== this.generation) return; // the segment closed meanwhile
      if (this.silencePhrase(text, voiced)) text = '';
      const cur = words(text);
      let common = 0;
      while (common < cur.length && common < this.previous.length && norm(cur[common]) === norm(this.previous[common]))
        common++;
      if (common > this.committed.length)
        this.committed = this.committed.concat(cur.slice(this.committed.length, common));
      this.interim = cur.slice(this.committed.length);
      this.previous = cur;
      this.emit();
    });
  }

  /** Close the open segment: transcribe it once more, all of it final; the next segment starts empty. */
  private close(): void {
    const pcm = this.snapshot();
    const voiced = this.voicedSamples;
    const shown = this.committed.concat(this.interim).join(' ');
    const prompt = this.prompt(); // what came before this segment, not its own words
    this.generation++;
    this.chunks = [];
    this.length = 0;
    this.voicedSamples = 0;
    this.silenceRun = 0;
    this.sinceRun = 0;
    this.voicedSinceRun = 0;
    this.committed = [];
    this.previous = [];
    this.interim = [];
    // Until its final transcription is back, what showed of it stays (no flicker).
    this.placeholder = [this.placeholder, shown].filter(Boolean).join(' ');
    const placeholder = shown;
    this.queue(async () => {
      let text = '';
      try {
        text = await this.opts.transcribe(pcm, prompt);
      } catch (e) {
        this.opts.onError?.((e as Error).message || String(e));
        text = placeholder;
      }
      if (this.silencePhrase(text, voiced)) text = '';
      const clean = words(text).join(' ');
      if (clean) this.done.push(clean);
      this.placeholder = this.placeholder.slice(placeholder.length).trim();
      this.emit();
    });
    this.emit();
  }

  private text(): DictationText {
    const final = [...this.done, this.placeholder, ...this.committed].filter(Boolean).join(' ');
    return { final, interim: this.interim.join(' ') };
  }

  private emit(force = false): void {
    const t = this.text();
    const key = t.final + '\u0000' + t.interim;
    if (!force && key === this.lastSent) return;
    if (!t.final && !t.interim && !this.lastSent) return;
    this.lastSent = key;
    this.opts.onText(t);
  }
}
