/**
 * Dangerous Command Filter
 *
 * Detects dangerous bash command patterns that should ALWAYS require
 * user permission, even when bypass mode is enabled.
 *
 * Prevents scenarios like one session killing processes from another session.
 *
 * Architecture:
 *   - DANGEROUS_RULES is the SSOT catalog of named rules used by the Slack
 *     permission UI and the session-scoped rule-disable mechanism.
 *   - `sessionOverridable` flags whether a rule can be temporarily silenced
 *     for a single ConversationSession via the "Approve & disable rule for
 *     this session" button. Lockdown rules (`false`) are always enforced.
 *   - `cross-user-access` and `ssh-remote` are catalog entries for parity, but
 *     their enforcement paths are DIFFERENT from the bypass-mode Bash escalation:
 *       * cross-user-access: always-deny pre-hook (claude-handler.ts), runs
 *         before bypass decision. Included here for UI labelling only.
 *       * ssh-remote: present for future wiring; today the bypass hook does
 *         NOT consult this rule (behaviour preserved). `sessionOverridable=false`
 *         documents that if it were wired, it would be a lockdown.
 *   - `bypassBashPermissionDecision` only consults rules that are both
 *     matched AND `sessionOverridable=true`, so catalog additions never
 *     silently change bypass behaviour.
 */

/**
 * Matcher context passed to per-rule match functions.
 * `userId` is the Slack user initiating the command — required by rules that
 * enforce per-user filesystem isolation (e.g. cross-user /tmp access).
 */
export interface DangerousRuleContext {
  readonly userId?: string;
}

/**
 * A single named dangerous-command rule.
 *
 * `id` is a stable, machine-readable identifier used to key the session-level
 * disable set. It is part of the action payload sent via Slack buttons, so
 * treat it as a public string and do not rename casually.
 */
export interface DangerousRule {
  readonly id: string;
  /** Short human label shown in the Slack permission UI. */
  readonly label: string;
  /** One-line description used in UI tooltips / logs. */
  readonly description: string;
  /**
   * Whether this rule can be silenced for a single ConversationSession via
   * the "Approve & disable rule for this session" button. `false` = lockdown.
   */
  readonly sessionOverridable: boolean;
  /**
   * Predicate that decides whether `command` matches this rule. Must be pure.
   * `ctx.userId` is consulted by rules that need per-user context.
   */
  readonly match: (command: string, ctx: DangerousRuleContext) => boolean;
}

/**
 * Registry of all dangerous-command rules. Declared once, consumed by:
 *   - `matchRules()` / `checkDangerousCommand()` / `isDangerousCommand()`
 *   - `bypassBashPermissionDecision()` (overridable subset only)
 *   - permission-mcp-server (re-runs `matchRules()` to populate Slack buttons)
 */
export const DANGEROUS_RULES: ReadonlyArray<DangerousRule> = [
  // Process killing
  {
    id: 'kill',
    label: 'kill process',
    description: 'Sends a signal to a running process. Can terminate sibling sessions.',
    sessionOverridable: true,
    match: (cmd) => /\bkill\b/.test(cmd),
  },
  {
    id: 'pkill',
    label: 'pkill process',
    description: 'Pattern-based process killer.',
    sessionOverridable: true,
    match: (cmd) => /\bpkill\b/.test(cmd),
  },
  {
    id: 'killall',
    label: 'killall process',
    description: 'Kills all processes matching a name.',
    sessionOverridable: true,
    match: (cmd) => /\bkillall\b/.test(cmd),
  },

  // Destructive file operations
  {
    id: 'rm-recursive',
    label: 'recursive delete',
    description: 'rm with -r / -R / --recursive: recursively deletes a tree.',
    sessionOverridable: true,
    match: (cmd) => /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s|.*--recursive)/.test(cmd),
  },
  {
    id: 'rm-force',
    label: 'force delete',
    description: 'rm -f: force-deletes without prompting.',
    sessionOverridable: true,
    match: (cmd) => /\brm\s+-[a-zA-Z]*f/.test(cmd),
  },
  {
    id: 'rm-force-long',
    label: 'force delete (--force)',
    description: 'rm --force: same as -f.',
    sessionOverridable: true,
    match: (cmd) => /\brm\s+.*--force/.test(cmd),
  },

  // System-level operations
  {
    id: 'shutdown',
    label: 'system shutdown',
    description: 'Powers down the host.',
    sessionOverridable: true,
    match: (cmd) => /\bshutdown\b/.test(cmd),
  },
  {
    id: 'reboot',
    label: 'system reboot',
    description: 'Reboots the host.',
    sessionOverridable: true,
    match: (cmd) => /\breboot\b/.test(cmd),
  },
  {
    id: 'halt',
    label: 'system halt',
    description: 'Halts the host.',
    sessionOverridable: true,
    match: (cmd) => /\bhalt\b/.test(cmd),
  },
  {
    id: 'mkfs',
    label: 'format filesystem',
    description: 'Formats a block device — destroys data.',
    sessionOverridable: true,
    match: (cmd) => /\bmkfs\b/.test(cmd),
  },

  // Disk operations
  {
    id: 'dd-if',
    label: 'disk copy (dd)',
    description: 'dd if=...: raw block copy, can overwrite disks.',
    sessionOverridable: true,
    match: (cmd) => /\bdd\s+if=/.test(cmd),
  },

  // Dangerous permission changes
  {
    id: 'chmod-world-recursive',
    label: 'recursive world-writable chmod',
    description: 'chmod -R with world-writable bits.',
    sessionOverridable: true,
    match: (cmd) => /\bchmod\s+(-[a-zA-Z]*R|--recursive)\s+[0-7]*7[0-7]*7/.test(cmd),
  },

  // Lockdown rules — present in the catalog for labelling/parity only.
  // See file-header notes: these do NOT flow through `bypassBashPermissionDecision()`.
  {
    id: 'cross-user-access',
    label: 'cross-user /tmp access',
    description: "Accesses another user's /tmp/{userId}/ directory. Blocked for data isolation.",
    sessionOverridable: false,
    match: (cmd, ctx) => (ctx.userId ? isCrossUserAccess(cmd, ctx.userId) : false),
  },
  {
    id: 'ssh-remote',
    label: 'SSH / SCP / SFTP / rsync-over-ssh',
    description: 'Remote shell/file operations. Admin-only. Not silencable per-session.',
    sessionOverridable: false,
    match: (cmd) => isSshCommand(cmd),
  },
];

/**
 * Return every rule that matches `command` (zero or more).
 * Both overridable and lockdown rules are returned — callers decide what to do.
 */
export function matchRules(command: string, ctx: DangerousRuleContext = {}): DangerousRule[] {
  return DANGEROUS_RULES.filter((rule) => rule.match(command, ctx));
}

/**
 * Legacy result type — preserved for backward compat with pre-catalog callers/tests.
 * `matchedRuleIds` is the new authoritative field; `matchedPatterns` is the
 * legacy label list kept for existing assertions.
 */
export interface DangerousCommandResult {
  readonly isDangerous: boolean;
  readonly matchedPatterns: ReadonlyArray<string>;
  readonly matchedRuleIds: ReadonlyArray<string>;
}

/**
 * Check if a bash command matches any dangerous pattern.
 * Returns labels (legacy) + rule ids.
 *
 * Note: legacy callers only looked at pattern-based rules. To avoid a behaviour
 * change, this function (like `isDangerousCommand`) considers ONLY
 * `sessionOverridable=true` rules — i.e. the classic DANGEROUS_PATTERNS set.
 * Lockdown rules are checked on their own enforcement paths.
 */
export function checkDangerousCommand(command: string): DangerousCommandResult {
  const matches = DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {}));
  return {
    isDangerous: matches.length > 0,
    matchedPatterns: matches.map((r) => legacyDescriptionFor(r.id)),
    matchedRuleIds: matches.map((r) => r.id),
  };
}

/**
 * Simple boolean check for dangerous commands. Legacy-compatible scope:
 * only considers overridable (pattern-based) rules — NOT cross-user/ssh.
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_RULES.some((rule) => rule.sessionOverridable && rule.match(command, {}));
}

/**
 * Cross-user directory access detection.
 * Detects commands that reference another user's /tmp/{userId}/ directory.
 * Enforces per-user filesystem isolation — always deny, regardless of bypass mode.
 *
 * Matches both /tmp/{userId} and /private/tmp/{userId} (macOS normalization).
 * Slack user IDs follow pattern: [UW] + uppercase alphanumeric (e.g., U094E5L4A15).
 * Enterprise Grid uses W-prefixed IDs — both must be covered.
 */
export function isCrossUserAccess(command: string, currentUserId: string): boolean {
  // Reject any /tmp/ path containing traversal segments — prevents escaping
  // own directory via /tmp/U094E5L4A15/../U09F1M5MML1/
  if (/(?:\/private)?\/tmp\/[^\s]*\.\./.test(command)) {
    return true;
  }

  const tmpPathPattern = /(?:\/private)?\/tmp\/([UW][A-Z0-9]+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = tmpPathPattern.exec(command)) !== null) {
    if (match[1] !== currentUserId) {
      return true;
    }
  }
  return false;
}

/**
 * SSH command patterns — matches `ssh`, `scp`, `sftp`, `rsync` over SSH.
 * These commands allow remote server access and must be restricted to admin users.
 */
const SSH_PATTERNS: ReadonlyArray<RegExp> = [/\bssh\b/, /\bscp\b/, /\bsftp\b/, /\brsync\b.*\b-e\s+['"]?ssh/];

/**
 * Check if a bash command involves SSH (remote server access).
 * SSH commands are admin-only — non-admin users must use server-tools MCP instead.
 */
export function isSshCommand(command: string): boolean {
  return SSH_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * Result of the bypass-mode Bash permission decision.
 *
 * `decision`: hook return value — 'allow' skips the Slack prompt, 'ask' escalates
 * to the permission MCP tool which renders the Slack permission UI.
 * `matchedRuleIds`: overridable rules that are currently *active* (not session-disabled).
 * Empty when decision is 'allow'. Passed end-to-end to the Slack UI so the
 * "Approve & disable rule for this session" button knows what to disable.
 */
export interface BypassBashPermissionResult {
  readonly decision: 'allow' | 'ask';
  readonly matchedRuleIds: ReadonlyArray<string>;
}

/**
 * Bypass mode permission decision for Bash commands.
 *
 * Returns 'allow' for non-dangerous commands, 'ask' for dangerous ones
 * (subject to the session-scoped disable set).
 *
 * CRITICAL: This returns explicit decisions ('allow'/'ask') instead of deferring.
 * When permissionPromptToolName is set (always in Slack context), a deferred
 * decision causes the SDK to route through the permission MCP tool, triggering
 * Slack permission prompts even in bypass mode. Explicit decisions prevent this.
 *
 * @param command  The bash command string.
 * @param isRuleDisabled
 *   Predicate that returns true for rule ids that should be treated as
 *   silenced for the current session. When all matched rules are disabled,
 *   the decision degrades to 'allow'. Defaults to always-false (no session).
 */
export function bypassBashPermissionDecision(
  command: string,
  isRuleDisabled: (ruleId: string) => boolean = () => false,
): BypassBashPermissionResult {
  // Only overridable rules participate in bypass escalation. Lockdown rules
  // (cross-user, ssh) have their own enforcement paths and must not be
  // silenced here even if a user previously approved them for the session.
  const matches = DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {}));
  if (matches.length === 0) {
    return { decision: 'allow', matchedRuleIds: [] };
  }
  const effective = matches.filter((rule) => !isRuleDisabled(rule.id));
  if (effective.length === 0) {
    return { decision: 'allow', matchedRuleIds: [] };
  }
  return { decision: 'ask', matchedRuleIds: effective.map((rule) => rule.id) };
}

/**
 * Returns the overridable rule ids that match `command` (cross-user/ssh
 * excluded). Used by the permission MCP server to re-derive what rule was
 * responsible for a Bash escalation without re-serialising decision state
 * through the SDK boundary.
 */
export function overridableMatchedRuleIds(command: string): string[] {
  return DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {})).map((rule) => rule.id);
}

/**
 * Look up an overridable rule by id. Returns undefined for unknown or
 * lockdown-only rule ids. Callers must tolerate undefined — stale button
 * payloads (e.g. old pending approvals after a rule rename) reach here.
 */
export function getOverridableRule(ruleId: string): DangerousRule | undefined {
  const rule = DANGEROUS_RULES.find((r) => r.id === ruleId);
  return rule?.sessionOverridable ? rule : undefined;
}

/**
 * Legacy description strings — kept stable so downstream log parsers or
 * existing test assertions (`matchedPatterns`) do not need to change.
 * New code should prefer `label` / `description` on the rule object.
 */
function legacyDescriptionFor(ruleId: string): string {
  switch (ruleId) {
    case 'kill':
      return 'kill process';
    case 'pkill':
      return 'pkill process';
    case 'killall':
      return 'killall process';
    case 'rm-recursive':
      return 'recursive delete';
    case 'rm-force':
      return 'force delete';
    case 'rm-force-long':
      return 'force delete (--force)';
    case 'shutdown':
      return 'system shutdown';
    case 'reboot':
      return 'system reboot';
    case 'halt':
      return 'system halt';
    case 'mkfs':
      return 'format filesystem';
    case 'dd-if':
      return 'disk copy (dd)';
    case 'chmod-world-recursive':
      return 'recursive world-writable chmod';
    default:
      return ruleId;
  }
}
