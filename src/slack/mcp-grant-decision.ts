/**
 * MCP tool access requests (`mcp-tool-permission` → `request_permission`) as
 * ONE decision with two surfaces — the admins' Slack DM buttons and the
 * dashboard's admin approvals (#621).
 *
 * The request lives in the shared file store, written by the MCP child that
 * waits for the answer. {@link decideMcpGrant} is the only way it is answered:
 *
 *   - only an admin, only a live MCP grant request, at most once — the atomic
 *     store claim is taken before any side effect (two admins, or Slack and
 *     the dashboard, at the same moment: one wins);
 *   - the grant's server, level and duration come from the stored request,
 *     never from a button payload;
 *   - every admin's DM copy is rewritten with the outcome.
 *
 * Who answered and how is kept in memory for the dashboard's resolved row
 * (the store record is removed by the MCP child once it reads the answer).
 */

import * as path from 'node:path';
import {
  MCP_GRANT_KIND,
  PERMISSION_PROMPT_KIND,
  type PendingApproval,
  type PermissionResponse,
  sharedStore,
} from 'somalib/permission/shared-store';
import type { AdminApproval, AdminApprovalAdapter, AdminApprovalResolution } from '../admin-approvals';
import { notifyAdminApprovalsChanged } from '../admin-approvals';
import { isAdminUser } from '../admin-utils';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import {
  type GrantEntry,
  MAX_GRANT_DURATION_MS,
  mcpToolGrantStore,
  type PermissionLevel,
  parseDuration,
} from '../mcp-tool-grant-store';

const logger = new Logger('McpGrantDecision');

export type McpGrantDecision = 'approve' | 'deny';

export type McpGrantAnswer =
  | { ok: true; outcome: 'approved' | 'denied'; text: string }
  | { ok: false; reason: 'not_found' | 'not_admin' | 'already_answered' | 'invalid'; message: string };

export interface DecideMcpGrantArgs {
  requestId: string;
  decision: McpGrantDecision;
  actor: string | undefined;
  via: 'slack' | 'dashboard';
  /** Rewrite one admin DM copy (production: `chat.update`). */
  updateDm?: (ref: { channel: string; ts: string }, text: string) => Promise<unknown>;
  now?: number;
}

/** True for a record mcp-tool-permission wrote (older records carry no kind). */
export function isMcpGrantRecord(p: PendingApproval | null | undefined): p is PendingApproval {
  if (!p) return false;
  if (p.kind === MCP_GRANT_KIND) return true;
  return p.kind !== PERMISSION_PROMPT_KIND && p.tool_name === 'request_permission';
}

/**
 * Whether this instance owns the record. The store is shared by every
 * instance on the host (os.tmpdir()). The dashboard (`strict`) sees only
 * records its own child stamped; a Slack click — which only ever reaches the
 * instance that posted the button — also accepts a record from a child that
 * predates the stamp.
 */
export function isOwnMcpGrantRecord(p: PendingApproval, strict: boolean): boolean {
  if (!p.owner) return !strict;
  return path.resolve(p.owner) === path.resolve(DATA_DIR);
}

const resolutions = new Map<string, AdminApprovalResolution>();
const RESOLUTION_KEEP_MS = 60 * 60 * 1000;

function remember(requestId: string, resolution: AdminApprovalResolution): void {
  resolutions.set(requestId, resolution);
  const cutoff = resolution.at - RESOLUTION_KEEP_MS;
  for (const [id, r] of resolutions) if (r.at < cutoff) resolutions.delete(id);
}

/** Tests: forget the in-memory resolutions. */
export function clearMcpGrantResolutions(): void {
  resolutions.clear();
}

export async function decideMcpGrant(args: DecideMcpGrantArgs): Promise<McpGrantAnswer> {
  const { requestId, decision, actor, via } = args;
  const pending = await sharedStore.getPendingApproval(requestId);
  if (!isMcpGrantRecord(pending) || !isOwnMcpGrantRecord(pending, via === 'dashboard')) {
    return { ok: false, reason: 'not_found', message: '⚠️ 만료되었거나 더 이상 유효하지 않은 MCP 권한 요청입니다.' };
  }
  if (!actor || !isAdminUser(actor)) {
    return { ok: false, reason: 'not_admin', message: '❌ Only admin users can answer permission requests.' };
  }
  const now = args.now ?? Date.now();
  if (Number(pending.expires_at) <= now) {
    return { ok: false, reason: 'not_found', message: '⚠️ 이 MCP 권한 요청은 만료되었습니다.' };
  }
  const input = (pending.input ?? {}) as { server?: unknown; level?: unknown; duration?: unknown };
  const server = typeof input.server === 'string' ? input.server : '';
  const level = input.level === 'read' || input.level === 'write' ? (input.level as PermissionLevel) : null;
  const duration = typeof input.duration === 'string' ? input.duration : '';
  const userId = pending.user ?? '';
  const durationMs = parseDuration(duration);
  if (decision !== 'approve' && decision !== 'deny') {
    return { ok: false, reason: 'invalid', message: '❌ 알 수 없는 응답입니다.' };
  }
  if (!server || !level || !userId || (decision === 'approve' && !durationMs)) {
    logger.error('MCP grant request record is malformed', { requestId });
    return { ok: false, reason: 'invalid', message: '❌ 요청 기록이 손상되어 처리할 수 없습니다.' };
  }

  // Claim first, then the side effects, then the response the MCP child waits on.
  if (!(await sharedStore.claimPermissionResponse(requestId))) {
    return {
      ok: false,
      reason: 'already_answered',
      message: '⚠️ This request has already been handled by another admin.',
    };
  }
  // The MCP child may have timed out between the read and the claim; the claim stays.
  const current = await sharedStore.getPendingApproval(requestId);
  if (!current) {
    // Nobody can answer it any more; the claim would only make a retry read "already handled".
    await sharedStore.releasePermissionClaim(requestId);
    return { ok: false, reason: 'not_found', message: '⚠️ 이 MCP 권한 요청은 만료되었습니다.' };
  }
  // Read after the claim: the freshest list of admin DM copies.
  const prompts = current.prompts ?? pending.prompts ?? [];

  const where = via === 'dashboard' ? ' (대시보드에서 응답)' : '';
  const expiresAt = new Date(now + Math.min((durationMs as number) || 0, MAX_GRANT_DURATION_MS)).toISOString();
  const text =
    decision === 'approve'
      ? `✅ Permission granted by <@${actor}>: <@${userId}> → \`${server}\` (${level}, ${duration}) until ${expiresAt}${where}`
      : `❌ Permission denied by <@${actor}>: <@${userId}> → \`${server}\` (${level})${where}`;
  const response: PermissionResponse =
    decision === 'approve'
      ? { behavior: 'allow', message: `Approved by <@${actor}>`, updatedInput: { expiresAt, grantedBy: actor } }
      : { behavior: 'deny', message: `Denied by <@${actor}>` };
  // The line every DM copy is rewritten to — here, and again by the waiting child (which knows every copy).
  response.promptText = text;
  // The grant first, then the answer the child waits on: the child only ever reads "allow" for a
  // grant already on disk. A grant that cannot be written grants nothing and gives the claim back;
  // an answer that cannot be written takes the grant back and gives the claim back.
  let change: { replaced: GrantEntry | null; written: GrantEntry } | null = null;
  try {
    if (decision === 'approve') change = mcpToolGrantStore.setGrant(userId, server, level, expiresAt, actor);
  } catch (error) {
    await sharedStore.releasePermissionClaim(requestId);
    throw error;
  }
  try {
    await sharedStore.storePermissionResponse(requestId, response);
  } catch (error) {
    if (change) {
      try {
        // Only if our entry is still there: a revoke that landed meanwhile stays.
        mcpToolGrantStore.restoreGrant(userId, server, level, change);
      } catch (restoreError) {
        // The grant stands and cannot be taken back: keep the claim, so no other answer can
        // contradict it (the child times out). An admin did approve this grant.
        logger.error('MCP grant: the answer was not delivered and the grant could not be taken back', {
          requestId,
          restoreError,
        });
        throw error;
      }
    }
    await sharedStore.releasePermissionClaim(requestId);
    throw error;
  }

  const outcome = decision === 'approve' ? 'approved' : 'denied';
  remember(requestId, { id: `mcp_grant:${requestId}`, outcome, choiceId: decision, by: actor, via, at: now });
  logger.info('MCP tool permission answered', { requestId, userId, server, level, outcome, by: actor, via });

  for (const prompt of prompts) {
    try {
      await args.updateDm?.(prompt, text);
    } catch (err) {
      logger.warn('MCP grant: admin prompt rewrite failed', { requestId, err: (err as Error)?.message ?? String(err) });
    }
  }
  notifyAdminApprovalsChanged();
  return { ok: true, outcome, text };
}

/** One pending request as the approval card shows it — the DM's rows and Approve / Deny. */
export function mcpGrantApproval(requestId: string, p: PendingApproval): AdminApproval {
  const input = (p.input ?? {}) as { server?: unknown; level?: unknown; duration?: unknown; estimatedExpiry?: unknown };
  const server = String(input.server ?? '');
  const level = String(input.level ?? '');
  return {
    id: `mcp_grant:${requestId}`,
    kind: 'mcp_grant',
    card: 'permission',
    title: 'MCP 도구 권한 요청',
    description: `${server} 서버 ${level === 'write' ? '쓰기' : '읽기'} 권한을 ${String(input.duration ?? '')} 동안 요청합니다.`,
    tool: `mcp__${server}`,
    rows: {
      요청자: String(p.user ?? ''),
      서버: server,
      권한: level === 'write' ? '쓰기 (write)' : '읽기 (read)',
      기간: String(input.duration ?? ''),
      '예상 만료': String(input.estimatedExpiry ?? ''),
    },
    risk: level === 'write' ? 'medium' : 'low',
    requesterId: String(p.user ?? ''),
    ...(p.channel ? { place: { channel: p.channel, ...(p.thread_ts ? { threadTs: p.thread_ts } : {}) } } : {}),
    createdAt: Number(p.created_at) || 0,
    expiresAt: Number(p.expires_at) || undefined,
  };
}

export function mcpGrantAdminApprovalAdapter(updateDm: DecideMcpGrantArgs['updateDm']): AdminApprovalAdapter {
  return {
    kind: 'mcp_grant',
    async pending(now) {
      const out: AdminApproval[] = [];
      for (const { approvalId, approval } of await sharedStore.listPendingApprovals()) {
        if (!isMcpGrantRecord(approval) || !isOwnMcpGrantRecord(approval, true)) continue;
        if (Number(approval.expires_at) <= now) continue;
        // Answered, the child not yet done reading it: no longer something to act on.
        if (await sharedStore.isPermissionClaimed(approvalId)) continue;
        out.push(mcpGrantApproval(approvalId, approval));
      }
      return out;
    },
    resolved(since) {
      return [...resolutions.values()].filter((r) => r.at >= since);
    },
    async answer(requestId, choiceId, actor) {
      if (choiceId !== 'approve' && choiceId !== 'deny') return { ok: false, reason: 'invalid' };
      const result = await decideMcpGrant({ requestId, decision: choiceId, actor, via: 'dashboard', updateDm });
      if (result.ok) return { ok: true, outcome: result.outcome };
      return {
        ok: false,
        reason: result.reason === 'not_admin' ? 'forbidden' : result.reason === 'invalid' ? 'invalid' : result.reason,
      };
    },
  };
}
