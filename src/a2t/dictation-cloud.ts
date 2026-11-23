/**
 * Cloud & streaming STT backends for server-side live dictation (`/ws/dictation`).
 *
 * Supports:
 *   1. Deepgram Nova-3 WebSocket streaming (`provider: 'deepgram'` or `SOMA_DICTATION_PROVIDER=deepgram` + `DEEPGRAM_API_KEY`):
 *      True streaming ASR with sub-300ms endpointing, interim results, multilingual Korean+English
 *      code-switching, and developer keyterm biasing (`keyterm` query params, `KeepAlive` / `CloseStream`) —
 *      matching Claude Code's streaming STT architecture.
 *   2. OpenAI / OpenAI-compatible HTTP transcription (`provider: 'openai'` or `SOMA_DICTATION_PROVIDER=openai` + `OPENAI_API_KEY`):
 *      Uses `gpt-4o-transcribe` (or custom model/endpoint such as Groq `whisper-large-v3`) via
 *      `POST /v1/audio/transcriptions` with developer keyterms as `prompt`, driven by `DictationStream`.
 *
 * Privacy default: under `provider: 'auto'` (the default), audio stays on the local Whisper worker unless
 * cloud STT is explicitly opted into (`provider: 'deepgram' | 'openai' | 'auto-cloud'` or `SOMA_DICTATION_PROVIDER`).
 */

import WebSocket from 'ws';
import { Logger } from '../logger';
import { DEFAULT_DICTATION_KEYTERMS, mergeDictationKeyterms, normalizeKeyterms } from './dictation-keyterms';
import type { DictationText } from './dictation-stream';
import type { A2tDictationConfig } from './types';

const logger = new Logger('DictationCloud');

export interface DictationStreamingCallbacks {
  onReady: (model: string) => void;
  onText: (text: DictationText) => void;
  onDone: (final: string) => void;
  onError: (message: string) => void;
}

export interface DictationStreamingSession {
  push(pcm: Int16Array): void;
  finish(): Promise<void>;
  cancel(): void;
  readonly backlog: number;
}

export interface DictationBackend {
  ready(): boolean;
  model(): string;
  why(): string;
  /** Optional provider label ('deepgram' | 'openai' | 'local'). */
  provider?: string;
  /** Default server-configured keyterms merged with built-ins and client keyterms. */
  keyterms?: readonly string[];
  transcribe(
    pcm: Int16Array,
    opts: { language: string; prompt: string; final?: boolean; signal?: AbortSignal },
  ): Promise<string>;
  /**
   * Optional native streaming session (bypasses chunked Whisper re-transcription when the backend supports
   * real-time audio streaming, e.g. Deepgram Nova-3).
   */
  createStreamingSession?: (
    opts: { language: string; keyterms: readonly string[] },
    cb: DictationStreamingCallbacks,
  ) => DictationStreamingSession;
}

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';

function redactLogSnippet(raw: string, maxLen = 120): string {
  return raw.replace(/\b(sk-[A-Za-z0-9_-]+|Bearer\s+\S+|Token\s+\S+)/gi, '<REDACTED>').slice(0, maxLen);
}
const DEEPGRAM_CONNECT_TIMEOUT_MS = 10_000;
const DEEPGRAM_KEEPALIVE_MS = 8_000;
const DEEPGRAM_FINALIZE_TIMEOUT_MS = 5_000;
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_REQUEST_TIMEOUT_MS = 20_000;

/** Encode 16 kHz mono s16le PCM into an in-memory RIFF WAV buffer. */
export function encodePcm16Wav(pcm: Int16Array, sampleRate = 16000): Buffer {
  const dataBytes = pcm.byteLength;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

/** Build the Deepgram Nova-3 streaming WebSocket URL with keyterm biasing. */
export function buildDeepgramUrl(opts: {
  baseUrl?: string;
  model: string;
  language: string;
  keyterms: readonly string[];
}): string {
  const base = (opts.baseUrl || DEEPGRAM_WS_URL).replace(/\/$/, '');
  const params = new URLSearchParams({
    model: opts.model,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    // Nova-3 `multi` supports seamless Korean+English code-switching; explicit non-ko/en keeps requested code.
    language: opts.language === 'ko' && opts.model.startsWith('nova-3') ? 'multi' : opts.language || 'multi',
  });
  const keyterms = normalizeKeyterms(opts.keyterms, { maxChars: 1024, maxCount: 60, asciiOnly: true });
  for (const term of keyterms) {
    params.append('keyterm', term);
  }
  return `${base}?${params.toString()}`;
}

export interface DeepgramBackendOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  keyterms?: readonly string[];
  connectTimeoutMs?: number;
  finalizeTimeoutMs?: number;
  wsFactory?: (url: string, opts: { headers: Record<string, string> }) => WebSocket;
}

/** Create a Deepgram Nova-3 streaming dictation backend. */
export function createDeepgramDictationBackend(opts: DeepgramBackendOptions): DictationBackend {
  const model = opts.model || 'nova-3';
  const serverKeyterms = opts.keyterms ?? [];
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEEPGRAM_CONNECT_TIMEOUT_MS;
  const finalizeTimeoutMs = opts.finalizeTimeoutMs ?? DEEPGRAM_FINALIZE_TIMEOUT_MS;
  const wsFactory = opts.wsFactory ?? ((url, o) => new WebSocket(url, o));

  return {
    provider: 'deepgram',
    keyterms: serverKeyterms,
    ready: () => opts.apiKey.trim().length > 0,
    model: () => `deepgram/${model}`,
    why: () => (opts.apiKey.trim().length > 0 ? '' : 'DEEPGRAM_API_KEY가 설정되지 않았습니다'),
    transcribe: async () => {
      throw new Error('Deepgram backend uses native streaming');
    },
    createStreamingSession(sessionOpts, cb) {
      const merged = mergeDictationKeyterms(sessionOpts.keyterms, serverKeyterms, DEFAULT_DICTATION_KEYTERMS);
      const url = buildDeepgramUrl({
        baseUrl: opts.baseUrl,
        model,
        language: sessionOpts.language,
        keyterms: merged,
      });

      const ws = wsFactory(url, {
        headers: { Authorization: `Token ${opts.apiKey.trim()}` },
      });

      let closed = false;
      let readySent = false;
      let finishing = false;
      let settledParts: string[] = [];
      let interim = '';
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
      let finishTimer: ReturnType<typeof setTimeout> | null = null;
      let finishResolve: (() => void) | null = null;
      const pendingFrames: Buffer[] = [];

      const joinFinal = () => settledParts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const emit = () => {
        if (closed) return;
        cb.onText({ final: joinFinal(), interim });
      };
      const cleanupTimers = () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        if (finishTimer) {
          clearTimeout(finishTimer);
          finishTimer = null;
        }
      };
      const closeUpstream = (code: number, reason: string) => {
        try {
          if (ws.readyState === WebSocket.CONNECTING) {
            if (typeof ws.terminate === 'function') ws.terminate();
            else ws.close();
          } else if (ws.readyState === WebSocket.OPEN) {
            ws.close(code, reason);
          }
        } catch {
          /* ignore */
        }
      };
      const failSession = (message: string) => {
        if (closed) return;
        closed = true;
        finishing = true;
        cleanupTimers();
        closeUpstream(1011, 'error');
        cb.onError(message);
        finishResolve?.();
        finishResolve = null;
      };
      const safeSend = (payload: string | Buffer): boolean => {
        if (closed || ws.readyState !== WebSocket.OPEN) return false;
        try {
          ws.send(payload);
          return true;
        } catch (err) {
          failSession((err as Error)?.message || 'Deepgram send failed');
          return false;
        }
      };
      const completeFinish = () => {
        if (closed) return;
        closed = true;
        cleanupTimers();
        if (interim.trim()) {
          settledParts.push(interim.trim());
          interim = '';
        }
        const finalText = joinFinal();
        closeUpstream(1000, 'done');
        cb.onDone(finalText);
        finishResolve?.();
        finishResolve = null;
      };

      connectTimer = setTimeout(() => {
        if (!readySent && !closed) {
          failSession('Deepgram 연결 시간이 초과되었습니다');
        }
      }, connectTimeoutMs);
      connectTimer.unref?.();

      ws.on('open', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (closed) {
          closeUpstream(1000, 'closed');
          return;
        }
        readySent = true;
        cb.onReady(`deepgram/${model}`);
        for (const frame of pendingFrames.splice(0)) {
          if (!safeSend(frame)) return;
        }
        if (finishing) {
          if (!safeSend(JSON.stringify({ type: 'CloseStream' }))) completeFinish();
          return;
        }
        keepAliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN && !finishing && !closed) {
            safeSend(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, DEEPGRAM_KEEPALIVE_MS);
        keepAliveTimer.unref?.();
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        if (closed) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.type === 'Results') {
          const channel = msg.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
          const transcript = String(channel?.alternatives?.[0]?.transcript || '').trim();
          const isFinal = Boolean(msg.is_final);
          if (isFinal) {
            if (transcript) settledParts.push(transcript);
            interim = '';
            emit();
          } else if (transcript !== interim) {
            interim = transcript;
            emit();
          }
        } else if (msg.type === 'UtteranceEnd') {
          if (interim.trim()) {
            settledParts.push(interim.trim());
            interim = '';
            emit();
          }
        } else if (msg.type === 'Metadata' && finishing) {
          // Deepgram emits Metadata once all buffered audio after CloseStream has been finalized.
          completeFinish();
        } else if (msg.type === 'Error' || msg.error) {
          const errText = String(msg.description || msg.message || msg.error || 'Deepgram transcription error');
          logger.warn('Deepgram error frame', { message: redactLogSnippet(errText, 160) });
          failSession('Deepgram 음성 인식 중 오류가 발생했습니다');
        }
      });

      ws.on('error', (err: Error) => {
        logger.warn('Deepgram WebSocket error', { message: err.message });
        failSession('Deepgram 연결 오류가 발생했습니다');
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (closed) return;
        if (finishing) {
          completeFinish();
          return;
        }
        const reasonStr = String(reason || '').trim();
        logger.warn('Deepgram WebSocket closed unexpectedly', { code, reason: reasonStr.slice(0, 120) });
        failSession(
          readySent ? `Deepgram 연결이 끊겼습니다 (code ${code})` : `Deepgram에 연결하지 못했습니다 (code ${code})`,
        );
      });

      return {
        get backlog() {
          return 0;
        },
        push(pcm: Int16Array) {
          if (closed || finishing) return;
          const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
          if (ws.readyState === WebSocket.OPEN) {
            safeSend(buf);
          } else if (ws.readyState === WebSocket.CONNECTING && pendingFrames.length < 100) {
            pendingFrames.push(Buffer.from(buf));
          }
        },
        finish() {
          if (closed || finishing) return Promise.resolve();
          finishing = true;
          return new Promise<void>((resolve) => {
            finishResolve = resolve;
            if (ws.readyState === WebSocket.OPEN) {
              if (!safeSend(JSON.stringify({ type: 'CloseStream' }))) {
                completeFinish();
                return;
              }
            } else if (ws.readyState !== WebSocket.CONNECTING) {
              completeFinish();
              return;
            }
            // Wait for Deepgram's post-CloseStream Metadata or close event, bounded by finalizeTimeoutMs.
            finishTimer = setTimeout(() => completeFinish(), finalizeTimeoutMs);
            finishTimer.unref?.();
          });
        },
        cancel() {
          if (closed) return;
          closed = true;
          finishing = true;
          settledParts = [];
          interim = '';
          cleanupTimers();
          closeUpstream(1000, 'cancelled');
          finishResolve?.();
          finishResolve = null;
        },
      };
    },
  };
}

export interface OpenAiBackendOptions {
  apiKey: string;
  model?: string;
  apiUrl?: string;
  keyterms?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Create an OpenAI / OpenAI-compatible (e.g. `gpt-4o-transcribe`, Groq `whisper-large-v3`) dictation backend. */
export function createOpenAiDictationBackend(opts: OpenAiBackendOptions): DictationBackend {
  const model = opts.model || 'gpt-4o-transcribe';
  const apiUrl = opts.apiUrl || OPENAI_TRANSCRIPTIONS_URL;
  const timeoutMs = opts.timeoutMs ?? OPENAI_REQUEST_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    provider: 'openai',
    keyterms: opts.keyterms ?? [],
    ready: () => opts.apiKey.trim().length > 0,
    model: () => `openai/${model}`,
    why: () => (opts.apiKey.trim().length > 0 ? '' : 'OPENAI_API_KEY가 설정되지 않았습니다'),
    async transcribe(pcm, o) {
      const wav = encodePcm16Wav(pcm, 16000);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav');
      form.append('model', model);
      if (o.language) form.append('language', o.language);
      if (o.prompt) form.append('prompt', o.prompt);
      form.append('response_format', 'json');

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = o.signal ? AbortSignal.any([o.signal, timeoutSignal]) : timeoutSignal;

      const res = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey.trim()}` },
        body: form,
        signal,
      });
      if (!res.ok) {
        // Log details server-side only (never raw 401/403 bodies or token fragments); never forward raw body to browser.
        const body = res.status === 401 || res.status === 403 ? '' : await res.text().catch(() => '');
        logger.warn('Cloud STT API error', {
          status: res.status,
          ...(body ? { snippet: redactLogSnippet(body, 120) } : {}),
        });
        throw new Error(`STT API 요청 실패 (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { text?: unknown };
      return String(data.text || '').trim();
    },
  };
}

function disabledBackend(why: string, provider?: string): DictationBackend {
  return {
    ...(provider ? { provider } : {}),
    ready: () => false,
    model: () => '',
    why: () => why,
    transcribe: async () => {
      throw new Error(why);
    },
  };
}

/**
 * Resolve the active server dictation backend based on config + environment + local A2T readiness.
 *
 * Privacy-preserving defaults:
 *   - `'auto'` (default): uses the local Whisper worker only (audio stays on this server).
 *   - `'auto-cloud'` (explicit opt-in via `config.provider` or `SOMA_DICTATION_PROVIDER=auto-cloud`):
 *     Deepgram Nova-3 (if `DEEPGRAM_API_KEY`) → local Whisper (if ready) → OpenAI (if `OPENAI_API_KEY`) → Groq (if `GROQ_API_KEY`).
 *   - `'deepgram'` / `'openai'` / `'local'`: explicitly forces that provider.
 */
export function resolveDictationBackend(opts: {
  config?: A2tDictationConfig;
  a2tEnabled?: boolean;
  local: () => DictationBackend | null;
  env?: NodeJS.ProcessEnv;
}): () => DictationBackend | null {
  const env = opts.env ?? process.env;
  const cfg = opts.config ?? {};
  const envProvider = env.SOMA_DICTATION_PROVIDER as A2tDictationConfig['provider'] | undefined;
  const provider = cfg.provider ?? envProvider ?? 'auto';
  const serverKeyterms = cfg.keyterms ?? [];

  const deepgramKey = (provider === 'deepgram' ? cfg.apiKey?.trim() : '') || (env.DEEPGRAM_API_KEY || '').trim();
  const openaiKey = (provider === 'openai' ? cfg.apiKey?.trim() : '') || (env.OPENAI_API_KEY || '').trim();
  const groqKey = (env.GROQ_API_KEY || '').trim();

  const deepgramBackend = deepgramKey
    ? createDeepgramDictationBackend({
        apiKey: deepgramKey,
        model: provider === 'deepgram' ? cfg.model || 'nova-3' : env.SOMA_DICTATION_MODEL || 'nova-3',
        baseUrl: provider === 'deepgram' ? cfg.apiUrl : undefined,
        keyterms: serverKeyterms,
      })
    : null;

  const openaiBackend = openaiKey
    ? createOpenAiDictationBackend({
        apiKey: openaiKey,
        model:
          provider === 'openai' ? cfg.model || 'gpt-4o-transcribe' : env.SOMA_DICTATION_MODEL || 'gpt-4o-transcribe',
        apiUrl: provider === 'openai' ? cfg.apiUrl || env.SOMA_DICTATION_API_URL : env.SOMA_DICTATION_API_URL,
        keyterms: serverKeyterms,
      })
    : null;

  const groqBackend = groqKey
    ? createOpenAiDictationBackend({
        apiKey: groqKey,
        model: env.SOMA_DICTATION_MODEL || 'whisper-large-v3',
        apiUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
        keyterms: serverKeyterms,
      })
    : null;

  return () => {
    if (opts.a2tEnabled === false || cfg.enabled === false) {
      return disabledBackend('서버 받아쓰기가 설정에서 꺼져 있습니다');
    }
    if (provider === 'deepgram') {
      return deepgramBackend ?? disabledBackend('DEEPGRAM_API_KEY가 설정되지 않았습니다', 'deepgram');
    }
    if (provider === 'openai') {
      return openaiBackend ?? disabledBackend('OPENAI_API_KEY가 설정되지 않았습니다', 'openai');
    }
    if (provider === 'auto-cloud') {
      if (deepgramBackend?.ready()) return deepgramBackend;
      const local = opts.local();
      if (local?.ready()) {
        if (serverKeyterms.length) local.keyterms = serverKeyterms;
        return local;
      }
      if (openaiBackend?.ready()) return openaiBackend;
      if (groqBackend?.ready()) return groqBackend;
      return local;
    }

    // provider === 'auto' or 'local': keep audio on this server's local Whisper worker.
    const local = opts.local();
    if (local && serverKeyterms.length) local.keyterms = serverKeyterms;
    return local;
  };
}
