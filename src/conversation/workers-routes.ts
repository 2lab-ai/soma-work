/**
 * The settings page 작업 워커 tab's HTTP surface: the work workers — the nodes of the process monitor (ADR 0003) — and
 * the nickname people read for each (`process-monitor/worker-nicknames.ts`).
 *
 *   GET /api/settings/workers                    → { workers: [WorkerRow] }
 *   PUT /api/settings/workers/:nodeId/nickname   { nickname: string | null } → { worker } (null = back to the node id)
 *
 * Today the list is the node this daemon runs on (soma-work's own); a worker node that reports its own snapshot later
 * joins it through the same source. Only an admin signed in with Slack reads it; a change needs admin mode and CSRF
 * (`namedAdmin`). The task cards follow a change on the monitor's next sample (`procSignature` carries the name).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Logger } from '../logger';
import type { NodeProcessSnapshot } from '../process-monitor/types';
import {
  getActiveWorkerNicknames,
  MAX_WORKER_NICKNAME,
  parseWorkerNickname,
} from '../process-monitor/worker-nicknames';
import { namedAdmin } from './secrets-routes';

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const logger = new Logger('WorkersRoutes');

const REFUSAL = {
  read: '작업 워커는 Slack 계정으로 로그인한 관리자만 보고 바꿉니다',
  change: '관리자 모드를 켜야 작업 워커 닉네임을 바꿀 수 있습니다',
};

/** One work worker as the 작업 워커 tab lists it. */
export interface WorkerRow {
  /** The node id — what the monitor and every API name the worker by (the host name by default). */
  nodeId: string;
  /** The admin's nickname, `null` when it has none. */
  nickname: string | null;
  /** The name people read: the nickname, else the node id. */
  name: string;
  /** The node this soma-work daemon runs on. */
  self: boolean;
  platform: string;
  cpuCount: number;
  /** Whole-node CPU in use, 0–100 (`null` before the second sample). */
  cpuBusyPercent: number | null;
  totalMemBytes: number;
  availableMemBytes: number;
  sampledAt: number;
  /** Tasks whose Claude Code runs on the worker now. */
  tasks: number;
  /** Processes of those tasks, plus the daemon's own Claude Code one-shots. */
  processes: number;
}

/** Where the workers come from: the daemon's own node (its process monitor). */
export interface WorkerNodeSource {
  fresh(maxAgeMs?: number): Promise<NodeProcessSnapshot>;
}

let source: WorkerNodeSource | null = null;

/** Wired at boot with the daemon's process monitor (`index.ts`); `null` = no monitor on this instance. */
export function setWorkerNodeSource(next: WorkerNodeSource | null): void {
  source = next;
}

export function workerRowOf(snapshot: NodeProcessSnapshot, self: boolean): WorkerRow {
  const { node } = snapshot;
  const nickname = getActiveWorkerNicknames()?.nicknameOf(node.nodeId) ?? null;
  return {
    nodeId: node.nodeId,
    nickname,
    name: nickname ?? node.nodeId,
    self,
    platform: node.platform,
    cpuCount: node.cpuCount,
    cpuBusyPercent: node.cpuBusyPercent,
    totalMemBytes: node.totalMemBytes,
    availableMemBytes: node.availableMemBytes,
    sampledAt: snapshot.sampledAt,
    tasks: snapshot.sessions.filter((s) => s.rootAlive).length,
    processes: snapshot.sessions.reduce((n, s) => n + s.processCount, 0) + snapshot.unattributed.processCount,
  };
}

async function workerRows(): Promise<WorkerRow[]> {
  if (!source) return [];
  return [workerRowOf(await source.fresh(5_000), true)];
}

export function registerWorkersRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/settings/workers', read, async (request, reply) => {
    if (!namedAdmin(request, reply, false, REFUSAL)) return;
    try {
      reply.send({ workers: await workerRows(), maxNickname: MAX_WORKER_NICKNAME });
    } catch (error) {
      logger.warn('Worker list failed', { error: error instanceof Error ? error.message : String(error) });
      reply.status(500).send({ error: '작업 워커를 읽지 못했습니다' });
    }
  });

  server.put<{ Params: { nodeId: string }; Body: { nickname?: unknown } }>(
    '/api/settings/workers/:nodeId/nickname',
    write,
    async (request, reply) => {
      const admin = namedAdmin(request, reply, true, REFUSAL);
      if (!admin) return;
      const nicknames = getActiveWorkerNicknames();
      if (!nicknames) {
        reply.status(503).send({ error: '작업 워커 닉네임이 꺼져 있습니다 (이 인스턴스에서 시작되지 않음)' });
        return;
      }
      const raw = request.body?.nickname;
      const nickname = raw === null ? undefined : parseWorkerNickname(raw);
      if (raw !== null && nickname === undefined) {
        reply
          .status(400)
          .send({ error: `닉네임은 1~${MAX_WORKER_NICKNAME}자(제어 문자 없이), 또는 null(노드 이름으로)입니다` });
        return;
      }
      let rows: WorkerRow[];
      try {
        rows = await workerRows();
      } catch (error) {
        logger.warn('Worker list failed', { error: error instanceof Error ? error.message : String(error) });
        reply.status(500).send({ error: '작업 워커를 읽지 못했습니다' });
        return;
      }
      // Only a worker the list has: a nickname is for a node people can see, not any string.
      const nodeId = String(request.params.nodeId || '');
      if (!rows.some((row) => row.nodeId === nodeId)) {
        reply.status(404).send({ error: '그런 작업 워커가 없습니다' });
        return;
      }
      try {
        nicknames.set(nodeId, nickname);
      } catch (error) {
        reply.status(500).send({ error: (error as Error)?.message ?? '닉네임을 저장하지 못했습니다' });
        return;
      }
      logger.info('Worker nickname changed', { nodeId, nickname: nickname ?? '(node id)', by: admin });
      const worker = (await workerRows()).find((row) => row.nodeId === nodeId);
      reply.send({ ok: true, worker });
    },
  );
}
