/**
 * Client of the in-house voice service (speech-to-text and streaming text-to-speech) — the ears and the mouth of
 * a phone call (.prd/31-phone-calls-architecture.md §3).
 *
 *   POST {url}/api/stt          multipart: file (WAV), language → { text, ms }
 *   POST {url}/api/tts/stream   JSON { voice, text, model, format: 'pcm' } → chunked PCM16 LE mono
 *                               (`x-soma-voice-sample-rate`, 44 100 Hz for Drama 3)
 *   POST {url}/api/lease        JSON { owner, ttl_ms } → { token } — the host for a whole call, or 409 busy
 *   POST {url}/api/lease/renew  DELETE {url}/api/lease — the token in `x-soma-voice-lease`
 *
 * The host does one job at a time. A call takes it whole ({@link VoiceClient.claim}): its transcriptions and
 * syntheses carry the lease token and run side by side, and nobody else's run until the lease is given back.
 */

import { MAX_STRETCH_RATE, MIN_STRETCH_RATE, TimeStretcher } from './audio';

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
  /** Speech rate (1.5 = 1.5x faster at the same pitch); the service has none, so the client stretches. */
  speed?: number;
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
  /**
   * Take the voice host for one call. `held`: use its `voice` for everything the call does, renew it while the call
   * lasts, release it at the end. `busy`: the host is doing someone else's job, or cannot be reached — the call
   * cannot be served. `shared`: the host has no leases (an older service): the call goes on as before. Never throws.
   */
  claim?(owner: string): Promise<VoiceHostClaim>;
}

export type VoiceHostClaim =
  | { kind: 'held'; voice: VoiceClient; renew(): Promise<boolean>; release(): Promise<void> }
  | { kind: 'busy'; reason: string }
  | { kind: 'shared' };

/** A lease not renewed for this long lapses on the host (the client died mid-call). */
export const LEASE_TTL_MS = 30_000;
/** Lease requests are bounded: a call does not wait on a host that does not answer. */
const LEASE_REQUEST_MS = 3_000;
const LEASE_HEADER = 'x-soma-voice-lease';

type FetchLike = typeof fetch;

/** One transcription attempt is given up after this long (a 6 s utterance takes ~0.8 s), and tried once more. */
const STT_ATTEMPT_MS = 4_000;
const STT_ATTEMPTS = 2;
/** A warm-up the engine has not finished in this long is dropped (the word takes ~0.6 s). */
const WARM_TIMEOUT_MS = 5_000;
/** The engine synthesized for some line this recently: it is awake, a wake-up would only add work. */
const ENGINE_AWAKE_MS = 1_000;
/** A request still open after this long is not counted any more: a stuck or unread one must not block wake-ups. */
const REQUEST_STALE_MS = 30_000;
/**
 * Per voice host, across every line of this process:
 * - transcriptions in flight: a wake-up beside one slows it (measured: STT 0.9 s → 2.5 s), so none starts while one
 *   runs;
 * - syntheses in flight, from request to the end of their stream (or their abort), and when audio last came out: the
 *   engine is busy or awake then, a wake-up would only add work;
 * - the one wake-up running: a second line joins it, and a real transcription or synthesis that starts cancels it.
 */
interface VoiceHost {
  transcribing: Set<{ at: number }>;
  synthesizing: Set<{ at: number }>;
  synthesizedAt: number;
  wakeUp: { done: Promise<void>; abort: AbortController } | null;
}
const hosts = new Map<string, VoiceHost>();

function anyOpen(requests: Set<{ at: number }>, now: number): boolean {
  for (const r of requests) if (now - r.at > REQUEST_STALE_MS) requests.delete(r);
  return requests.size > 0;
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

/** `lease`: the token of a claimed host — every request of this client runs under it. */
export function createVoiceClient(cfg: VoiceConfig, fetchImpl: FetchLike = fetch, lease?: string): VoiceClient {
  const base = cfg.url.replace(/\/+$/, '');
  const auth: Record<string, string> = {
    ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    ...(lease ? { [LEASE_HEADER]: lease } : {}),
  };
  const host: VoiceHost = hosts.get(base) ?? {
    transcribing: new Set(),
    synthesizing: new Set(),
    synthesizedAt: Number.NEGATIVE_INFINITY,
    wakeUp: null,
  };
  hosts.set(base, host);

  return {
    async transcribe(wav, signal) {
      host.wakeUp?.abort.abort('transcription first');
      const job = { at: Date.now() };
      host.transcribing.add(job);
      try {
        const started = Date.now();
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'utterance.wav');
        form.append('language', cfg.language);
        let body: { text?: unknown; ms?: unknown } | undefined;
        // A request that hangs (seen: a connection that took 10 s to fail) loses the caller's words: each attempt —
        // the request and its answer's body — is bounded, and one more is made. An HTTP error is not retried.
        for (let attempt = 1; !body; attempt++) {
          const bound = new AbortController();
          const timer = setTimeout(() => bound.abort(new Error('no answer in time')), STT_ATTEMPT_MS);
          let res: Response;
          try {
            res = await fetchImpl(`${base}/api/stt`, {
              method: 'POST',
              body: form,
              headers: auth,
              signal: signal ? AbortSignal.any([signal, bound.signal]) : bound.signal,
            });
            if (res.ok) body = (await res.json()) as { text?: unknown; ms?: unknown };
          } catch (err) {
            if (signal?.aborted || attempt >= STT_ATTEMPTS)
              throw new VoiceServiceError('stt', `speech-to-text unreachable: ${(err as Error).message}`);
            continue;
          } finally {
            clearTimeout(timer);
          }
          if (!res.ok) throw new VoiceServiceError('stt', `speech-to-text answered ${res.status}`);
        }
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const ms = typeof body.ms === 'number' ? body.ms : Date.now() - started;
        return { text, ms };
      } finally {
        host.transcribing.delete(job);
      }
    },

    speak: (text, signal) => synthesize(text, signal, false),

    async claim(owner) {
      const bounded = () => AbortSignal.timeout(LEASE_REQUEST_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${base}/api/lease`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth },
          body: JSON.stringify({ owner, ttl_ms: LEASE_TTL_MS }),
          signal: bounded(),
        });
      } catch (err) {
        return { kind: 'busy', reason: `voice host unreachable: ${(err as Error).message}` };
      }
      if (res.status === 404) return { kind: 'shared' };
      const body = (await res.json().catch(() => ({}))) as { token?: unknown; holder?: unknown };
      if (res.status === 409)
        return { kind: 'busy', reason: typeof body.holder === 'string' ? `busy with ${body.holder}` : 'busy' };
      if (!res.ok) return { kind: 'busy', reason: `voice host answered ${res.status}` };
      if (typeof body.token !== 'string' || !body.token) return { kind: 'busy', reason: 'lease without a token' };
      const token = body.token;
      const leased = { ...auth, [LEASE_HEADER]: token };
      return {
        kind: 'held',
        voice: createVoiceClient(cfg, fetchImpl, token),
        async renew() {
          try {
            const r = await fetchImpl(`${base}/api/lease/renew`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...leased },
              body: JSON.stringify({ ttl_ms: LEASE_TTL_MS }),
              signal: bounded(),
            });
            return r.ok;
          } catch {
            return false;
          }
        },
        async release() {
          try {
            await fetchImpl(`${base}/api/lease`, { method: 'DELETE', headers: leased, signal: bounded() });
          } catch {
            // Not given back: it lapses on the host within LEASE_TTL_MS.
          }
        },
      };
    },
    warm(signal) {
      if (host.wakeUp) return host.wakeUp.done; // one per host: a stalled service never piles up wake-ups
      const now = Date.now();
      if (anyOpen(host.transcribing, now)) return; // this host is transcribing (any line): a wake-up would slow it
      // Synthesizing for some line, or just did: already awake.
      if (anyOpen(host.synthesizing, now) || now - host.synthesizedAt < ENGINE_AWAKE_MS) return;
      const own = new AbortController();
      const done = (async () => {
        const timer = setTimeout(() => own.abort('warm-up timed out'), WARM_TIMEOUT_MS);
        try {
          const s = await synthesize('네', signal ? AbortSignal.any([signal, own.signal]) : own.signal, true);
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

  async function synthesize(text: string, signal: AbortSignal | undefined, wakeUp: boolean): Promise<SpeechStream> {
    if (!wakeUp) host.wakeUp?.abort.abort('speech first'); // a reply never waits behind a wake-up
    const started = Date.now();
    const job = { at: started };
    host.synthesizing.add(job);
    // Over at the end of the stream, an error, or an abort (also one before anybody reads the stream).
    const over = () => {
      host.synthesizing.delete(job);
      signal?.removeEventListener('abort', over);
    };
    signal?.addEventListener('abort', over, { once: true });
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
    const sampleRate = Number.isFinite(rate) && rate > 0 ? rate : 44100;
    // A rate the stretcher cannot work at (a malformed header) plays at the service's own speed.
    const stretchable = sampleRate >= MIN_STRETCH_RATE && sampleRate <= MAX_STRETCH_RATE;
    const stretch = cfg.speed && cfg.speed !== 1 && stretchable ? new TimeStretcher(sampleRate, cfg.speed) : null;
    const chunks: AsyncIterable<Buffer> = {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            host.synthesizedAt = Date.now(); // audio came out: the engine is awake
            if (!value?.byteLength) continue;
            const pcm = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            const out = stretch ? stretch.push(pcm) : pcm;
            if (out.length) yield out;
          }
          const rest = stretch?.flush();
          if (rest?.length) yield rest;
        } finally {
          reader.releaseLock();
          over();
        }
      },
    };
    return { sampleRate, headersMs: Date.now() - started, chunks };
  }
}
