/**
 * Cross-instance dashboard aggregator (#814).
 *
 * On a multi-instance host (e.g. `oudwood-dev:33000` + `mac-mini-dev:33001`)
 * a user may open the dashboard on either port and expect to see *all*
 * sessions on the host. This module is the glue between heartbeat
 * discovery (`instance-registry`) and the `/api/dashboard/sessions`
 * handler:
 *
 *   1. Discovery: read `~/.soma/instances/*.json` for sibling instances.
 *   2. Filter:    drop entries whose port *or* pid match self (port reuse
 *                 after a crash can leave a stale record pointing at the
 *                 same pid on a different port).
 *   3. Fan-out:   `GET http://<host>:<port>/api/dashboard/sessions?selfOnly=true`
 *                 with `Authorization: Bearer ${viewerToken}`.
 *                 The forced `selfOnly=true` is the recursion guard —
 *                 siblings must not aggregate their own siblings.
 *   4. Stamp:     each sibling card gets `environment={instanceName, port,
 *                 host}` injected and a composite `key =
 *                 ${instanceName}::${originalKey}` so the client cache is
 *                 collision-proof when two instances coincidentally key on
 *                 the same `channelId:threadTs`.
 *   5. Merge:     concat per column (self first), preserving original
 *                 sort order.
 *
 * Failure mode is graceful: a sibling that 5xxs, times out, or returns
 * malformed JSON is silently skipped (with one warn-log per process so
 * the operator notices but the page still renders self-only data).
 *
 * Lives in its own module — `dashboard.ts` is ~5k lines and its test file
 * is ~1.6k. Mixing aggregation into `dashboard.ts` would force every
 * existing dashboard test through the new code path.
 */

import { Logger } from '../logger';
import { type InstanceRecord, readAllInstances } from './instance-registry';

const logger = new Logger('Aggregator');

/** Same column shape as `KanbanBoard` in `dashboard.ts`, redeclared here
 * so the aggregator does not depend on the dashboard module (and so the
 * dashboard module does not have to export the type just for tests). */
export interface AggregatorBoard {
  working: any[];
  waiting: any[];
  idle: any[];
  closed: any[];
}

export interface InstanceEnvironment {
  instanceName: string;
  port: number;
  host: string;
}

export interface SiblingBoardResult extends InstanceEnvironment {
  /** Raw board returned by the sibling. Cards are *not* yet env-stamped. */
  board: AggregatorBoard;
}

export interface FetchSiblingBoardsOptions {
  selfPort: number;
  selfPid: number;
  /** Shared `CONVERSATION_VIEWER_TOKEN`; when empty, the call short-circuits. */
  viewerToken: string;
  /** Per-call timeout (ms). Default 1500. */
  timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override discovery (tests). */
  discoverFn?: () => Promise<InstanceRecord[]>;
}

let _warnedAboutMissingToken = false;
let _warnedAboutSiblingFailure = false;

/**
 * Test hook — resets the "already warned" flags so each test observes a
 * clean call. Not used in production.
 */
export function __resetWarnFlagForTests(): void {
  _warnedAboutMissingToken = false;
  _warnedAboutSiblingFailure = false;
}

/**
 * Pure decision: should `/api/dashboard/sessions` aggregate or stay self-only?
 *
 * Three inputs decide:
 *   - `selfOnly` query flag from the request (set by the aggregator itself
 *     when fanning out to siblings, or by clients that explicitly opt out)
 *   - `viewerToken` — without it cross-port auth can't succeed
 *   - `siblingCount` — when zero there's nothing to aggregate anyway
 *
 * The function is exported so the handler tests can pin behaviour without
 * round-tripping through `fetchSiblingBoards`.
 */
export function shouldAggregate(args: { selfOnly: boolean; viewerToken: string; siblingCount: number }): boolean {
  if (args.selfOnly) return false;
  if (!args.viewerToken) return false;
  if (args.siblingCount <= 0) return false;
  return true;
}

/**
 * Discover and fetch sibling boards.
 *
 * Returns an array of sibling results — siblings that error out are
 * dropped silently (with one process-lifetime warn log). Callers that
 * need the strict "self-only" path are expected to gate this call via
 * {@link shouldAggregate} first; this function still defends in depth
 * against an empty viewerToken.
 */
export async function fetchSiblingBoards(options: FetchSiblingBoardsOptions): Promise<SiblingBoardResult[]> {
  const {
    selfPort,
    selfPid,
    viewerToken,
    timeoutMs = 1500,
    fetchImpl = fetch,
    discoverFn = readAllInstances,
  } = options;

  if (!viewerToken) {
    if (!_warnedAboutMissingToken) {
      logger.warn(
        'CONVERSATION_VIEWER_TOKEN not set — dashboard cannot fan out to sibling instances. Falling back to self-only.',
      );
      _warnedAboutMissingToken = true;
    }
    return [];
  }

  const all = await discoverFn();
  const siblings = all.filter((r) => r.port !== selfPort && r.pid !== selfPid);
  if (siblings.length === 0) return [];

  const calls = siblings.map(async (sib) => {
    const url = buildSiblingUrl(sib);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${viewerToken}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        warnOnce({ port: sib.port, status: res.status });
        return null;
      }
      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        warnOnce({ port: sib.port, parse: 'failed' });
        return null;
      }
      const board = parsed?.board;
      if (!board || typeof board !== 'object') {
        warnOnce({ port: sib.port, board: 'missing' });
        return null;
      }
      return {
        instanceName: sib.instanceName,
        port: sib.port,
        host: sib.host,
        board: {
          working: Array.isArray(board.working) ? board.working : [],
          waiting: Array.isArray(board.waiting) ? board.waiting : [],
          idle: Array.isArray(board.idle) ? board.idle : [],
          closed: Array.isArray(board.closed) ? board.closed : [],
        },
      } as SiblingBoardResult;
    } catch (err) {
      warnOnce({ port: sib.port, err: (err as Error).message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  });

  const settled = await Promise.allSettled(calls);
  const out: SiblingBoardResult[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value) out.push(s.value);
  }
  return out;
}

function warnOnce(detail: Record<string, unknown>): void {
  if (_warnedAboutSiblingFailure) return;
  logger.warn('Sibling dashboard fetch failed', detail);
  _warnedAboutSiblingFailure = true;
}

function buildSiblingUrl(sib: { host: string; port: number }): string {
  // selfOnly=true is the recursion guard — sibling must answer with its
  // own data, not aggregate further. URL-encoded literally to keep it
  // simple to grep for in logs.
  return `http://${sib.host}:${sib.port}/api/dashboard/sessions?selfOnly=true`;
}

/**
 * Merge self board + sibling boards into one columnar board, stamping
 * env metadata and composite keys on sibling cards as they go past.
 *
 * Self cards are inserted first (matching the spec — "자기 카드 먼저,
 * sibling 다음"). Self cards are *not* re-stamped here; the dashboard
 * `sessionToKanban` already attached the env when constructing the self
 * board, and altering its key now would break the action endpoints.
 */
export function mergeBoards(args: {
  selfBoard: AggregatorBoard;
  selfEnv: InstanceEnvironment;
  siblings: SiblingBoardResult[];
}): AggregatorBoard {
  const out: AggregatorBoard = {
    working: args.selfBoard.working.slice(),
    waiting: args.selfBoard.waiting.slice(),
    idle: args.selfBoard.idle.slice(),
    closed: args.selfBoard.closed.slice(),
  };

  for (const sib of args.siblings) {
    const env: InstanceEnvironment = {
      instanceName: sib.instanceName,
      port: sib.port,
      host: sib.host,
    };
    pushStamped(out.working, sib.board.working, env);
    pushStamped(out.waiting, sib.board.waiting, env);
    pushStamped(out.idle, sib.board.idle, env);
    pushStamped(out.closed, sib.board.closed, env);
  }

  return out;
}

function pushStamped(target: any[], source: any[], env: InstanceEnvironment): void {
  for (const card of source) {
    target.push(stampEnvAndKey(card, env));
  }
}

/**
 * Stamp the env metadata onto a card and rewrite its key into the
 * composite form `${instanceName}::${originalKey}`. Idempotent: a card
 * whose key is already composite (already has `::`) is left alone.
 */
export function stampEnvAndKey<T extends { key?: string; environment?: InstanceEnvironment }>(
  card: T,
  env: InstanceEnvironment,
): T {
  const originalKey = typeof card.key === 'string' ? card.key : '';
  // If the sibling already returned a composite key (e.g. it itself is
  // the front-of-house instance and has stamped its own cards), trust
  // its prefix — but the recursion guard means we never receive that
  // shape from a properly-running sibling.
  const composite =
    originalKey && !originalKey.startsWith(`${env.instanceName}::`)
      ? `${env.instanceName}::${originalKey}`
      : originalKey;
  return {
    ...card,
    key: composite,
    environment: env,
  };
}
