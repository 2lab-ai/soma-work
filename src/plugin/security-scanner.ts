/**
 * Plugin Security Scanner
 *
 * Scans plugin directories and MCP server configurations for security risks.
 * Detects dangerous patterns, environment variable access, and suspicious network usage.
 *
 * Risk levels:
 * - LOW: Informational findings
 * - MEDIUM: Requires admin review
 * - HIGH: Requires admin approval before installation
 * - CRITICAL: Installation blocked automatically
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../logger';

const logger = new Logger('SecurityScanner');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface SecurityFinding {
  /** Rule identifier */
  rule: string;
  /** Human-readable description */
  description: string;
  /** Severity level */
  severity: RiskSeverity;
  /** File where the issue was found (relative to plugin root) */
  file?: string;
  /** Line number (1-based) */
  line?: number;
  /** Matched content snippet */
  match?: string;
}

export interface ScanResult {
  /** Overall risk level (highest severity found) */
  riskLevel: RiskSeverity;
  /** Whether the plugin should be blocked from installation */
  blocked: boolean;
  /** Whether admin approval is required */
  requiresApproval: boolean;
  /** Individual findings */
  findings: SecurityFinding[];
  /** Plugin name */
  pluginName: string;
  /** Scan timestamp */
  scannedAt: string;
}

export interface McpServerScanResult {
  /** Server name */
  serverName: string;
  /** Overall risk level */
  riskLevel: RiskSeverity;
  /** Whether the server should be blocked */
  blocked: boolean;
  /** Individual findings */
  findings: SecurityFinding[];
}

// ---------------------------------------------------------------------------
// Dangerous patterns — matched against file content
// ---------------------------------------------------------------------------

interface DangerousPattern {
  rule: string;
  pattern: RegExp;
  description: string;
  severity: RiskSeverity;
}

const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Code execution
  {
    rule: 'EXEC_EVAL',
    pattern: /\beval\s*\(/g,
    description: 'Use of eval() — arbitrary code execution',
    severity: 'CRITICAL',
  },
  {
    rule: 'EXEC_FUNCTION',
    pattern: /\bnew\s+Function\s*\(/g,
    description: 'Dynamic function construction via new Function()',
    severity: 'CRITICAL',
  },
  {
    rule: 'EXEC_CHILD_PROCESS',
    pattern: /(?:require\s*\(\s*['"](?:node:)?child_process['"]|from\s+['"](?:node:)?child_process['"])/g,
    description: 'Import of child_process module — shell command execution',
    severity: 'CRITICAL',
  },
  {
    rule: 'EXEC_SPAWN',
    pattern: /\b(?:execSync|execFileSync|spawnSync|exec|execFile|spawn|fork)\s*\(/g,
    description: 'Process spawning function call',
    severity: 'HIGH',
  },

  // File system access
  {
    rule: 'FS_WRITE',
    pattern: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/g,
    description: 'File write operation',
    severity: 'MEDIUM',
  },
  {
    rule: 'FS_UNLINK',
    pattern: /\b(?:unlinkSync|unlink|rmSync|rmdirSync|rmdir)\s*\(/g,
    description: 'File/directory deletion',
    severity: 'HIGH',
  },

  // Network access
  {
    rule: 'NET_FETCH',
    pattern: /\b(?:fetch|axios|request|got|needle|superagent|node-fetch)\s*\(/g,
    description: 'Network request — potential data exfiltration',
    severity: 'MEDIUM',
  },
  {
    rule: 'NET_HTTP_SERVER',
    pattern: /\b(?:createServer|listen)\s*\(/g,
    description: 'HTTP server creation — potential backdoor',
    severity: 'HIGH',
  },
  {
    rule: 'NET_WEBSOCKET',
    pattern: /\bnew\s+WebSocket\s*\(/g,
    description: 'WebSocket connection — persistent external channel',
    severity: 'HIGH',
  },

  // Environment / credential access
  {
    rule: 'ENV_ACCESS',
    pattern: /process\.env\b/g,
    description: 'Access to environment variables',
    severity: 'MEDIUM',
  },
  {
    rule: 'CRED_PATTERN',
    pattern: /(?:password|secret|token|api_key|apikey|credential|private_key)\s*[=:]/gi,
    description: 'Potential hardcoded credential or credential access',
    severity: 'HIGH',
  },

  // Dynamic imports / require
  {
    rule: 'DYNAMIC_REQUIRE',
    pattern: /\brequire\s*\(\s*[^'"]/g,
    description: 'Dynamic require with variable — unpredictable module loading',
    severity: 'HIGH',
  },
  {
    rule: 'DYNAMIC_IMPORT',
    pattern: /\bimport\s*\(\s*[^'"]/g,
    description: 'Dynamic import with variable — unpredictable module loading',
    severity: 'HIGH',
  },

  // Prototype pollution
  {
    rule: 'PROTO_POLLUTION',
    pattern: /\b__proto__\b|Object\.assign\s*\(\s*(?:global|window|process)/g,
    description: 'Potential prototype pollution',
    severity: 'CRITICAL',
  },
];

// ---------------------------------------------------------------------------
// Dangerous tool names in MCP manifests
// ---------------------------------------------------------------------------

const DANGEROUS_TOOL_NAMES = new Set([
  'shell_exec',
  'run_command',
  'execute_command',
  'exec',
  'file_write',
  'write_file',
  'file_delete',
  'delete_file',
  'system',
  'os_exec',
]);

// ---------------------------------------------------------------------------
// Sensitive environment variable patterns
// ---------------------------------------------------------------------------

const SENSITIVE_ENV_PATTERNS = [
  /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i,
  /(?:AWS_ACCESS|AWS_SECRET|GITHUB_TOKEN|SLACK_TOKEN|DATABASE_URL)/i,
  /(?:OPENAI_API|ANTHROPIC_API|STRIPE_KEY|SENDGRID)/i,
];

// ---------------------------------------------------------------------------
// File extensions to scan
// ---------------------------------------------------------------------------

const SCANNABLE_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '.mts',
  '.mjs',
  '.cjs',
  '.cts',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.pl',
  '.node',
  '.wasm',
]);

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan a plugin directory for security risks.
 *
 * Walks all scannable files, applies pattern matching, and
 * aggregates findings into a risk assessment.
 */
export function scanPluginDirectory(pluginDir: string, pluginName: string): ScanResult {
  const findings: SecurityFinding[] = [];

  if (!fs.existsSync(pluginDir)) {
    return {
      riskLevel: 'LOW',
      blocked: false,
      requiresApproval: false,
      findings: [],
      pluginName,
      scannedAt: new Date().toISOString(),
    };
  }

  // Scan manifest first
  const manifestFindings = scanManifest(pluginDir);
  findings.push(...manifestFindings);

  // Walk and scan all files
  const files = collectScannableFiles(pluginDir);
  for (const filePath of files) {
    const relativePath = path.relative(pluginDir, filePath);
    const fileFindings = scanFileContent(filePath, relativePath);
    findings.push(...fileFindings);
  }

  // Check for suspicious file structure
  const structureFindings = scanStructure(pluginDir);
  findings.push(...structureFindings);

  const riskLevel = computeRiskLevel(findings);
  const blocked = riskLevel === 'CRITICAL';
  const requiresApproval = riskLevel === 'MEDIUM' || riskLevel === 'HIGH';

  const result: ScanResult = {
    riskLevel,
    blocked,
    requiresApproval,
    findings,
    pluginName,
    scannedAt: new Date().toISOString(),
  };

  if (findings.length > 0) {
    logger.warn('Security scan found issues', {
      pluginName,
      riskLevel,
      blocked,
      requiresApproval,
      findingCount: findings.length,
      critical: findings.filter((f) => f.severity === 'CRITICAL').length,
      high: findings.filter((f) => f.severity === 'HIGH').length,
      medium: findings.filter((f) => f.severity === 'MEDIUM').length,
    });
  } else {
    logger.info('Security scan passed', { pluginName });
  }

  return result;
}

/**
 * Scan an MCP server configuration for security risks.
 *
 * Checks command, args, env, and URL for suspicious patterns.
 */
export function scanMcpServerConfig(
  serverName: string,
  config: { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string },
): McpServerScanResult {
  const findings: SecurityFinding[] = [];

  // Check command for dangerous binaries
  if (config.command) {
    const dangerousCommands = ['bash', 'sh', 'zsh', 'cmd', 'powershell', 'curl', 'wget'];
    const cmdBase = path.basename(config.command);
    if (dangerousCommands.includes(cmdBase)) {
      findings.push({
        rule: 'MCP_DANGEROUS_COMMAND',
        description: `MCP server uses dangerous command: ${cmdBase}`,
        severity: 'HIGH',
      });
    }
  }

  // Check args for shell injection patterns
  if (config.args) {
    const argsStr = config.args.join(' ');
    if (/[;&|`$]/.test(argsStr)) {
      findings.push({
        rule: 'MCP_SHELL_INJECTION',
        description: 'MCP server args contain shell metacharacters',
        severity: 'CRITICAL',
        match: argsStr.slice(0, 100),
      });
    }
  }

  // Check env for sensitive variable forwarding
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      const isSensitive = SENSITIVE_ENV_PATTERNS.some((p) => p.test(key));
      if (isSensitive) {
        // Only warn if the value looks like it references another env var
        // or contains an actual secret pattern (not a placeholder)
        const looksLikeSecret = value.length > 8 && !/^\$\{/.test(value) && !/^</.test(value);
        if (looksLikeSecret) {
          findings.push({
            rule: 'MCP_SENSITIVE_ENV',
            description: `MCP server env contains sensitive variable: ${key}`,
            severity: 'MEDIUM',
          });
        }
      }
    }
  }

  // Check URL for non-HTTPS
  if (config.url) {
    const urlHost = (() => {
      try {
        return new URL(config.url).hostname;
      } catch {
        return '';
      }
    })();
    const isLocal = urlHost === 'localhost' || urlHost === '127.0.0.1' || urlHost === '::1';
    if (config.url.startsWith('http://') && !isLocal) {
      findings.push({
        rule: 'MCP_INSECURE_URL',
        description: 'MCP server uses non-HTTPS URL (potential MitM)',
        severity: 'HIGH',
        match: config.url,
      });
    }
  }

  const riskLevel = computeRiskLevel(findings);

  return {
    serverName,
    riskLevel,
    blocked: riskLevel === 'CRITICAL',
    findings,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all scannable files in a directory.
 * Skips node_modules, .git, and binary files.
 */
function collectScannableFiles(dir: string, maxDepth = 5): string[] {
  const files: string[] = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '.next']);

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCANNABLE_EXTENSIONS.has(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir, 0);
  return files;
}

/**
 * Scan a single file's content against all dangerous patterns.
 */
function scanFileContent(filePath: string, relativePath: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  let content: string;
  try {
    const stat = fs.statSync(filePath);
    // Skip files larger than 1MB
    if (stat.size > 1024 * 1024) {
      findings.push({
        rule: 'LARGE_FILE',
        description: `File exceeds 1MB (${(stat.size / 1024 / 1024).toFixed(1)}MB) — skipped detailed scan`,
        severity: 'LOW',
        file: relativePath,
      });
      return findings;
    }
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return findings;
  }

  const lines = content.split('\n');

  for (const pattern of DANGEROUS_PATTERNS) {
    // Reset regex state
    pattern.pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.pattern.exec(content)) !== null) {
      // Calculate line number
      const beforeMatch = content.slice(0, match.index);
      const lineNum = beforeMatch.split('\n').length;

      findings.push({
        rule: pattern.rule,
        description: pattern.description,
        severity: pattern.severity,
        file: relativePath,
        line: lineNum,
        match: lines[lineNum - 1]?.trim().slice(0, 120),
      });
    }
  }

  return findings;
}

/**
 * Scan plugin manifest (package.json or plugin.json) for dangerous tool declarations.
 */
function scanManifest(pluginDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Check package.json
  const pkgPath = path.join(pluginDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

      // Check scripts for dangerous commands
      if (pkg.scripts) {
        for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts)) {
          const cmd = String(scriptCmd);
          if (/\b(?:curl|wget|nc|ncat)\b/.test(cmd)) {
            findings.push({
              rule: 'MANIFEST_DANGEROUS_SCRIPT',
              description: `package.json script "${scriptName}" contains network command`,
              severity: 'HIGH',
              file: 'package.json',
              match: cmd.slice(0, 120),
            });
          }
          if (/\brm\s+-rf\s+\//.test(cmd)) {
            findings.push({
              rule: 'MANIFEST_DESTRUCTIVE_SCRIPT',
              description: `package.json script "${scriptName}" contains destructive command`,
              severity: 'CRITICAL',
              file: 'package.json',
              match: cmd.slice(0, 120),
            });
          }
        }
      }

      // Check for postinstall hooks (common attack vector)
      const hookScripts = ['preinstall', 'postinstall', 'preuninstall', 'postuninstall'];
      for (const hook of hookScripts) {
        if (pkg.scripts?.[hook]) {
          findings.push({
            rule: 'MANIFEST_INSTALL_HOOK',
            description: `package.json has "${hook}" script — runs automatically during install`,
            severity: 'HIGH',
            file: 'package.json',
            match: String(pkg.scripts[hook]).slice(0, 120),
          });
        }
      }
    } catch {
      // Invalid JSON — already logged elsewhere
    }
  }

  // Check for MCP tool declarations in any manifest
  const manifestFiles = ['plugin.json', 'manifest.json', 'mcp.json'];
  for (const name of manifestFiles) {
    const manifestPath = path.join(pluginDir, name);
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (manifest.tools && Array.isArray(manifest.tools)) {
          for (const tool of manifest.tools) {
            const toolName = typeof tool === 'string' ? tool : tool?.name;
            if (toolName && DANGEROUS_TOOL_NAMES.has(toolName.toLowerCase())) {
              findings.push({
                rule: 'MANIFEST_DANGEROUS_TOOL',
                description: `Manifest declares dangerous tool: ${toolName}`,
                severity: 'HIGH',
                file: name,
              });
            }
          }
        }
      } catch {
        // Invalid JSON
      }
    }
  }

  return findings;
}

/**
 * Check plugin directory structure for suspicious patterns.
 */
function scanStructure(pluginDir: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  // Check for symlinks (can escape plugin sandbox to access host files)
  const symlinks = collectSymlinks(pluginDir, 3);
  for (const link of symlinks) {
    const target = (() => {
      try {
        return fs.readlinkSync(link);
      } catch {
        return 'unknown';
      }
    })();
    findings.push({
      rule: 'STRUCTURE_SYMLINK',
      description: `Symlink found pointing to: ${target}`,
      severity: 'CRITICAL',
      file: path.relative(pluginDir, link),
    });
  }

  // Check for binary/compiled files that might be obfuscated
  const suspiciousExtensions = ['.exe', '.dll', '.so', '.dylib', '.bin', '.dat'];
  const files = collectAllFiles(pluginDir, 2);

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (suspiciousExtensions.includes(ext)) {
      findings.push({
        rule: 'STRUCTURE_BINARY',
        description: `Binary file found: ${path.relative(pluginDir, file)}`,
        severity: 'HIGH',
        file: path.relative(pluginDir, file),
      });
    }
  }

  // Check for .env files (might contain leaked secrets)
  const envFiles = files.filter((f) => path.basename(f).startsWith('.env'));
  for (const envFile of envFiles) {
    findings.push({
      rule: 'STRUCTURE_ENV_FILE',
      description: `Environment file found: ${path.basename(envFile)}`,
      severity: 'CRITICAL',
      file: path.relative(pluginDir, envFile),
    });
  }

  return findings;
}

/**
 * Collect all symlinks in a directory tree.
 */
function collectSymlinks(dir: string, maxDepth: number): string[] {
  const links: string[] = [];

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(fullPath);
      } else if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        walk(fullPath, depth + 1);
      }
    }
  }

  walk(dir, 0);
  return links;
}

/**
 * Collect all files (not just scannable ones) up to a given depth.
 */
function collectAllFiles(dir: string, maxDepth: number): string[] {
  const files: string[] = [];
  const SKIP_DIRS = new Set(['node_modules', '.git']);

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(dir, 0);
  return files;
}

/**
 * Compute the highest risk level from a set of findings.
 */
function computeRiskLevel(findings: SecurityFinding[]): RiskSeverity {
  const severityOrder: RiskSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

  for (const level of severityOrder) {
    if (findings.some((f) => f.severity === level)) {
      return level;
    }
  }

  return 'LOW';
}

/**
 * Format scan results as a human-readable summary.
 */
export function formatScanReport(result: ScanResult): string {
  const lines: string[] = [];
  const icon = result.blocked ? '🚫' : result.requiresApproval ? '⚠️' : '✅';

  lines.push(`${icon} Security Scan: ${result.pluginName} — Risk: ${result.riskLevel}`);

  if (result.blocked) {
    lines.push('   ❌ Installation BLOCKED — critical security issues found');
  } else if (result.requiresApproval) {
    lines.push('   ⏳ Admin approval required before installation');
  }

  if (result.findings.length > 0) {
    lines.push('');
    lines.push('   Findings:');
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? ':' + f.line : ''})` : '';
      lines.push(`   [${f.severity}] ${f.rule}: ${f.description}${loc}`);
      if (f.match) {
        lines.push(`          → ${f.match}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format MCP server scan results.
 */
export function formatMcpScanReport(result: McpServerScanResult): string {
  const lines: string[] = [];
  const icon = result.blocked ? '🚫' : result.riskLevel === 'LOW' ? '✅' : '⚠️';

  lines.push(`${icon} MCP Server Scan: ${result.serverName} — Risk: ${result.riskLevel}`);

  for (const f of result.findings) {
    lines.push(`   [${f.severity}] ${f.rule}: ${f.description}`);
    if (f.match) {
      lines.push(`          → ${f.match}`);
    }
  }

  return lines.join('\n');
}
