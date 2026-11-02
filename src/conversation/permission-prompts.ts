/**
 * Pending permission prompts as the dashboard shows them (SSOT 2026-10-24).
 *
 * The permission MCP server writes each prompt into the shared file store
 * (`somalib/permission/shared-store`) and waits there for the answer. It may
 * run in the daemon or as a stdio child, so the dashboard does not hook it:
 * it re-reads the store's pending directory (once a second while the web
 * server listens) and keeps an in-memory index per session thread, which the
 * synchronous card builder reads. A change pushes the board.
 *
 * What the index carries is what every dashboard viewer may see — the board
 * is one document for everyone. The tool input (a Bash command can hold a
 * token) is NOT in it: the requester reads it through
 * {@link permissionPromptDetail} behind the requester-only route.
 */

import { overridableRulesByIds } from 'somalib/permission/dangerous-rules';
import {
  PERMISSION_PROMPT_KIND,
  type PendingApproval,
  type PermissionAdvice,
  type PermissionRecommendation,
  sharedStore,
} from 'somalib/permission/shared-store';
import { Logger } from '../logger';

const logger = new Logger('DashboardPermissionPrompts');

/** One pending permission prompt on a card. */
export interface DashboardPermissionRequest {
  approvalId: string;
  toolName: string;
  /** Slack user id the prompt was raised for — the only one who may answer it. */
  requesterId?: string;
  /** Matched overridable dangerous-command rules (static catalog text). */
  rules: Array<{ id: string; label: string; description: string }>;
  /** True when "Approve & disable rule (this session)" applies — never when the AI advised against the call. */
  canDisableRule: boolean;
  /**
   * SSOT 2026-11-02 — the AI's recommendation, so every viewer's card is
   * green or red. What the call does and why it is risky can quote the
   * command, so they are in the requester-only detail.
   */
  aiRecommendation?: PermissionRecommendation;
  createdAt: number;
  expiresAt: number;
}

/** The tool input the requester sees before answering. */
export interface DashboardPermissionDetail extends DashboardPermissionRequest {
  /** Pretty-printed JSON, cut at {@link PERMISSION_INPUT_MAX_CHARS}. */
  input: string;
  truncated: boolean;
  /** The AI's advice in full (absent when it gave none). */
  advice?: PermissionAdvice;
}

export const PERMISSION_INPUT_MAX_CHARS = 64 * 1024;

export function permissionThreadKey(channel: string | undefined, threadTs: string | undefined): string {
  return `${channel ?? ''}:${threadTs ?? ''}`;
}

const TASK_INDEX_PREFIX = 'task-key:';

/**
 * The index key of one prompt: a Slack-less task's (#599 ⑤b) is its own
 * session key and the turn that raised it, which no `channel:thread` key can
 * equal; a Slack prompt's is its thread. A task has no channel or thread, so
 * keying it by thread would put every channel-less prompt on every task's card.
 */
function promptIndexKey(approval: PendingApproval): string {
  return approval.task_key
    ? taskIndexKey(approval.task_key, approval.turn_id ?? '')
    : permissionThreadKey(approval.channel, approval.thread_ts);
}

function taskIndexKey(taskKey: string, turnId: string): string {
  return `${TASK_INDEX_PREFIX}${taskKey}#${turnId}`;
}

function toRequest(approvalId: string, approval: PendingApproval): DashboardPermissionRequest {
  const rules = overridableRulesByIds(approval.rule_ids ?? []).map((r) => ({
    id: r.id,
    label: r.label,
    description: r.description,
  }));
  const ai = adviceOf(approval)?.recommendation;
  return {
    approvalId,
    toolName: String(approval.tool_name ?? ''),
    ...(approval.user ? { requesterId: approval.user } : {}),
    rules,
    canDisableRule: rules.length > 0 && ai !== 'deny',
    ...(ai ? { aiRecommendation: ai } : {}),
    createdAt: Number(approval.created_at) || 0,
    expiresAt: Number(approval.expires_at) || 0,
  };
}

/** The record's advice when it is well formed (the store is a shared directory). */
function adviceOf(approval: PendingApproval): PermissionAdvice | undefined {
  const a = approval.advice;
  if (!a || (a.recommendation !== 'approve' && a.recommendation !== 'deny')) return undefined;
  return { recommendation: a.recommendation, summary: String(a.summary ?? ''), risk: String(a.risk ?? '') };
}

export function permissionPromptDetail(approvalId: string, approval: PendingApproval): DashboardPermissionDetail {
  let input: string;
  try {
    input = JSON.stringify(approval.input ?? {}, null, 2) ?? '';
  } catch {
    input = String(approval.input);
  }
  const truncated = input.length > PERMISSION_INPUT_MAX_CHARS;
  const advice = adviceOf(approval);
  return {
    ...toRequest(approvalId, approval),
    input: truncated ? input.slice(0, PERMISSION_INPUT_MAX_CHARS) : input,
    truncated,
    ...(advice ? { advice } : {}),
  };
}

let byThread = new Map<string, DashboardPermissionRequest[]>();
let signatures = new Map<string, string>();
let chain: Promise<unknown> = Promise.resolve();

/** Prompts pending in one session thread (oldest first); empty when none. */
export function pendingPermissionsFor(
  channel: string | undefined,
  threadTs: string | undefined,
): DashboardPermissionRequest[] {
  return byThread.get(permissionThreadKey(channel, threadTs)) ?? [];
}

/**
 * A changed index key as callers name it: a task's session key, or a
 * `channel:thread` key. The board's watcher only needs "something changed";
 * the names are for callers (and tests) that care which session it was.
 */
function reportedKey(indexKey: string): string {
  if (!indexKey.startsWith(TASK_INDEX_PREFIX)) return indexKey;
  return indexKey.slice(TASK_INDEX_PREFIX.length, indexKey.lastIndexOf('#'));
}

/**
 * Prompts pending for one Slack-less task (#599 ⑤b) raised by the turn it is
 * running (`activeTaskTurnId`); empty when none or when no turn runs — a
 * prompt of an ended turn has no waiter left.
 */
export function pendingTaskPermissionsFor(taskKey: string, turnId: string | undefined): DashboardPermissionRequest[] {
  if (!turnId) return [];
  return byThread.get(taskIndexKey(taskKey, turnId)) ?? [];
}

async function readAndDiff(): Promise<string[]> {
  const next = new Map<string, DashboardPermissionRequest[]>();
  for (const { approvalId, approval } of await sharedStore.listPendingApprovals()) {
    if (approval.kind !== PERMISSION_PROMPT_KIND) continue;
    const key = promptIndexKey(approval);
    const list = next.get(key) ?? [];
    list.push(toRequest(approvalId, approval));
    next.set(key, list);
  }
  const nextSignatures = new Map<string, string>();
  for (const [key, list] of next) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.approvalId.localeCompare(b.approvalId));
    // Everything the card shows, so a rewritten record (other rules) pushes too.
    nextSignatures.set(key, JSON.stringify(list));
  }
  const changed: string[] = [];
  for (const key of new Set([...signatures.keys(), ...nextSignatures.keys()])) {
    if (signatures.get(key) !== nextSignatures.get(key)) changed.push(reportedKey(key));
  }
  byThread = next;
  signatures = nextSignatures;
  return changed;
}

/**
 * Re-read the store. Returns the thread keys (a task's session key for a
 * Slack-less task) whose prompts appeared, changed
 * or went away since the previous read. Calls run one after another, each on
 * a fresh read.
 */
export function refreshPendingPermissions(): Promise<string[]> {
  const run = chain.then(readAndDiff, readAndDiff);
  chain = run.catch(() => {});
  return run;
}

let watchTimer: ReturnType<typeof setInterval> | null = null;

/** Re-read every `intervalMs`; `onChange` runs when any thread's prompts changed. */
export function startPermissionPromptWatch(onChange: (threadKeys: string[]) => void, intervalMs = 1000): void {
  stopPermissionPromptWatch();
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    refreshPendingPermissions()
      .then((changed) => {
        if (changed.length > 0) onChange(changed);
      })
      .catch((error) => logger.warn('Failed to read pending permission prompts', error))
      .finally(() => {
        busy = false;
      });
  };
  watchTimer = setInterval(tick, intervalMs);
  watchTimer.unref?.();
  tick();
}

export function stopPermissionPromptWatch(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
