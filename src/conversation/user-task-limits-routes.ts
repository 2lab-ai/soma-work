/**
 * The settings page 작업 큐 tab's HTTP surface: how many tasks (threads) each person may run at once — the per-user
 * task queue's limit (src/user-task-queue). 1 by default, no limit for an admin; an admin turns a person's knob.
 *
 *   GET /api/settings/task-limits          → { max, users: [{ id, name, admin, limit, setting, defaultLimit, running, waiting }] }
 *   PUT /api/settings/task-limits/:userId  { limit: 1..max | 'unlimited' | null }  → { user } (null = back to the default)
 *
 * `limit`/`defaultLimit` are what applies (`null` = no limit); `setting` is the admin's choice (`null` = none).
 * Only an admin signed in with Slack reads it; a change needs admin mode and CSRF (`namedAdmin`). A change starts
 * the person's waiting tasks that may start now.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdminUser } from '../admin-utils';
import { Logger } from '../logger';
import { getActiveUserTaskQueue } from '../user-task-queue/active';
import { MAX_TASK_LIMIT, parseTaskLimitSetting, type TaskLimitSetting } from '../user-task-queue/store';
import { UNLIMITED } from '../user-task-queue/user-task-queue';
import { knownUsers, namedAdmin } from './secrets-routes';

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const logger = new Logger('UserTaskLimitsRoutes');

const REFUSAL = {
  read: '작업 큐 한도는 Slack 계정으로 로그인한 관리자만 보고 바꿉니다',
  change: '관리자 모드를 켜야 작업 큐 한도를 바꿀 수 있습니다',
};

export interface TaskLimitRow {
  id: string;
  name: string;
  admin: boolean;
  /** What applies now (`null` = no limit). */
  limit: number | null;
  /** The admin's setting (`null` = none: the default applies). */
  setting: TaskLimitSetting | null;
  /** The limit with no setting (`null` = no limit). */
  defaultLimit: number | null;
  running: number;
  waiting: number;
}

const asLimit = (n: number): number | null => (n === UNLIMITED ? null : n);

function rowOf(id: string, name: string): TaskLimitRow | null {
  const active = getActiveUserTaskQueue();
  if (!active) return null;
  const view = active.queue.viewFor(id);
  return {
    id,
    name,
    admin: isAdminUser(id),
    limit: asLimit(active.limits.limitFor(id)),
    setting: active.limits.settingFor(id) ?? null,
    defaultLimit: asLimit(active.limits.defaultFor(id)),
    running: view.running.length,
    waiting: view.waiting.filter((w) => w.state === 'waiting').length,
  };
}

export function registerUserTaskLimitsRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/settings/task-limits', read, async (request, reply) => {
    if (!namedAdmin(request, reply, false, REFUSAL)) return;
    if (!getActiveUserTaskQueue()) {
      reply.status(503).send({ error: '작업 큐가 꺼져 있습니다 (이 인스턴스에서 시작되지 않음)' });
      return;
    }
    const users = knownUsers()
      .map((u) => rowOf(u.id, u.name))
      .filter((r): r is TaskLimitRow => r !== null);
    reply.send({ max: MAX_TASK_LIMIT, users });
  });

  server.put<{ Params: { userId: string }; Body: { limit?: unknown } }>(
    '/api/settings/task-limits/:userId',
    write,
    async (request, reply) => {
      const admin = namedAdmin(request, reply, true, REFUSAL);
      if (!admin) return;
      const active = getActiveUserTaskQueue();
      if (!active) {
        reply.status(503).send({ error: '작업 큐가 꺼져 있습니다 (이 인스턴스에서 시작되지 않음)' });
        return;
      }
      const userId = String(request.params.userId || '').trim();
      if (!userId || userId.length > 64) {
        reply.status(400).send({ error: '사용자 id가 필요합니다' });
        return;
      }
      const raw = request.body?.limit;
      const setting = raw === null ? undefined : parseTaskLimitSetting(raw);
      if (raw !== null && setting === undefined) {
        reply.status(400).send({ error: `limit은 1~${MAX_TASK_LIMIT}, 'unlimited', 또는 null(기본값)입니다` });
        return;
      }
      try {
        active.limits.set(userId, setting);
      } catch (error) {
        reply.status(500).send({ error: (error as Error)?.message ?? '한도를 저장하지 못했습니다' });
        return;
      }
      logger.info('Task limit changed', { userId, setting: setting ?? 'default', by: admin });
      active.release(userId);
      const name = knownUsers().find((u) => u.id === userId)?.name ?? userId;
      reply.send({ ok: true, user: rowOf(userId, name) });
    },
  );
}
