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
 * Defensive boolean parser for ENV knobs (#666 P4).
 *
 * Accepted truthy: `1`, `true`, `yes`, `on` (case-insensitive, trimmed).
 * Accepted falsy:  `0`, `false`, `no`, `off` (case-insensitive, trimmed).
 * Anything else (including `undefined`/empty) returns `fallback` — unrecognized
 * non-empty values additionally log a warn so an operator typo surfaces
 * instead of silently reverting to the default.
 *
 * Runtime consumers should read the parsed value (e.g. `config.ui.b4NativeStatusEnabled`);
 * this function is exported for unit tests only.
 */
export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const normalized = trimmed.toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  logger.warn(`boolean env "${raw}" unrecognized; falling back to ${fallback}`);
  return fallback;
}

/**
 * Defensive parser for positive-integer ENV knobs (#641 M1-S1). Keeps the
 * per-field inline pattern that the rest of this file uses but avoids
 * duplicating the validate-then-warn boilerplate for every usage-scheduler
 * tunable. Runtime consumers should read the already-parsed value via
 * `config.usage.*`; this is exported so `src/config.test.ts` can lock the
 * clamp + fallback semantics — the function is the only barrier against an
 * operator setting `USAGE_REFRESH_INTERVAL_MS=1` (sub-second tick DDoS).
 *
 * `minimum` (default 0) clamps parsed values that are positive but too small
 * to a safe floor. Catches `USAGE_REFRESH_INTERVAL_MS=1` style foot-guns that
 * would otherwise hammer Anthropic (the tick fires below the 2-minute per-slot
 * backoff so it just bounces, but still burns event-loop time every ms).
 *
 * @internal exported for unit tests; runtime consumers should read
 *           `config.usage.*` / `config.ui.fiveBlockPhase` instead.
 */
export function parsePositiveIntEnv(name: string, fallback: number, minimum: number = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    logger.warn(`${name}="${raw}" invalid (expected positive integer); falling back to ${fallback}`);
    return fallback;
  }
  if (n < minimum) {
    logger.warn(`${name}="${raw}" below minimum ${minimum}; clamping to ${minimum}`);
    return minimum;
  }
  return n;
}

/**
 * Defensive parser for percent (0..100) ENV knobs (#737, units realigned by
 * #778). Fallback when unset / empty / non-numeric. Clamps out-of-range
 * values to `[minimum, maximum]` with a warn.
 *
 * Backwards-compatibility migration (#778):
 *   Before #701, `usage.*.utilization` and these thresholds were stored in
 *   fraction form (0..1). Operators may still have
 *   `AUTO_ROTATE_FIVEH_THRESHOLD=0.8` set in their env from that era. To
 *   avoid silently rejecting every healthy slot (the original #778 bug),
 *   any value satisfying `0 < n <= 1` is auto-migrated to `n * 100` and a
 *   one-shot warn references #778 so operators know to update the env.
 *   `n === 0` is taken at face value (no migration). Ambiguity at the
 *   exact boundary `n === 1` is resolved as legacy fraction → 100, since
 *   "1%" as a percent threshold would itself reject every healthy slot
 *   and is the less plausible operator intent.
 *
 * Inclusive bounds — the spec wording is "≤ 80%", which matches `<=` in
 * the comparator, so `80` must remain a valid threshold.
 *
 * @internal exported for unit tests; runtime consumers should read
 *           `config.autoRotate.*` instead.
 */
export function parsePercentEnv(name: string, fallback: number, minimum: number = 0, maximum: number = 100): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    logger.warn(`${name}="${raw}" invalid (expected number 0..100); falling back to ${fallback}`);
    return fallback;
  }
  // Legacy fraction-form auto-migration. See #778.
  let value = n;
  if (n > 0 && n <= 1) {
    value = n * 100;
    logger.warn(
      `${name}="${raw}" looks like legacy fraction form (0..1); auto-migrating to ${value} (percent). Update your env to avoid this warning. See #778.`,
    );
  }
  if (value < minimum) {
    logger.warn(`${name}="${raw}" below minimum ${minimum}; clamping to ${minimum}`);
    return minimum;
  }
  if (value > maximum) {
    logger.warn(`${name}="${raw}" above maximum ${maximum}; clamping to ${maximum}`);
    return maximum;
  }
  return value;
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
    /**
     * #666 P4 B4 native status spinner kill switch. `false` (default) forces
     * `AssistantStatusManager` to initialize with `enabled=false`, so every
     * `client.assistant.threads.setStatus` call is a no-op even if the Bolt
     * Assistant container has been registered and `assistant:write` is
     * installed. Flip to `true` only once Part 2 (PHASE>=4 turn-surface
     * wiring + legacy suppression) has merged. See docs/slack-ui-phase4.md.
     */
    b4NativeStatusEnabled: parseBool(process.env.SOMA_UI_B4_NATIVE_STATUS, false),
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
    /**
     * Emergency-off: set USAGE_REFRESH_ENABLED=0 to disable the pump.
     * Any other value (or unset) leaves the scheduler enabled. The default-on
     * semantics mean an operator with no env flag still gets the pump, which
     * matches the PR contract — only explicit opt-out kills it.
     */
    refreshEnabled: process.env.USAGE_REFRESH_ENABLED !== '0',
    /**
     * ms between ticks; default 5min. Floor is 30s — below that the tick just
     * bounces off each slot's 2-minute `nextUsageFetchAllowedAt` gate, so a
     * faster interval spins the event loop without producing fresher data.
     */
    refreshIntervalMs: parsePositiveIntEnv('USAGE_REFRESH_INTERVAL_MS', 5 * 60_000, 30_000),
    /** ms deadline for each fan-out; default 2s. */
    fetchTimeoutMs: parsePositiveIntEnv('USAGE_FETCH_TIMEOUT_MS', 2_000),
    /**
     * ms deadline for the Z1 /cct card-open usage fan-out. Default 1500ms —
     * short enough to fit under Slack's 3s ephemeral-post budget even after
     * card-rendering overhead, long enough that a healthy pair of OAuth
     * endpoints return fresh usage in time. Floor 500ms prevents an operator
     * setting this to a value that effectively disables the fan-out.
     */
    cardOpenTimeoutMs: parsePositiveIntEnv('USAGE_ON_OPEN_TIMEOUT_MS', 1_500, 500),
  },
  /**
   * CCT OAuth-token refresh scheduler knobs (#653 M2). Default 1-hour
   * cadence surfaces stale refreshTokens within an hour rather than
   * waiting for a dispatch to touch the slot, and keeps the "OAuth
   * refreshes in X" hint on the card honest.
   */
  oauthRefresh: {
    /**
     * Emergency-off: set OAUTH_REFRESH_ENABLED=0 to disable the hourly pump.
     * Default-on: any other value (or unset) leaves the scheduler active,
     * which is the intended behaviour — operators must explicitly opt out.
     */
    enabled: process.env.OAUTH_REFRESH_ENABLED !== '0',
    /**
     * ms between ticks; default 1 hour. Floor is 5 minutes — below that,
     * the scheduler churns refresh endpoints faster than the 8-hour token
     * TTL warrants, which burns Anthropic-side rate limit for no gain.
     */
    intervalMs: parsePositiveIntEnv('OAUTH_REFRESH_INTERVAL_MS', 60 * 60_000, 5 * 60_000),
    /**
     * ms deadline for each fan-out; default 30s. Per-slot HTTP call has
     * its own 10s timeout inside `refreshClaudeCredentials`, so 30s is
     * enough headroom for a ~3-slot fleet. Floor 5s prevents ops setting
     * this to a value that cancels every refresh before it completes.
     */
    fanOutTimeoutMs: parsePositiveIntEnv('OAUTH_REFRESH_TIMEOUT_MS', 30_000, 5_000),
  },
  /**
   * Auto CCT rotation (#737) — runs piggybacked on the OAuth refresh
   * scheduler's tick. Disabled implicitly when `OAUTH_REFRESH_ENABLED=0`
   * (the hook never fires); explicitly disable via
   * `AUTO_ROTATE_ENABLED=0` to keep the refresh tick but skip rotation.
   *
   * Thresholds are inclusive upper bounds on usage utilisation in
   * percent form (0..100, per #701; see `parsePercentEnv` and #778).
   * Defaults match the user spec verbatim: 5h ≤ 80%, 7d ≤ 90%.
   */
  autoRotate: {
    /** Emergency-off knob. Default-on. */
    enabled: process.env.AUTO_ROTATE_ENABLED !== '0',
    /**
     * Dry-run mode: evaluate + log + (optionally) notify, but never call
     * `applyToken`. Useful when rolling out the feature on a busy bot
     * to confirm the candidate selection matches expectations before
     * letting it actually flip the active slot.
     */
    dryRun: process.env.AUTO_ROTATE_DRY_RUN === '1',
    /** 5h utilisation upper bound, percent form. Default 80. */
    fiveHourMax: parsePercentEnv('AUTO_ROTATE_FIVEH_THRESHOLD', 80),
    /** 7d utilisation upper bound, percent form. Default 90. */
    sevenDayMax: parsePercentEnv('AUTO_ROTATE_SEVEND_THRESHOLD', 90),
  },
  /**
   * CCT slot card v2 (#668 follow-up) — optional GET /api/oauth/profile
   * fetch that backs the email / rate-limit-tier badge on each slot row.
   * Disabled-by-flag rather than removed so ops can turn it off without a
   * redeploy if the endpoint ever regresses.
   */
  oauthProfile: {
    /** Disable with `OAUTH_PROFILE_ENABLED=0`. Default-on. */
    enabled: process.env.OAUTH_PROFILE_ENABLED !== '0',
    /** Per-fetch timeout, ms. Default 5s. Floor 500ms. */
    timeoutMs: parsePositiveIntEnv('OAUTH_PROFILE_TIMEOUT_MS', 5_000, 500),
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
