/**
 * Dangerous Command Filter — overridable-rules subset for MCP child processes.
 *
 * Subset of src/dangerous-command-filter.ts: only the `sessionOverridable`
 * rules plus `overridableMatchedRuleIds` / `rulesByIds`, which is all the
 * permission MCP server needs to label the Slack button and round-trip rule
 * ids through the pending-approval store.
 *
 * The lockdown rules (`cross-user-access`, `ssh-remote`) are intentionally
 * NOT mirrored here — they are enforced in the parent process only. Keep the
 * overridable rule set in sync with src/dangerous-command-filter.ts; see that
 * file for authoritative documentation.
 */

export interface DangerousRuleContext {
  readonly userId?: string;
}

export interface DangerousRule {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly sessionOverridable: boolean;
  readonly match: (command: string, ctx: DangerousRuleContext) => boolean;
}

export const DANGEROUS_RULES: ReadonlyArray<DangerousRule> = [
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
  {
    id: 'dd-if',
    label: 'disk copy (dd)',
    description: 'dd if=...: raw block copy, can overwrite disks.',
    sessionOverridable: true,
    match: (cmd) => /\bdd\s+if=/.test(cmd),
  },
  {
    id: 'chmod-world-recursive',
    label: 'recursive world-writable chmod',
    description: 'chmod -R with world-writable bits.',
    sessionOverridable: true,
    match: (cmd) => /\bchmod\s+(-[a-zA-Z]*R|--recursive)\s+[0-7]*7[0-7]*7/.test(cmd),
  },
];

/**
 * Return the ids of overridable rules that `command` matches. Used by the
 * permission MCP server to decorate the Slack button payload with the rule
 * ids that the "Approve & disable rule for this session" button should clear.
 */
export function overridableMatchedRuleIds(command: string): string[] {
  return DANGEROUS_RULES
    .filter((rule) => rule.sessionOverridable && rule.match(command, {}))
    .map((rule) => rule.id);
}

/**
 * Module-scope lookup table — catalog is static, so build the Map once at
 * load time instead of rebuilding on every permission request.
 */
const RULES_BY_ID: ReadonlyMap<string, DangerousRule> = new Map(DANGEROUS_RULES.map((r) => [r.id, r]));

/**
 * Return the rule catalog entries for a list of rule ids, preserving order
 * and silently dropping unknown ids. Used by the Slack messenger to render
 * human labels next to the rule-disable button.
 */
export function rulesByIds(ruleIds: ReadonlyArray<string>): DangerousRule[] {
  return ruleIds.map((id) => RULES_BY_ID.get(id)).filter((r): r is DangerousRule => r !== undefined);
}
