/**
 * Auto-mode safety classifier — the "guardian" subagent (#auto-permission-mode).
 *
 * In `auto` mode, when `evaluateToolPolicy` reaches a *dangerous-rule hit* it
 * returns the `classify` decision instead of escalating straight to the user.
 * The async PreToolUse hook then consults a `SafetyClassifier`, which judges the
 * *specific* command in context and answers `allow` (auto-approve) or `ask`
 * (escalate to the human). This mirrors Codex CLI's `auto_review` guardian
 * (codex-rs `core/src/guardian/`): a dedicated, low-effort model session that
 * returns strict JSON and **fails closed** on timeout / error / malformed
 * output. Here "fail closed" means → `ask`: auto mode can never be *less* safe
 * than simply asking the human.
 *
 * The classifier only ever sees commands the static layer already flagged as
 * risky (a `DANGEROUS_RULES` match), so it runs rarely and never on the
 * common-case hot path. Hard denies (cross-user / ssh / sensitive-path / mcp
 * grant) are decided *before* the classifier and are never reachable here.
 */

export type SafetyVerdictKind = 'allow' | 'ask';

export interface SafetyVerdict {
  verdict: SafetyVerdictKind;
  /** Short rationale, for audit logs. */
  reason: string;
}

export interface SafetyClassifyRequest {
  /** Tool name (today always `Bash` — the only tool that reaches `classify`). */
  toolName: string;
  /** The concrete Bash command string. */
  command: string;
  /** Full tool input, for non-Bash future extension. */
  toolInput: Record<string, unknown>;
  /** Dangerous-rule ids that fired (e.g. `['rm-recursive']`). */
  matchedRuleIds: readonly string[];
  /** Working directory of the session, if known. */
  cwd?: string;
  /** Slack user id that owns the session (its sandbox is scoped to /tmp/<user>). */
  user: string;
}

export interface SafetyClassifier {
  classify(req: SafetyClassifyRequest): Promise<SafetyVerdict>;
}

/** Options passed to the backend chat function. */
export interface SafetyChatOptions {
  timeoutMs: number;
}

/**
 * Backend chat function: prompt → raw model text. Injected for testability.
 * Production binds this to the SAME unified one-shot dispatch that
 * executive-summary / workflow-dispatch use (`ClaudeHandler.dispatchOneShot`),
 * NOT a bespoke API route.
 */
export type SafetyChatFn = (prompt: string, opts: SafetyChatOptions) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Build the guardian prompt. Deterministic and side-effect free so it can be
 * pinned by tests. The model is told the operation runs inside an OS sandbox
 * scoped to the user's /tmp directory, and is asked for strict JSON.
 */
export function buildSafetyPrompt(req: SafetyClassifyRequest): string {
  return [
    'You are a SAFETY REVIEWER (guardian) for an autonomous coding agent.',
    'The agent runs inside an OS sandbox; filesystem writes are restricted to',
    `the user's own /tmp/${req.user} directory and a dev network allowlist.`,
    'A static rule already flagged the command below as potentially dangerous.',
    'Decide whether it is safe to AUTO-APPROVE, or whether a human should be',
    'asked first. Be conservative: when in doubt, ask.',
    '',
    `Tool: ${req.toolName}`,
    `Working directory: ${req.cwd ?? '(unknown)'}`,
    `Matched dangerous rules: ${req.matchedRuleIds.join(', ') || '(none)'}`,
    'Command:',
    '```',
    req.command,
    '```',
    '',
    'Reply with STRICT JSON only, no prose, no code fence:',
    '{"verdict":"allow"|"ask","reason":"<= 20 words"}',
    '- "allow": clearly safe and scoped (e.g. deletes only within the sandbox,',
    '  reversible, no host-wide / cross-user / credential / network-exfil risk).',
    '- "ask": anything broad, host-wide, irreversible, or ambiguous.',
  ].join('\n');
}

/**
 * Parse a guardian reply into a verdict. Fails CLOSED to `ask` on any
 * ambiguity: missing JSON, unparseable JSON, or a verdict that is not the exact
 * string `"allow"`. Tolerates JSON embedded in prose / code fences by scanning
 * for the first `{...}` block.
 */
export function parseSafetyVerdict(raw: string): SafetyVerdict {
  const fallback: SafetyVerdict = { verdict: 'ask', reason: 'unparseable classifier output (fail-closed)' };
  if (!raw || typeof raw !== 'string') return fallback;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
    if (parsed.verdict === 'allow') {
      return { verdict: 'allow', reason: typeof parsed.reason === 'string' ? parsed.reason : 'classifier approved' };
    }
    if (parsed.verdict === 'ask') {
      return { verdict: 'ask', reason: typeof parsed.reason === 'string' ? parsed.reason : 'classifier escalated' };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * LLM-backed guardian classifier. Calls the injected chat backend with a short
 * timeout and fails closed to `ask` on any error / timeout / malformed output.
 */
export class LlmSafetyClassifier implements SafetyClassifier {
  private readonly chat: SafetyChatFn;
  private readonly timeoutMs: number;

  constructor(chat: SafetyChatFn, opts: { timeoutMs?: number } = {}) {
    this.chat = chat;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(req: SafetyClassifyRequest): Promise<SafetyVerdict> {
    try {
      const raw = await this.chat(buildSafetyPrompt(req), { timeoutMs: this.timeoutMs });
      return parseSafetyVerdict(raw);
    } catch (err) {
      return {
        verdict: 'ask',
        reason: `classifier error (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/**
 * No-LLM fallback: always escalates to `ask`. Wiring auto mode with this
 * classifier reproduces the *old* bypass behaviour (dangerous → ask), so a
 * missing / unavailable LLM backend degrades to "no worse than before".
 */
export class StaticSafetyClassifier implements SafetyClassifier {
  async classify(_req: SafetyClassifyRequest): Promise<SafetyVerdict> {
    return { verdict: 'ask', reason: 'no LLM classifier configured (fail-closed)' };
  }
}
