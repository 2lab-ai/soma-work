/**
 * 서버 위스퍼 live dictation — HTTP surface (epic #737, #739).
 *
 *   GET /api/dictation/status   whether this server can take a live dictation, and with which model
 *   WS  /ws/dictation           one dictation: the browser streams its microphone, the server answers with words
 *
 * The socket (signed in, same origin):
 *   → {"type":"start","lang":"ko-KR"}                     first
 *   → binary frames: 16 kHz mono s16le PCM                 the microphone, as it comes
 *   → {"type":"stop"}                                      finish: the open segment is finalized
 *   ← {"type":"ready","model":"large-v3-turbo"}
 *   ← {"type":"text","final":"…","interim":"…"}            as words settle (DictationStream)
 *   ← {"type":"done","final":"…"}                          after stop; the server closes
 *   ← {"type":"done","final":"…","message":"…"}            at the time limit: finalized, and why it stopped
 *   ← {"type":"error","code":"unavailable"|"busy"|"bad-request"|"failed","message":"…"}   then the server closes
 *
 * Audio is held only while it is transcribed: nothing is written to disk or kept after the socket closes.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DictationStream } from '../a2t/dictation-stream';
import { Logger } from '../logger';

const logger = new Logger('DictationRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void> | void;

/** What the routes need of a Whisper worker. */
export interface DictationWhisper {
  ready(): boolean;
  model(): string;
  /** Why it cannot take a dictation ('' when it can). */
  why(): string;
  /** signal: aborted when the listener is gone — a request still waiting its turn is dropped. */
  transcribe(pcm: Int16Array, opts: { language: string; prompt: string; signal?: AbortSignal }): Promise<string>;
}

/** Live dictations at once on this server (each keeps the worker busy a few times a second). */
export const MAX_DICTATIONS = 4;
/** One dictation's longest run. */
export const MAX_DICTATION_MS = 10 * 60 * 1000;
/** A socket that has not sent start by then lets go of its place. */
export const START_MS = 10 * 1000;
/** A binary frame larger than this is not a microphone chunk. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Audio may run ahead of the clock by this much (a network stall delivers a burst); more is not a microphone. */
export const AHEAD_MS = 10 * 1000;
/** Transcriptions waiting for one dictation: past this the worker cannot keep up with it. */
export const MAX_BACKLOG = 8;

const LANGS: Record<string, string> = { 'ko-KR': 'ko', ko: 'ko', 'en-US': 'en', en: 'en' };
const RATE = 16000;

/** A page of this server, or no browser at all — another site's page cannot open a dictation on the user's cookie. */
export function sameOrigin(headers: Record<string, unknown>, extraHosts: string[] = []): boolean {
  const origin = typeof headers.origin === 'string' ? headers.origin : '';
  if (!origin) return true;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = [headers.host, headers['x-forwarded-host'], ...extraHosts].filter(
    (h): h is string => typeof h === 'string',
  );
  return own.some((h) => h.split(',')[0].trim() === host);
}

export function registerDictationRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  whisper: () => DictationWhisper | null,
  opts: { extraHosts?: () => string[]; startMs?: number; maxMs?: number } = {},
): void {
  let open = 0;
  const startMs = opts.startMs ?? START_MS;
  const maxMs = opts.maxMs ?? MAX_DICTATION_MS;

  server.get('/api/dictation/status', { preHandler: [authMiddleware] }, async () => {
    const w = whisper();
    if (w?.ready()) return { server: { ok: true, model: w.model() } };
    return { server: { ok: false, why: w?.why() || '이 서버에는 위스퍼가 없습니다' } };
  });

  // Registered only where @fastify/websocket is (dashboard.ts registers it).
  if (typeof (server as unknown as { injectWS?: unknown }).injectWS !== 'function') {
    logger.warn('WebSocket support unavailable — live dictation (server Whisper) is off');
    return;
  }

  server.get(
    '/ws/dictation',
    { websocket: true, preHandler: [authMiddleware] } as never,
    ((socket: any, request: any) => {
      let closed = false;
      const send = (msg: object) => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(msg));
        } catch {
          /* closed */
        }
      };
      let holding = false;
      // This socket's place among the MAX_DICTATIONS — given back once, when it hangs up or goes away.
      const letGo = () => {
        if (holding) open--;
        holding = false;
      };
      const hangUp = (code: number, reason: string) => {
        letGo();
        try {
          socket.close(code, reason);
        } catch {
          /* closed */
        }
      };
      const refuse = (code: string, message: string) => {
        send({ type: 'error', code, message });
        hangUp(1008, code);
      };
      if (!sameOrigin(request?.headers ?? {}, opts.extraHosts?.() ?? []))
        return refuse('bad-request', '다른 사이트에서는 받아쓸 수 없습니다');
      const w = whisper();
      if (!w?.ready()) return refuse('unavailable', w?.why() || '이 서버에는 위스퍼가 없습니다');
      if (open >= MAX_DICTATIONS)
        return refuse('busy', '서버 위스퍼가 지금 다른 받아쓰기로 바쁩니다 — 잠시 뒤에 다시 눌러 주세요');
      open++;
      holding = true;

      let stream: DictationStream | null = null;
      let language = 'ko';
      let finishing = false;
      let startedAt = 0;
      let received = 0;
      const gone = new AbortController();
      // Ended with an error: the stream is dropped (what the browser already shows stays there).
      const fail = (code: string, message: string) => {
        stream?.cancel();
        finishing = true;
        refuse(code, message);
      };
      // Finished: the open segment is finalized and every word goes out with done (and why, when it was not asked).
      const finish = async (message = '') => {
        if (finishing || !stream) return;
        finishing = true;
        const out = await stream.finish();
        if (closed) return;
        send(message ? { type: 'done', final: out.final, message } : { type: 'done', final: out.final });
        hangUp(1000, 'done');
      };
      const unstarted = setTimeout(() => {
        if (!stream) fail('bad-request', 'start first');
      }, startMs);
      unstarted.unref?.();
      const limit = setTimeout(() => {
        if (!stream) return fail('bad-request', 'start first');
        void finish('받아쓰기는 한 번에 10분까지입니다 — 다시 누르면 이어서 받아씁니다');
      }, maxMs);
      limit.unref?.();

      const onMessage = (data: Buffer, isBinary: boolean) => {
        if (closed || finishing) return;
        if (!isBinary) {
          let msg: unknown = null;
          try {
            msg = JSON.parse(String(data));
          } catch {
            return fail('bad-request', 'invalid message');
          }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return fail('bad-request', 'invalid message');
          const m = msg as { type?: unknown; lang?: unknown };
          if (m.type === 'start' && !stream) {
            clearTimeout(unstarted);
            language = LANGS[typeof m.lang === 'string' ? m.lang : 'ko-KR'] ?? 'ko';
            startedAt = Date.now();
            stream = new DictationStream({
              transcribe: (pcm, prompt) => w.transcribe(pcm, { language, prompt, signal: gone.signal }),
              onText: (t) => send({ type: 'text', final: t.final, interim: t.interim }),
              onError: (message) => {
                logger.warn('Dictation transcription failed', { message });
                fail('failed', `서버 위스퍼가 받아쓰지 못했습니다 — ${message}`);
              },
            });
            send({ type: 'ready', model: w.model() });
          } else if (m.type === 'stop') {
            void finish();
          }
          return;
        }
        if (!stream) return fail('bad-request', 'start first');
        if (data.length > MAX_FRAME_BYTES || data.length % 2) return fail('bad-request', 'bad audio frame');
        received += data.length / 2;
        if ((received * 1000) / RATE > Date.now() - startedAt + AHEAD_MS)
          return fail('bad-request', 'audio faster than real time');
        // A copy: the frame's buffer is the socket's, and Int16Array wants an aligned offset.
        const pcm = new Int16Array(data.length / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
        stream.push(pcm);
        if (stream.backlog > MAX_BACKLOG)
          fail('busy', '서버 위스퍼가 받아쓰기를 따라가지 못합니다 — 잠시 뒤에 다시 눌러 주세요');
      };
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        try {
          onMessage(data, isBinary);
        } catch (e) {
          logger.warn('Dictation message failed', { message: (e as Error)?.message || String(e) });
          fail('bad-request', 'invalid message');
        }
      });

      socket.on('close', () => {
        closed = true;
        clearTimeout(unstarted);
        clearTimeout(limit);
        // The listener is gone (finishing or not): nothing it queued is transcribed for no one — not the stream's
        // next steps, not a request still waiting its turn at the worker.
        stream?.cancel();
        gone.abort('dictation socket closed');
        letGo();
      });
    }) as never,
  );
}

/** The live-dictation A2T instance as the routes see it. */
export function dictationWhisperFromA2t(
  get: () => import('../a2t/a2t-service').A2tService | null,
  lastError: () => string,
): () => DictationWhisper | null {
  return () => {
    const a = get();
    const status = a?.getStatus();
    return {
      ready: () => !!a?.isReady(),
      model: () => (status && status.state === 'ready' ? status.model : ''),
      why: () => {
        if (a?.isReady()) return '';
        if (a) return `서버 위스퍼를 쓸 수 없습니다 — ${a.getStatusMessage()}`;
        const e = lastError();
        return e ? `서버 위스퍼를 시작하지 못했습니다 — ${e}` : '이 서버에는 위스퍼가 없습니다';
      },
      transcribe: (pcm, o) => {
        if (!a) return Promise.reject(new Error('no whisper'));
        return a.transcribePcm(pcm, o);
      },
    };
  };
}
