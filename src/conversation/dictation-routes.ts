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
 *   ← {"type":"error","code":"unavailable"|"busy"|"bad-request"|"too-long","message":"…"}
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
  transcribe(pcm: Int16Array, opts: { language: string; prompt: string }): Promise<string>;
}

/** Live dictations at once on this server (each keeps the worker busy a few times a second). */
export const MAX_DICTATIONS = 4;
/** One dictation's longest run. */
export const MAX_DICTATION_MS = 10 * 60 * 1000;
/** A binary frame larger than this is not a microphone chunk. */
export const MAX_FRAME_BYTES = 64 * 1024;

const LANGS: Record<string, string> = { 'ko-KR': 'ko', ko: 'ko', 'en-US': 'en', en: 'en' };

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
  const own = [headers.host, headers['x-forwarded-host'], ...extraHosts].filter((h): h is string => typeof h === 'string');
  return own.some((h) => h.split(',')[0].trim() === host);
}

export function registerDictationRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  whisper: () => DictationWhisper | null,
  opts: { extraHosts?: () => string[] } = {},
): void {
  let open = 0;

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

  server.get('/ws/dictation', { websocket: true, preHandler: [authMiddleware] } as never, ((socket: any, request: any) => {
    const send = (msg: object) => {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* closed */
      }
    };
    const refuse = (code: string, message: string) => {
      send({ type: 'error', code, message });
      try {
        socket.close(1008, code);
      } catch {
        /* closed */
      }
    };
    if (!sameOrigin(request?.headers ?? {}, opts.extraHosts?.() ?? [])) return refuse('bad-request', '다른 사이트에서는 받아쓸 수 없습니다');
    const w = whisper();
    if (!w?.ready()) return refuse('unavailable', w?.why() || '이 서버에는 위스퍼가 없습니다');
    if (open >= MAX_DICTATIONS) return refuse('busy', '서버 위스퍼가 지금 다른 받아쓰기로 바쁩니다 — 잠시 뒤에 다시 눌러 주세요');
    open++;

    let stream: DictationStream | null = null;
    let language = 'ko';
    let closed = false;
    let finishing = false;
    const limit = setTimeout(() => {
      send({ type: 'error', code: 'too-long', message: '받아쓰기는 한 번에 10분까지입니다 — 다시 누르면 이어서 받아씁니다' });
      void finish();
    }, MAX_DICTATION_MS);
    limit.unref?.();

    const finish = async () => {
      if (finishing || !stream) return;
      finishing = true;
      const out = await stream.finish();
      if (!closed) {
        send({ type: 'done', final: out.final });
        try {
          socket.close(1000, 'done');
        } catch {
          /* closed */
        }
      }
    };

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (closed || finishing) return;
      if (!isBinary) {
        let msg: { type?: string; lang?: string } = {};
        try {
          msg = JSON.parse(String(data));
        } catch {
          return refuse('bad-request', 'invalid message');
        }
        if (msg.type === 'start' && !stream) {
          language = LANGS[String(msg.lang || 'ko-KR')] ?? 'ko';
          stream = new DictationStream({
            transcribe: (pcm, prompt) => w.transcribe(pcm, { language, prompt }),
            onText: (t) => {
              if (!closed) send({ type: 'text', final: t.final, interim: t.interim });
            },
            onError: (message) => logger.warn('Dictation transcription failed', { message }),
          });
          send({ type: 'ready', model: w.model() });
        } else if (msg.type === 'stop') {
          void finish();
        }
        return;
      }
      if (!stream) return refuse('bad-request', 'start first');
      if (data.length > MAX_FRAME_BYTES || data.length % 2) return refuse('bad-request', 'bad audio frame');
      // A copy: the frame's buffer is the socket's, and Int16Array wants an aligned offset.
      const pcm = new Int16Array(data.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2);
      stream.push(pcm);
    });

    socket.on('close', () => {
      closed = true;
      clearTimeout(limit);
      open--;
    });
  }) as never);
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
