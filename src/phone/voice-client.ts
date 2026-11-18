/**
 * Client of the in-house voice service (speech-to-text and streaming text-to-speech) — the ears and the mouth of
 * a phone call (.prd/31-phone-calls-architecture.md §3).
 *
 *   POST {url}/api/stt          multipart: file (WAV), language → { text, ms }
 *   POST {url}/api/tts/stream   JSON { voice, text, model, format: 'pcm' } → chunked PCM16 LE mono
 *                               (`x-soma-voice-sample-rate`, 44 100 Hz for Drama 3)
 */

export interface VoiceConfig {
  /** Base URL of the voice service, e.g. `http://voice-host:9999`. */
  url: string;
  /** Registered voice id or alias. */
  voice: string;
  /** TTS model; only `drama-3` streams. */
  model: string;
  language: string;
  /** Sent as `Authorization: Bearer` when the service has a token. */
  token?: string;
}

export interface Transcription {
  text: string;
  /** Wall time the service reported (or measured here when it did not). */
  ms: number;
}

export interface SpeechStream {
  sampleRate: number;
  /** Time from the request to the response headers. */
  headersMs: number;
  chunks: AsyncIterable<Buffer>;
}

export interface VoiceClient {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<Transcription>;
  speak(text: string, signal?: AbortSignal): Promise<SpeechStream>;
  /**
   * Wake the speech engine: it answers ~0.8 s slower after a few idle seconds (measured: 1.4 s vs 0.6 s to the first
   * byte). A one-word synthesis whose audio is dropped; one at a time, skipped while the host transcribes, given up
   * after a few seconds or when `signal` aborts. Best effort — never throws.
   */
  warm?(signal?: AbortSignal): Promise<void> | void;
}

type FetchLike = typeof fetch;

/** A warm-up the engine has not finished in this long is dropped (the word takes ~0.6 s). */
const WARM_TIMEOUT_MS = 5_000;
/** The engine synthesized for some line this recently: it is awake, a wake-up would only add work. */
const ENGINE_AWAKE_MS = 1_000;
/** A synthesis still open after this long is not counted any more (a stream nobody reads must not block wake-ups). */
const SYNTHESIS_STALE_MS = 30_000;
/**
 * Per voice host, across every line of this process:
 * - transcriptions in flight: a wake-up beside one slows it (measured: STT 0.9 s → 2.5 s), so none starts while one
 *   runs, and a transcription that starts cancels the running wake-up;
 * - syntheses in flight, from request to the end of their stream, and when audio last came out: the engine is busy
 *   or awake then, a wake-up would only add work;
 * - the one wake-up running: a second line joins it.
 */
interface VoiceHost {
  transcribing: number;
  synthesizing: Set<{ at: number }>;
  synthesizedAt: number;
  wakeUp: { done: Promise<void>; abort: AbortController } | null;
}
const hosts = new Map<string, VoiceHost>();

function engineBusy(host: VoiceHost, now: number): boolean {
  for (const s of host.synthesizing) if (now - s.at > SYNTHESIS_STALE_MS) host.synthesizing.delete(s);
  return host.synthesizing.size > 0 || now - host.synthesizedAt < ENGINE_AWAKE_MS;
}

export class VoiceServiceError extends Error {
  constructor(
    readonly stage: 'stt' | 'tts',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceServiceError';
  }
}

export function createVoiceClient(cfg: VoiceConfig, fetchImpl: FetchLike = fetch): VoiceClient {
  const base = cfg.url.replace(/\/+$/, '');
  const auth: Record<string, string> = cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
  const host: VoiceHost = hosts.get(base) ?? {
    transcribing: 0,
    synthesizing: new Set(),
    synthesizedAt: Number.NEGATIVE_INFINITY,
    wakeUp: null,
  };
  hosts.set(base, host);

  return {
    async transcribe(wav, signal) {
      host.wakeUp?.abort.abort('transcription first');
      host.transcribing++;
      try {
        const started = Date.now();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
        form.append('language', cfg.language);
        let res: Response;
        try {
          res = await fetchImpl(`${base}/api/stt`, { method: 'POST', body: form, headers: auth, signal });
        } catch (err) {
          throw new VoiceServiceError('stt', `speech-to-text unreachable: ${(err as Error).message}`);
        }
        if (!res.ok) throw new VoiceServiceError('stt', `speech-to-text answered ${res.status}`);
        const body = (await res.json()) as { text?: unknown; ms?: unknown };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const ms = typeof body.ms === 'number' ? body.ms : Date.now() - started;
        return { text, ms };
      } finally {
        host.transcribing--;
      }
    },

    speak,
    warm(signal) {
      if (host.wakeUp) return host.wakeUp.done; // one per host: a stalled service never piles up wake-ups
      if (host.transcribing > 0) return; // this host is transcribing (any line): a wake-up would slow it
      if (engineBusy(host, Date.now())) return; // synthesizing for some line, or just did: already awake
      const own = new AbortController();
      const done = (async () => {
        const timer = setTimeout(() => own.abort('warm-up timed out'), WARM_TIMEOUT_MS);
        try {
          const s = await speak('네', signal ? AbortSignal.any([signal, own.signal]) : own.signal);
          for await (const _ of s.chunks) {
            // dropped: the request only wakes the engine
          }
        } catch {
          // best effort: the next real sentence pays the cold start instead
        } finally {
          clearTimeout(timer);
          own.abort('warm-up over'); // an error answer's body is not left open
          host.wakeUp = null;
        }
      })();
      host.wakeUp = { done, abort: own };
      return done;
    },
  };

  async function speak(text: string, signal?: AbortSignal): Promise<SpeechStream> {
    const started = Date.now();
    const job = { at: started };
    host.synthesizing.add(job);
    const over = () => host.synthesizing.delete(job);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/api/tts/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ voice: cfg.voice, text, model: cfg.model, format: 'pcm' }),
        signal,
      });
    } catch (err) {
      over();
      throw new VoiceServiceError('tts', `text-to-speech unreachable: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      over();
      throw new VoiceServiceError('tts', `text-to-speech answered ${res.status}`);
    }
    const rate = Number(res.headers.get('x-soma-voice-sample-rate') ?? '44100');
    const reader = res.body.getReader();
    const chunks: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            host.synthesizedAt = Date.now(); // audio came out: the engine is awake
            if (value && value.byteLength) yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          }
        } finally {
          reader.releaseLock();
          over();
        }
      },
    };
    return { sampleRate: Number.isFinite(rate) && rate > 0 ? rate : 44100, headersMs: Date.now() - started, chunks };
  }
}
