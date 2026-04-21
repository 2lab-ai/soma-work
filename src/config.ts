import { WebClient } from '@slack/web-api';
import { Logger } from './logger';

// Logger for preflight checks and config validation
const logger = new Logger('Config');

// Preflight check results
export interface PreflightResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parse SOMA_UI_5BLOCK_PHASE — integer in [0..5] rolling out the 5-block UI
 * refactor (Issue #525). Out-of-range, non-integer, or missing values fall
 * back to 0 (all legacy) with a warn log. This is the single rollout variable
 * for the whole refactor; cumulative prefix semantics (see
 * docs/slack-ui-phase1.md §Rollout).
 *
 * @internal exported for unit tests; runtime consumers should read
 *           `config.ui.fiveBlockPhase` instead.
 */
export function parseFiveBlockPhase(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    logger.warn(`SOMA_UI_5BLOCK_PHASE="${raw}" invalid (expected integer 0..5); falling back to 0`);
    return 0;
  }
  return n;
}

/**
 * Defensive parser for positive-integer ENV knobs (#641 M1-S1). Keeps the
 * per-field inline pattern that the rest of this file uses but avoids
 * duplicating the validate-then-warn boilerplate for every usage-scheduler
 * tunable. Not exported outside this module — callers read the already-
 * parsed value via `config.usage.*`.
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    logger.warn(`${name}="${raw}" invalid (expected positive integer); falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  ui: {
    /**
     * 5-block UI refactor rollout phase (Issue #525):
     *   0 = all legacy (default)
     *   1 = B1 stream consolidation new path
     *   2 = + B2 plan
     *   3 = + B3 choice
     *   4 = + B4 status (requires Assistant container registration — must be
     *                    wired at app-init; see slack-handler.ts app.assistant
     *                    (P4 scope))
     *   5 = + B5 completion marker
     */
    fiveBlockPhase: parseFiveBlockPhase(process.env.SOMA_UI_5BLOCK_PHASE),
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  credentials: {
    enabled: process.env.ENABLE_LOCAL_FILE_CREDENTIALS_JSON === '1',
    autoRestore: process.env.AUTOMATIC_RESTORE_CREDENTIAL === '1',
    alertChannel: process.env.CREDENTIAL_ALERT_CHANNEL || '#backend-general',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  github: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: process.env.GITHUB_PRIVATE_KEY || '',
    installationId: process.env.GITHUB_INSTALLATION_ID || '',
    token: process.env.GITHUB_TOKEN || '',
  },
  adminUsers: (process.env.ADMIN_USERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  conversation: {
    summaryModel: process.env.SUMMARY_MODEL || 'claude-sonnet-4-6',
    viewerHost: process.env.CONVERSATION_VIEWER_HOST || '127.0.0.1',
    viewerPort: process.env.CONVERSATION_VIEWER_PORT ? parseInt(process.env.CONVERSATION_VIEWER_PORT, 10) : 0,
    viewerUrl: process.env.CONVERSATION_VIEWER_URL || '',
    viewerToken: process.env.CONVERSATION_VIEWER_TOKEN || '',
  },
  oauth: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    },
    jwtSecret: process.env.DASHBOARD_JWT_SECRET || '',
    /** Seconds until dashboard JWT expires (default: 7 days) */
    jwtExpiresIn: parseInt(process.env.DASHBOARD_JWT_EXPIRES_IN || '604800', 10),
  },
  /**
   * CCT usage-refresh scheduler knobs (#641 M1-S1). Default 5-minute
   * interval balances freshness against the per-slot 2-minute backoff on
   * `nextUsageFetchAllowedAt` — shorter intervals just bounce off the
   * gate, longer intervals let the card go stale.
   */
  usage: {
    /** Emergency-off: set USAGE_REFRESH_DISABLED=1 to disable the pump. */
    refreshEnabled: process.env.USAGE_REFRESH_DISABLED !== '1',
    /** ms between ticks; default 5min. */
    refreshIntervalMs: parsePositiveIntEnv('USAGE_REFRESH_INTERVAL_MS', 5 * 60_000),
    /** ms deadline for each fan-out; default 2s. */
    fetchTimeoutMs: parsePositiveIntEnv('USAGE_FETCH_TIMEOUT_MS', 2_000),
  },
};

export function validateConfig() {
  const required = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Auth is handled exclusively via Agent SDK (OAuth)
  logger.info('Auth: Agent SDK (OAuth via CLAUDE_CODE_OAUTH_TOKEN)');
}

/**
 * Comprehensive preflight checks for environment configuration
 * Returns detailed errors and warnings
 */
export async function runPreflightChecks(): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  logger.info('Running preflight checks...');

  // ===== 1. Slack Token Format Validation =====
  const slackBotToken = process.env.SLACK_BOT_TOKEN || '';
  const slackAppToken = process.env.SLACK_APP_TOKEN || '';
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || '';

  // Bot token format
  if (!slackBotToken) {
    errors.push('❌ SLACK_BOT_TOKEN: Missing');
  } else if (!slackBotToken.startsWith('xoxb-')) {
    errors.push(
      `❌ SLACK_BOT_TOKEN: Invalid format (should start with "xoxb-", got "${slackBotToken.substring(0, 10)}...")`,
    );
  } else {
    logger.info('SLACK_BOT_TOKEN: Format OK (xoxb-...)');
  }

  // App token format (Socket Mode)
  if (!slackAppToken) {
    errors.push('❌ SLACK_APP_TOKEN: Missing');
  } else if (!slackAppToken.startsWith('xapp-')) {
    errors.push(
      `❌ SLACK_APP_TOKEN: Invalid format (should start with "xapp-", got "${slackAppToken.substring(0, 10)}...")`,
    );
  } else {
    logger.info('SLACK_APP_TOKEN: Format OK (xapp-...)');
  }

  // Signing secret
  if (!slackSigningSecret) {
    errors.push('❌ SLACK_SIGNING_SECRET: Missing');
  } else if (slackSigningSecret.length < 20) {
    warnings.push(`⚠️ SLACK_SIGNING_SECRET: Unusually short (${slackSigningSecret.length} chars)`);
  } else {
    logger.info('SLACK_SIGNING_SECRET: Present');
  }

  // ===== 2. Slack API Connection Test =====
  if (slackBotToken && slackBotToken.startsWith('xoxb-')) {
    try {
      const client = new WebClient(slackBotToken);
      const authResult = await client.auth.test();
      if (authResult.ok) {
        logger.info(`Slack API: Connected as @${authResult.user} (bot_id: ${authResult.bot_id})`);
        logger.info(`Team: ${authResult.team} (${authResult.team_id})`);
      } else {
        errors.push(`❌ Slack API: auth.test failed - ${authResult.error}`);
      }
    } catch (err: any) {
      errors.push(`❌ Slack API: Connection failed - ${err.message}`);
      if (err.message.includes('invalid_auth')) {
        errors.push('   → Token is invalid or revoked. Regenerate in Slack App settings.');
      }
    }
  }

  // ===== 3. Auth: Agent SDK Only (no ANTHROPIC_API_KEY needed) =====
  if (process.env.ANTHROPIC_API_KEY) {
    warnings.push('⚠️ ANTHROPIC_API_KEY is set but unused — all auth uses Agent SDK (OAuth)');
  }

  // ===== 4. GitHub Configuration =====
  const githubAppId = process.env.GITHUB_APP_ID || '';
  const githubPrivateKey = process.env.GITHUB_PRIVATE_KEY || '';
  const githubInstallationId = process.env.GITHUB_INSTALLATION_ID || '';
  const githubToken = process.env.GITHUB_TOKEN || '';

  if (githubAppId || githubPrivateKey || githubInstallationId) {
    // GitHub App mode
    if (!githubAppId) {
      errors.push('❌ GITHUB_APP_ID: Missing (required for GitHub App auth)');
    } else {
      logger.info(`GITHUB_APP_ID: ${githubAppId}`);
    }

    if (!githubPrivateKey) {
      errors.push('❌ GITHUB_PRIVATE_KEY: Missing (required for GitHub App auth)');
    } else if (!githubPrivateKey.includes('BEGIN') || !githubPrivateKey.includes('PRIVATE KEY')) {
      errors.push('❌ GITHUB_PRIVATE_KEY: Invalid format (should be PEM format with BEGIN/END markers)');
    } else {
      logger.info('GITHUB_PRIVATE_KEY: Format OK (PEM)');
    }

    if (!githubInstallationId) {
      warnings.push('⚠️ GITHUB_INSTALLATION_ID: Not set (will auto-discover)');
    } else {
      logger.info(`GITHUB_INSTALLATION_ID: ${githubInstallationId}`);
    }
  } else if (githubToken) {
    // PAT mode
    if (!githubToken.startsWith('ghp_') && !githubToken.startsWith('github_pat_')) {
      warnings.push(`⚠️ GITHUB_TOKEN: Unusual format (expected "ghp_..." or "github_pat_...")`);
    } else {
      logger.info('GITHUB_TOKEN: Using Personal Access Token');
    }
  } else {
    warnings.push('⚠️ GitHub: No authentication configured (GitHub features disabled)');
  }

  // ===== 5. Base Directory (REQUIRED) =====
  const baseDir = process.env.BASE_DIRECTORY || '';
  if (!baseDir) {
    errors.push('❌ BASE_DIRECTORY: Required but not set. Set it in .env file.');
    errors.push('   → Each user will have a fixed directory: {BASE_DIRECTORY}/{userId}/');
  } else {
    const fs = await import('fs');
    if (!fs.existsSync(baseDir)) {
      errors.push(`❌ BASE_DIRECTORY: Path does not exist: ${baseDir}`);
    } else {
      logger.info(`BASE_DIRECTORY: ${baseDir}`);
      logger.info('User directories will be created as: {BASE_DIRECTORY}/{userId}/');
    }
  }

  // ===== 6. Print Summary =====
  logger.info('='.repeat(50));
  if (errors.length === 0 && warnings.length === 0) {
    logger.info('All preflight checks passed!');
  } else {
    if (errors.length > 0) {
      logger.error(`ERRORS (${errors.length}):`);
      errors.forEach((e) => logger.error(`  ${e}`));
    }
    if (warnings.length > 0) {
      logger.warn(`WARNINGS (${warnings.length}):`);
      warnings.forEach((w) => logger.warn(`  ${w}`));
    }
  }
  logger.info('='.repeat(50));

  return {
    success: errors.length === 0,
    errors,
    warnings,
  };
}
