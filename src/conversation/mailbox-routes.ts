/**
 * The agent mailbox's main session (대표 세션) for the dashboard — an admin reads which session takes this instance's
 * general mail and points it at another session (src/mailbox/main-session.ts). Admin signed in with Slack; a change
 * needs admin mode and CSRF, the same gate as the 비밀 tab (`namedAdmin`).
 *
 *   GET    /api/mailbox/main-session            → { address, main: { key, channel, threadTs, mailAddress, setAt, setBy } | null }
 *   PUT    /api/mailbox/main-session  {key}     → the same, after recording the session as the main session
 *   DELETE /api/mailbox/main-session            → main: null (the next general mail opens a new one)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DATA_DIR } from '../env-paths';
import { createMainSessionStore, type MainSessionRecord, targetFromSessionKey } from '../mailbox/main-session';
import { getMailboxIdentity, sessionMailAddress } from '../mailbox/session-address';
import { namedAdmin } from './secrets-routes';

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const REFUSAL = {
  read: '메인 세션은 Slack 계정으로 로그인한 관리자만 보고 바꿉니다',
  change: '관리자 모드를 켜야 메인 세션을 바꿀 수 있습니다',
};

let _dataDir: string | null = null;

/** Tests: where the main-session record lives. */
export function setMailboxRoutesDataDirForTests(dir: string | null): void {
  _dataDir = dir;
}

function view(record: MainSessionRecord | undefined) {
  return {
    address: getMailboxIdentity()?.address ?? null,
    main: record
      ? {
          key: `${record.channel}-${record.threadTs}`,
          channel: record.channel,
          threadTs: record.threadTs,
          mailAddress: sessionMailAddress(record.channel, record.threadTs) ?? null,
          setAt: record.setAt,
          setBy: record.setBy,
        }
      : null,
  };
}

export function registerMailboxRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };
  const store = () => createMainSessionStore(_dataDir ?? DATA_DIR);

  server.get('/api/mailbox/main-session', read, async (request, reply) => {
    if (!namedAdmin(request, reply, false, REFUSAL)) return;
    reply.send(view(store().get()));
  });

  server.put<{ Body: { key?: unknown } }>('/api/mailbox/main-session', write, async (request, reply) => {
    const admin = namedAdmin(request, reply, true, REFUSAL);
    if (!admin) return;
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    const target = targetFromSessionKey(key);
    if (!target) {
      reply.status(400).send({ error: '메인 세션은 Slack 스레드 세션이어야 합니다 (key = <channel>-<threadTs>)' });
      return;
    }
    reply.send(view(store().set(target, admin)));
  });

  server.delete('/api/mailbox/main-session', write, async (request, reply) => {
    if (!namedAdmin(request, reply, true, REFUSAL)) return;
    store().clear();
    reply.send(view(undefined));
  });
}
