/**
 * Dangerous Command Filter
 *
 * Detects dangerous bash command patterns that should ALWAYS require
 * user permission, even when bypass mode is enabled.
 *
 * Prevents scenarios like one session killing processes from another session.
 */

/** Dangerous command patterns with descriptions */
const DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; description: string }> = [
  // Process killing
  { pattern: /\bkill\b/, description: 'kill process' },
  { pattern: /\bpkill\b/, description: 'pkill process' },
  { pattern: /\bkillall\b/, description: 'killall process' },

  // Destructive file operations
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s|.*--recursive)/, description: 'recursive delete' },
  { pattern: /\brm\s+-[a-zA-Z]*f/, description: 'force delete' },

  // System-level operations
  { pattern: /\bshutdown\b/, description: 'system shutdown' },
  { pattern: /\breboot\b/, description: 'system reboot' },
  { pattern: /\bhalt\b/, description: 'system halt' },
  { pattern: /\bmkfs\b/, description: 'format filesystem' },

  // Disk operations
  { pattern: /\bdd\s+if=/, description: 'disk copy (dd)' },

  // Dangerous permission changes
  { pattern: /\bchmod\s+(-[a-zA-Z]*R|--recursive)\s+[0-7]*7[0-7]*7/, description: 'recursive world-writable chmod' },
];

export interface DangerousCommandResult {
  readonly isDangerous: boolean;
  readonly matchedPatterns: ReadonlyArray<string>;
}

/**
 * Check if a bash command matches any dangerous pattern.
 * Returns the result with matched pattern descriptions.
 */
export function checkDangerousCommand(command: string): DangerousCommandResult {
  const matched = DANGEROUS_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(
    ({ description }) => description,
  );

  return {
    isDangerous: matched.length > 0,
    matchedPatterns: matched,
  };
}

/**
 * Simple boolean check for dangerous commands.
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(({ pattern }) => pattern.test(command));
}

/**
 * Cross-user directory access detection.
 * Detects commands that reference another user's /tmp/{userId}/ directory.
 * Enforces per-user filesystem isolation — always deny, regardless of bypass mode.
 *
 * Matches both /tmp/{userId} and /private/tmp/{userId} (macOS normalization).
 * Slack user IDs follow pattern: U + uppercase alphanumeric (e.g., U094E5L4A15).
 */
export function isCrossUserAccess(command: string, currentUserId: string): boolean {
  // Reject any /tmp/ path containing traversal segments — prevents escaping
  // own directory via /tmp/U094E5L4A15/../U09F1M5MML1/
  if (/(?:\/private)?\/tmp\/[^\s]*\.\./.test(command)) {
    return true;
  }

  const tmpPathPattern = /(?:\/private)?\/tmp\/(U[A-Z0-9]+)\b/g;
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
