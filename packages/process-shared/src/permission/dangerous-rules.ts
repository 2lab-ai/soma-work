/**
 * Dangerous Command Rules — single source of truth for the catalog.
 *
 * Hosts the full rule catalog and the helpers that operate on it. Both the
 * parent process (Slack handler / claude-handler) and the permission MCP child
 * import from here, so adding or modifying a rule never requires touching two
 * files.
 *
 * Architecture:
 *   - `DANGEROUS_RULES` is the SSOT. Each entry carries `sessionOverridable`
 *     which decides whether the rule participates in the bypass-mode Bash
 *     escalation (`true`) or is a lockdown rule enforced on a dedicated
 *     parent-side pre-hook (`false`).
 *   - `overridableRulesByIds` / `overridableMatchedRuleIds` expose ONLY the
 *     overridable subset. They are the public surface used by the permission
 *     MCP child and the Slack permission UI — lockdown ids are silently
 *     filtered out so the child never sees them, even if a stale id sneaks
 *     into a button payload or a session disable set.
 *   - `matchRules` / `rulesByIds` operate over the full catalog. They are
 *     intended for parent-side callers that need the lockdown rules (e.g.
 *     audit logging, future enforcement wiring). They are NOT what the MCP
 *     child should call.
 *   - `isCrossUserAccess` / `isSshCommand` are standalone matchers that
 *     `claude-handler.ts` wires onto dedicated PreToolUse hooks. They enforce
 *     lockdown rules without going through the bypass-mode escalation, so
 *     bypass state can never silence them.
 *
 * Lockdown isolation invariant (verified by
 * `src/__tests__/dangerous-command-filter.test.ts`):
 *   For every rule `r` with `r.sessionOverridable === false`,
 *   `overridableRulesByIds([r.id])` is `[]` and `overridableMatchedRuleIds`
 *   never contains `r.id`. Future lockdown rules inherit this property
 *   automatically — no per-rule wiring required.
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
 *   - `matchRules()` — full catalog, returns lockdown + overridable matches
 *   - `overridableMatchedRuleIds()` / `overridableRulesByIds()` — overridable subset only
 *   - `bypassBashPermissionDecision()` (in src/dangerous-command-filter.ts) — overridable subset
 *   - permission-mcp-server (calls overridable helpers to populate Slack buttons)
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
  // See file-header notes: these do NOT flow through the bypass-mode escalation.
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
 * Module-scope lookup table — catalog is static, so build the Map once at
 * load time instead of rebuilding on every permission request.
 */
const RULES_BY_ID: ReadonlyMap<string, DangerousRule> = new Map(DANGEROUS_RULES.map((r) => [r.id, r]));

/**
 * Return every rule that matches `command` (zero or more).
 * Both overridable and lockdown rules are returned — callers decide what to do.
 *
 * Parent-process callers that want lockdown enforcement should use this. The
 * MCP child should NEVER call this — call `overridableMatchedRuleIds` instead.
 */
export function matchRules(command: string, ctx: DangerousRuleContext = {}): DangerousRule[] {
  return DANGEROUS_RULES.filter((rule) => rule.match(command, ctx));
}

/**
 * Look up rules by id over the FULL catalog (lockdown + overridable). Order
 * preserved; unknown ids silently dropped. Parent-only — the MCP child must
 * use `overridableRulesByIds` instead.
 */
export function rulesByIds(ruleIds: ReadonlyArray<string>): DangerousRule[] {
  return ruleIds.map((id) => RULES_BY_ID.get(id)).filter((r): r is DangerousRule => r !== undefined);
}

/**
 * Returns the overridable rule ids that match `command` (cross-user/ssh
 * excluded). Used by the permission MCP server to re-derive what rule was
 * responsible for a Bash escalation without re-serialising decision state
 * through the SDK boundary.
 *
 * Lockdown rules (`sessionOverridable === false`) are silently excluded — even
 * if their matcher fires, the id never appears in the result. This is the
 * lockdown isolation invariant the MCP child relies on.
 */
export function overridableMatchedRuleIds(command: string): string[] {
  return DANGEROUS_RULES.filter((rule) => rule.sessionOverridable && rule.match(command, {})).map((rule) => rule.id);
}

/**
 * Look up rules by id over the OVERRIDABLE subset only. Lockdown ids
 * (`sessionOverridable === false`) and unknown ids are silently dropped.
 *
 * This is the surface the permission MCP child uses to render the Slack
 * "Approve & disable rule for this session" button. It MUST NOT return
 * lockdown rule entries — even if a stale lockdown id reaches here through a
 * pending approval payload, the Slack UI must not advertise it as silencable.
 */
export function overridableRulesByIds(ruleIds: ReadonlyArray<string>): DangerousRule[] {
  return ruleIds
    .map((id) => RULES_BY_ID.get(id))
    .filter((r): r is DangerousRule => r !== undefined && r.sessionOverridable);
}

// Hoisted at module scope so the regex isn't recompiled per Bash command. The
// `g` flag on TMP_USER_RE means call sites must use `matchAll` (fresh iterator
// per call) instead of `.exec`-in-a-loop, which would carry `lastIndex` state
// across concurrent callers.
const TMP_TRAVERSAL_RE = /(?:\/private)?\/tmp\/[^\s]*\.\./;
const TMP_USER_RE = /(?:\/private)?\/tmp\/([UW][A-Z0-9]+)\b/g;

/**
 * Cross-user directory access detection.
 * Detects commands that reference another user's /tmp/{userId}/ directory.
 * Enforces per-user filesystem isolation — always deny, regardless of bypass mode.
 *
 * Matches both /tmp/{userId} and /private/tmp/{userId} (macOS normalization).
 * Slack user IDs follow pattern: [UW] + uppercase alphanumeric (e.g., U094E5L4A15).
 * Enterprise Grid uses W-prefixed IDs — both must be covered.
 *
 * @internal Parent-process enforcement only. The permission MCP child MUST NOT
 *   call this directly — the bypass-mode escalation surface
 *   (`overridableMatchedRuleIds` / `overridableRulesByIds`) deliberately
 *   excludes this rule. Cross-user access is denied by a dedicated PreToolUse
 *   hook in `claude-handler.ts`, independent of bypass state.
 */
export function isCrossUserAccess(command: string, currentUserId: string): boolean {
  // Reject any /tmp/ path containing traversal segments — prevents escaping
  // own directory via /tmp/U094E5L4A15/../U09F1M5MML1/
  if (TMP_TRAVERSAL_RE.test(command)) {
    return true;
  }

  for (const match of command.matchAll(TMP_USER_RE)) {
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
 *
 * @internal Parent-process enforcement only. Same isolation contract as
 *   `isCrossUserAccess` — the bypass-mode escalation surface excludes the
 *   `ssh-remote` rule, and SSH commands are denied by a dedicated parent-side
 *   PreToolUse hook in `claude-handler.ts`.
 */
export function isSshCommand(command: string): boolean {
  return SSH_PATTERNS.some((pattern) => pattern.test(command));
}
