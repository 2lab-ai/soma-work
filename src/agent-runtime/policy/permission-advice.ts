/**
 * SSOT 2026-11-02 T2 — the AI's advice reaches every permission prompt.
 *
 * Two places see one escalated call, in the same process: the PreToolUse
 * policy hook, which asked the guardian (`SafetyClassifier`) and got `ask`,
 * and then the permission prompt tool the SDK calls for that `ask`. The hook
 * leaves the guardian's advice here, keyed by the session, the tool and the
 * input; the prompt takes it. One guardian call per escalation, and the card
 * shows the same judgement the hook acted on.
 *
 * A prompt nothing escalated (legacy mode asks for every tool) finds nothing
 * here and asks the guardian itself, within a time limit. A guardian that
 * fails, is too slow, or is not wired gives no advice (null): the prompt still
 * goes out, saying the AI gave none. Advice never decides anything — the
 * person does; a `deny` only makes the answer path ask them twice.
 */

import type { PermissionAdvice } from 'somalib/permission/shared-store';
import type { SafetyClassifier } from './safety-classifier';

/** How long an escalation's advice waits for its prompt. The SDK calls the prompt right after the hook. */
const ADVICE_TTL_MS = 10 * 60 * 1000;
/** Entries kept at most; the oldest go first. A prompt takes its own at once, so this only bounds leftovers. */
const ADVICE_MAX_ENTRIES = 500;
/** How long a prompt waits for the guardian when nothing left advice for it. */
export const ADVICE_TIMEOUT_MS = 30_000;

/** JSON with object keys in a fixed order, so equal inputs give equal keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

function adviceKey(scope: string, toolName: string, input: unknown): string {
  return `${scope}\u0000${toolName}\u0000${stableStringify(input ?? {})}`;
}

export class PermissionAdviceBoard {
  private readonly entries = new Map<string, { advice: PermissionAdvice | null; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? ADVICE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Leave the guardian's advice (null = it gave none) for the prompt of this call. */
  put(scope: string, toolName: string, input: unknown, advice: PermissionAdvice | null): void {
    const key = adviceKey(scope, toolName, input);
    this.entries.delete(key);
    this.entries.set(key, { advice, at: this.now() });
    while (this.entries.size > ADVICE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The advice left for this call, once; undefined when none was left (or it is too old). */
  take(scope: string, toolName: string, input: unknown): { advice: PermissionAdvice | null } | undefined {
    const key = adviceKey(scope, toolName, input);
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    if (this.now() - hit.at > this.ttlMs) return undefined;
    return { advice: hit.advice };
  }
}

/** The process's board: the policy hook writes it, the permission prompt reads it. */
export const permissionAdviceBoard = new PermissionAdviceBoard();

export interface ResolvePermissionAdviceArgs {
  board: PermissionAdviceBoard;
  /** The session key the policy hook used (`ExecutionContext.sessionKey`). */
  scope: string;
  toolName: string;
  input: unknown;
  /** The session's user (the guardian is told its sandbox root). */
  user: string;
  cwd?: string;
  model?: string;
  /** Dangerous-rule ids the call matched, if any. */
  matchedRuleIds?: readonly string[];
  classifier?: SafetyClassifier;
  timeoutMs?: number;
}

/**
 * The advice for one prompt: what the escalation left, else the guardian's
 * answer now. Null when there is none — never throws.
 */
export async function resolvePermissionAdvice(args: ResolvePermissionAdviceArgs): Promise<PermissionAdvice | null> {
  const left = args.board.take(args.scope, args.toolName, args.input);
  if (left) return left.advice;
  if (!args.classifier) return null;
  const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
  const command = args.toolName === 'Bash' && typeof input.command === 'string' ? input.command : '';
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), args.timeoutMs ?? ADVICE_TIMEOUT_MS);
  });
  try {
    const verdict = args.classifier
      .classify({
        toolName: args.toolName,
        command,
        toolInput: input,
        matchedRuleIds: args.matchedRuleIds ?? [],
        cwd: args.cwd,
        user: args.user,
        model: args.model,
      })
      .then((v) => v.advice ?? null)
      .catch(() => null);
    return await Promise.race([verdict, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
