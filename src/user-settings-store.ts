import fs from 'fs';
import path from 'path';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  type PermissionMode,
  resolvePermissionMode,
} from './agent-runtime/policy/permission-mode';
import { DATA_DIR as ENV_DATA_DIR } from './env-paths';
import { Logger } from './logger.js';
import { createPromptInvalidator } from './prompt-cache-invalidation';
import { DEFAULT_LOG_VERBOSITY, getVerbosityFlags, type LogVerbosity, VERBOSITY_NAMES } from './slack/output-flags';
import { maskUrl } from './turn-notifier.js';

const logger = new Logger('UserSettingsStore');

// Settings feed the system prompt (persona, model, verbosity, effort, etc.)
// so mutations need to drop cached systemPrompt snapshots. Wired at startup
// in `src/index.ts`; shared helper handles the null-safe + error-swallow
// contract.
const invalidator = createPromptInvalidator(logger, 'Settings');
export const setSettingsPromptInvalidationHook = invalidator.setHook;
const fireSettingsInvalidate = invalidator.fire;

// Available models — the 11-entry user-facing allow-list.
//
// Contract:
//   - The 8 bare entries are the historical lineup and MUST NOT be removed.
//     (Fable 5 added 2026-06-09; 4.8 added 2026-05-28; 4.7/4.6 retained as
//     user-selectable.)
//   - `claude-fable-5` serves a 1M context window on the BARE id — Fable 5
//     ships 1M as its native GA context, with no `[1m]` suffix and no
//     `context-1m-2025-08-07` beta header. It therefore has NO `[1m]` variant:
//     resolveContextWindow recognises it as native-1M (see model-registry.ts).
//   - The 3 `[1m]` entries are additive: they enable the 1M *beta* context
//     window on opus-4-8 / opus-4-7 / opus-4-6 via the shared suffix
//     convention. The Claude Agent SDK (≥ 0.2.111) detects `[1m]`, strips it
//     before the API call, and injects the `context-1m-2025-08-07` beta header.
//     (Opus 4.8 ships 1M by default; we keep the `[1m]` opt-in here as the
//     single resolveContextWindow signal — see metrics/model-registry.ts.)
//
// Issue #656 regression guard: any shrinking of this list (as attempted in
// abandoned PR #652) silently deletes user-selectable models. Tests assert
// exact array equality — NOT just length — to catch that class of mistake.
export const AVAILABLE_MODELS = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8[1m]',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6[1m]',
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number];

// Model aliases for user-friendly input.
//
// "Latest opus" contract:
//   - The bare `opus` and `opus[1m]` aliases follow the current latest opus
//     and are the single update point when a new opus release ships. To roll
//     forward to 4.9, only these two rows + AVAILABLE_MODELS need to change —
//     DEFAULT_MODEL inherits the new pointer (see below).
//   - Version-pinned aliases (`opus-4.8`, `opus-4.7`, ...) remain stable so
//     users who explicitly chose a generation don't get silently upgraded.
export const MODEL_ALIASES: Record<string, ModelId> = {
  // `fable` / `fable-5` → Fable 5. There is no `[1m]` variant: Fable 5 is
  // native-1M on the bare id, so no suffix alias is offered (a `[1m]` suffix
  // would wrongly trigger the opus beta-header path in the SDK).
  fable: 'claude-fable-5',
  'fable-5': 'claude-fable-5',
  sonnet: 'claude-sonnet-4-6',
  'sonnet-4.6': 'claude-sonnet-4-6',
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  // `opus` / `opus[1m]` follow the current latest opus — bump these two rows
  // (plus AVAILABLE_MODELS) when a new generation lands.
  opus: 'claude-opus-4-8',
  'opus-4.8': 'claude-opus-4-8',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.5': 'claude-opus-4-5-20251101',
  haiku: 'claude-haiku-4-5-20251001',
  'haiku-4.5': 'claude-haiku-4-5-20251001',
  // 1M-context (beta opt-in) variants — opus only. Fable 5 is native-1M on
  // the bare id and intentionally has no `[1m]` alias here.
  'opus[1m]': 'claude-opus-4-8[1m]',
  'opus-4.8[1m]': 'claude-opus-4-8[1m]',
  'opus-4.7[1m]': 'claude-opus-4-7[1m]',
  'opus-4.6[1m]': 'claude-opus-4-6[1m]',
};

// DEFAULT_MODEL is a logical pointer to the current latest opus + 1M context.
// Flipping MODEL_ALIASES['opus[1m]'] propagates here automatically — single-
// line edit per new opus release. The `??` literal is a defence-in-depth
// fallback for the (test-asserted) case where the alias is ever dropped; the
// Issue #656 exact-set test fails loud at CI time before that branch matters.
export const DEFAULT_MODEL: ModelId = MODEL_ALIASES['opus[1m]'] ?? 'claude-opus-4-8[1m]';

/**
 * Coerce arbitrary stored input to a known ModelId, falling back to DEFAULT_MODEL.
 *
 * - Accepts null/undefined/non-string → DEFAULT_MODEL.
 * - Trims + lowercases (handles hand-edited JSON with whitespace or uppercase
 *   `[1M]` typos).
 * - Known entries pass through unchanged (including legacy but-still-valid
 *   `claude-sonnet-4-6`, `claude-opus-4-5-20251101`, etc.).
 * - Unknown entries fall back to DEFAULT_MODEL.
 *
 * Used by: loadSettings, session-registry deserialize path, and
 * deploy/main-env-bootstrap normalization.
 */
export function coerceToAvailableModel(raw: string | null | undefined): ModelId {
  if (typeof raw !== 'string') return DEFAULT_MODEL;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return DEFAULT_MODEL;
  if ((AVAILABLE_MODELS as readonly string[]).includes(normalized)) {
    return normalized as ModelId;
  }
  return DEFAULT_MODEL;
}

// Effort levels
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const DEFAULT_EFFORT: EffortLevel = 'xhigh';

/** Coerce arbitrary stored input to a known EffortLevel, falling back to DEFAULT_EFFORT. */
export function coerceEffort(value: unknown): EffortLevel {
  return (EFFORT_LEVELS as readonly unknown[]).includes(value) ? (value as EffortLevel) : DEFAULT_EFFORT;
}

// Thinking (adaptive reasoning) toggle
export const DEFAULT_THINKING_ENABLED = true;

// Thinking summary (show thinking output in Slack) toggle
export const DEFAULT_SHOW_THINKING = true;

// UI display themes — 3-tier system (shared across Session List, Thread Header, Turn End, AskUser)
const SESSION_THEMES = ['default', 'compact', 'minimal'] as const;
export type SessionTheme = (typeof SESSION_THEMES)[number];
const DEFAULT_THEME: SessionTheme = 'default';
export const THEME_NAMES: Record<SessionTheme, string> = {
  default: 'Default (Rich Card)',
  compact: 'Compact',
  minimal: 'Minimal',
};

// Legacy theme migration map (12-letter system → 3-tier)
type LegacyTheme = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L';
const LEGACY_THEME_MAP: Record<LegacyTheme, SessionTheme> = {
  A: 'minimal',
  B: 'minimal',
  C: 'compact',
  D: 'compact',
  E: 'default',
  F: 'compact',
  G: 'default',
  H: 'default',
  I: 'default',
  J: 'default',
  K: 'default',
  L: 'default',
};

/** Migrate legacy A-L theme to 3-tier. Returns as-is if already 3-tier. */
export function migrateLegacyTheme(theme: string): SessionTheme {
  if (SESSION_THEMES.includes(theme as SessionTheme)) return theme as SessionTheme;
  const legacy = LEGACY_THEME_MAP[theme.toUpperCase() as LegacyTheme];
  return legacy ?? DEFAULT_THEME;
}

export interface UserSettings {
  userId: string;
  defaultDirectory: string;
  /**
   * Legacy boolean permission flag. Superseded by `permissionMode` but kept for
   * backward-compatible migration (`true` → `bypass`). New writes go through
   * `setUserPermissionMode`, which keeps this field in sync.
   */
  bypassPermission: boolean;
  /**
   * Tri-state permission mode: `auto` (default) | `bypass` (unsafe) | `legacy`.
   * Undefined → resolved via `resolvePermissionMode` (default `auto`).
   */
  permissionMode?: PermissionMode;
  persona: string; // persona file name (without .md extension)
  defaultModel: ModelId; // default model for new sessions
  defaultLogVerbosity?: LogVerbosity; // default log verbosity for new sessions
  sessionTheme?: SessionTheme; // UI display theme. undefined = default ('default' Rich Card)
  defaultEffort?: EffortLevel; // default effort level for new sessions
  /** Whether extended thinking (adaptive reasoning) is enabled for new sessions. Default: true */
  thinkingEnabled?: boolean;
  /** Whether thinking output is shown in Slack. Default: true */
  showThinking?: boolean;
  /** Whether sandbox is disabled for this user. Default: false (sandbox ON). Admin-only toggle. */
  sandboxDisabled?: boolean;
  /**
   * Whether sandbox network access is disabled for this user. Default: false
   * (network ON — preset dev-domain allowlist applied). Any user may toggle.
   * No effect while `sandboxDisabled` is true.
   */
  networkDisabled?: boolean;
  lastUpdated: string;
  // Jira integration
  jiraAccountId?: string;
  jiraName?: string;
  /** Slack `real_name` (from `users.info`). Used as a display label. */
  slackName?: string;
  /**
   * Slack profile `display_name` — the short handle shown in chat, which users
   * type to reference each other (e.g. "Z"). Often differs from `slackName`
   * (`real_name`, e.g. "Zhuge"). Captured so cross-user skill invocation
   * (`$Z:skill`) resolves the display name, not just the real_name.
   */
  slackDisplayName?: string;
  /** Epoch ms of the last Slack identity (display_name) sync — drives TTL refresh. */
  slackIdentitySyncedAt?: number;
  email?: string; // Slack profile email (auto-fetched via users.info)
  /** Model rating (0-10, default 5). Used for <your_rating> context tag. */
  rating?: number;
  /** Pending rating change notification (consumed once after user changes rating). */
  pendingRatingChange?: { from: number; to: number };
  // User acceptance (admin approval)
  accepted: boolean;
  acceptedBy?: string;
  acceptedAt?: string;
  // Notification preferences
  notification?: NotificationSettings;
  /**
   * Whether the one-time `/z` migration tombstone hint has been shown to
   * this user. Set via CAS (see `markMigrationHintShown`).
   * Phase 1 of /z refactor (#506).
   */
  migrationHintShown?: boolean;
  /**
   * Compaction threshold (percent). Integer 50–95. When the current turn's
   * context-usage% reaches this value, the next user turn is auto-compacted.
   * Undefined = use `DEFAULT_COMPACT_THRESHOLD` (no migration needed).
   * See #617.
   */
  compactThreshold?: number;
  /**
   * Autogoal mode. When `true`, the first user instruction in a session that
   * has no active/queued goal is automatically promoted to the session goal.
   * Toggled via `goal auto` / `set goal auto`. Undefined ⇒ default `false`.
   */
  autoGoalEnabled?: boolean;
  /**
   * Per-user default for a new goal's auto-continuation cap
   * (`SessionGoal.maxContinuations`). Set via `goal max <N>` / `set goal <N>`.
   * Undefined ⇒ `DEFAULT_GOAL_MAX_CONTINUATIONS` (10). Bounded
   * {@link GOAL_MAX_CONTINUATIONS_MIN}..{@link GOAL_MAX_CONTINUATIONS_MAX}.
   */
  goalMaxContinuations?: number;
  /**
   * Per-user auto-injected skills. Each entry is a skill NAME (kebab-case,
   * resolved via the same user→local→plugin fallback chain as `$skill`). When
   * non-empty, every fresh system-prompt build for this user force-injects the
   * full SKILL.md content of each listed skill in an `<auto_invoked_skills>`
   * block — so a new session/task always starts with these skills active.
   * Managed via the `autoskill` command + card. Undefined ⇒ none.
   */
  autoskills?: string[];
}

/** Max number of auto-injected skills a user may register. */
export const MAX_AUTOSKILLS = 20;

// Goal auto-continuation cap bounds (S4). The default lives in
// `src/types.ts` (`DEFAULT_GOAL_MAX_CONTINUATIONS`) which the package tree
// cannot import; this store only validates/clamps the user-supplied override.
export const GOAL_MAX_CONTINUATIONS_MIN = 1;
export const GOAL_MAX_CONTINUATIONS_MAX = 1000;

/**
 * Clamp/validate a user-supplied goal max-continuations value. Throws a
 * user-facing `Error` (surfaced verbatim to Slack) on a non-integer; clamps
 * an out-of-range integer into the valid band.
 */
export function validateGoalMaxContinuations(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('goal max must be an integer');
  }
  return Math.min(GOAL_MAX_CONTINUATIONS_MAX, Math.max(GOAL_MAX_CONTINUATIONS_MIN, value));
}

// Compaction Tracking (#617): threshold bounds + default.
export const DEFAULT_COMPACT_THRESHOLD = 80;
export const COMPACT_THRESHOLD_MIN = 50;
export const COMPACT_THRESHOLD_MAX = 95;

/**
 * Validate a compactThreshold value. Throws a user-facing `Error` on failure.
 * Error messages are surfaced verbatim to Slack via the command handler.
 */
export function validateCompactThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('compactThreshold must be an integer');
  }
  if (value < COMPACT_THRESHOLD_MIN || value > COMPACT_THRESHOLD_MAX) {
    throw new Error(`compactThreshold must be in [${COMPACT_THRESHOLD_MIN}, ${COMPACT_THRESHOLD_MAX}]`);
  }
  return value;
}

export interface NotificationSettings {
  slackDm?: boolean;
  webhookUrl?: string;
  telegramChatId?: string;
  categories?: {
    userAskQuestion?: boolean;
    workflowComplete?: boolean;
    exception?: boolean;
  };
}

interface SlackJiraMapping {
  [slackId: string]: {
    jiraAccountId: string;
    name: string;
    slackName?: string;
    jiraName?: string;
  };
}

interface SettingsData {
  [userId: string]: UserSettings;
}

/**
 * File-based store for user settings persistence
 * Stores user preferences like default working directory
 */
export class UserSettingsStore {
  private settingsFile: string;
  private mappingFile: string;
  private settings: SettingsData = {};
  private slackJiraMapping: SlackJiraMapping = {};

  constructor(dataDir?: string) {
    // Use data directory or default to project root
    const dir = dataDir || ENV_DATA_DIR;

    // Ensure data directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info('Created data directory', { dir });
    }

    this.settingsFile = path.join(dir, 'user-settings.json');
    this.mappingFile = path.join(dir, 'slack_jira_mapping.json');
    this.loadSettings();
    this.loadSlackJiraMapping();
  }

  /**
   * Load settings from file
   */
  private loadSettings(): void {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const data = fs.readFileSync(this.settingsFile, 'utf8');
        this.settings = JSON.parse(data);
        let didUpdate = false;
        for (const userSettings of Object.values(this.settings)) {
          // Coerce to the 8-entry allow-list. Known-legacy ids (e.g. sonnet-4-6,
          // opus-4-5-20251101) pass through; only unknown/missing values fall
          // back to DEFAULT_MODEL.
          const coerced = coerceToAvailableModel(userSettings.defaultModel);
          if (coerced !== userSettings.defaultModel) {
            userSettings.defaultModel = coerced;
            didUpdate = true;
          }
          // Migration: grandfathering — existing users without accepted field get accepted=true
          if ((userSettings as any).accepted === undefined) {
            userSettings.accepted = true;
            didUpdate = true;
          }
          // Coerce unknown defaultEffort values to DEFAULT_EFFORT
          if (userSettings.defaultEffort !== undefined) {
            const coerced = coerceEffort(userSettings.defaultEffort);
            if (coerced !== userSettings.defaultEffort) {
              userSettings.defaultEffort = coerced;
              didUpdate = true;
            }
          }
        }
        if (didUpdate) {
          this.saveSettings();
          logger.info('Updated user settings model defaults', {
            userCount: Object.keys(this.settings).length,
          });
        }
        logger.info('Loaded user settings', {
          userCount: Object.keys(this.settings).length,
        });
      } else {
        this.settings = {};
        logger.info('No existing settings file, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to load user settings', error);
      this.settings = {};
    }
  }

  /**
   * Load Slack-Jira mapping from file
   */
  private loadSlackJiraMapping(): void {
    try {
      if (fs.existsSync(this.mappingFile)) {
        const data = fs.readFileSync(this.mappingFile, 'utf8');
        this.slackJiraMapping = JSON.parse(data);
        logger.info('Loaded Slack-Jira mapping', {
          mappingCount: Object.keys(this.slackJiraMapping).length,
        });
      } else {
        this.slackJiraMapping = {};
        logger.info('No Slack-Jira mapping file found');
      }
    } catch (error) {
      logger.error('Failed to load Slack-Jira mapping', error);
      this.slackJiraMapping = {};
    }
  }

  /**
   * Reload Slack-Jira mapping (for runtime updates)
   */
  reloadSlackJiraMapping(): void {
    this.loadSlackJiraMapping();
  }

  /**
   * Save settings to file
   */
  private saveSettings(): void {
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2), 'utf8');
      logger.debug('Saved user settings to file');
    } catch (error) {
      logger.error('Failed to save user settings', error);
    }
  }

  /**
   * Update user's Jira info from Slack-Jira mapping
   * Called when a user sends a message to sync their Jira info
   */
  updateUserJiraInfo(userId: string, slackName?: string): boolean {
    const mapping = this.slackJiraMapping[userId];
    if (!mapping) {
      logger.debug('No Jira mapping found for user', { userId });
      return false;
    }

    const existing = this.settings[userId];
    const needsUpdate =
      !existing ||
      existing.jiraAccountId !== mapping.jiraAccountId ||
      existing.jiraName !== mapping.name ||
      (slackName && existing.slackName !== slackName);

    if (needsUpdate) {
      // Patch only the Jira-related fields so unrelated settings (e.g.
      // networkDisabled, sandboxDisabled, sessionTheme, notification, etc.)
      // are preserved. Previously this path overwrote the whole record and
      // silently reset any field not listed here.
      this.patchUserSettings(userId, {
        jiraAccountId: mapping.jiraAccountId,
        jiraName: mapping.name,
        slackName: slackName || mapping.slackName || existing?.slackName,
      });
      logger.info('Updated user Jira info', {
        userId,
        jiraAccountId: mapping.jiraAccountId,
        jiraName: mapping.name,
        slackName,
      });
      return true;
    }

    return false;
  }

  /**
   * Get user's Jira account ID
   */
  getUserJiraAccountId(userId: string): string | undefined {
    return this.settings[userId]?.jiraAccountId;
  }

  /**
   * Get user's Jira name
   */
  getUserJiraName(userId: string): string | undefined {
    return this.settings[userId]?.jiraName;
  }

  /**
   * Get user's email (auto-fetched from Slack profile)
   */
  getUserEmail(userId: string): string | undefined {
    return this.settings[userId]?.email;
  }

  /**
   * Set user's email
   */
  setUserEmail(userId: string, email: string): void {
    this.patchUserSettings(userId, { email });
    logger.info('Set user email', { userId, email });
  }

  /**
   * Record the user's Slack `display_name` (the handle shown in chat) and stamp
   * the identity sync time. Drives cross-user skill invocation by display name
   * (`$Z:skill`). No-op when the value is unchanged so a stale-refresh that
   * finds the same name doesn't churn the system-prompt cache.
   */
  setUserSlackDisplayName(userId: string, displayName: string): void {
    const existing = this.settings[userId];
    if (existing?.slackDisplayName === displayName && existing.slackIdentitySyncedAt) {
      // Same name — just refresh the sync stamp without an invalidation.
      existing.slackIdentitySyncedAt = Date.now();
      this.saveSettings();
      return;
    }
    this.patchUserSettings(userId, { slackDisplayName: displayName, slackIdentitySyncedAt: Date.now() });
    logger.info('Set user Slack display name', { userId, displayName });
  }

  /**
   * Whether the user's Slack display_name should be (re-)fetched from Slack:
   * true when never synced, or synced longer than `ttlMs` ago. Periodic refresh
   * keeps the display name current when a user renames themselves in Slack.
   */
  shouldRefreshSlackIdentity(userId: string, ttlMs: number): boolean {
    const at = this.settings[userId]?.slackIdentitySyncedAt;
    if (typeof at !== 'number') return true;
    return Date.now() - at > ttlMs;
  }

  /**
   * Get user's model rating (0-10, default 5)
   */
  getUserRating(userId: string): number {
    const rating = this.settings[userId]?.rating;
    return typeof rating === 'number' ? Math.max(0, Math.min(10, rating)) : 5;
  }

  /**
   * Set user's model rating (clamped to 0-10)
   */
  setUserRating(userId: string, rating: number): void {
    const clamped = Math.max(0, Math.min(10, rating));
    this.patchUserSettings(userId, { rating: clamped } as Partial<UserSettings>);
    logger.info('Set user rating', { userId, rating: clamped });
  }

  /**
   * Set pending rating change notification (consumed once on next message)
   */
  setPendingRatingChange(userId: string, change: { from: number; to: number }): void {
    this.patchUserSettings(userId, { pendingRatingChange: change } as Partial<UserSettings>);
  }

  /**
   * Consume pending rating change (read and clear). Returns null if none pending.
   */
  consumePendingRatingChange(userId: string): { from: number; to: number } | null {
    const change = this.settings[userId]?.pendingRatingChange;
    if (!change) return null;
    this.patchUserSettings(userId, { pendingRatingChange: undefined } as Partial<UserSettings>);
    return change;
  }

  /**
   * @deprecated Working directories are now fixed per user ({BASE_DIRECTORY}/{userId}/).
   * This method is kept for backward compatibility but the value is no longer used.
   */
  getUserDefaultDirectory(userId: string): string | undefined {
    logger.debug('getUserDefaultDirectory called (deprecated)', { userId });
    // Return undefined to indicate no custom directory - fixed directories are now used
    return undefined;
  }

  /**
   * @deprecated Working directories are now fixed per user ({BASE_DIRECTORY}/{userId}/).
   * This method is kept for backward compatibility but does nothing.
   */
  setUserDefaultDirectory(userId: string, _directory: string): void {
    logger.debug('setUserDefaultDirectory called (deprecated, no-op)', { userId });
    // No-op: Working directories are now fixed per user
  }

  /**
   * Patch one or more fields on a user's settings record.
   * Creates a new record with defaults if the user does not yet exist.
   * Saves to disk after applying the patch.
   */
  private patchUserSettings(userId: string, patch: Partial<UserSettings>): void {
    if (this.settings[userId]) {
      Object.assign(this.settings[userId], patch, { lastUpdated: new Date().toISOString() });
    } else {
      this.settings[userId] = {
        userId,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: DEFAULT_MODEL,
        accepted: true,
        lastUpdated: new Date().toISOString(),
        ...patch,
      };
    }
    this.saveSettings();
    // Centralised invalidation — every settings mutation funnels through
    // here, so hooking the hot path once covers persona / model / verbosity
    // / effort / theme / bypass / network etc without call-site duplication.
    fireSettingsInvalidate(userId);
  }

  /**
   * Get user's bypass permission setting
   */
  getUserBypassPermission(userId: string): boolean {
    return this.settings[userId]?.bypassPermission ?? false;
  }

  /**
   * Set user's bypass permission setting
   */
  setUserBypassPermission(userId: string, bypass: boolean): void {
    this.patchUserSettings(userId, { bypassPermission: bypass });
    logger.info('Set user bypass permission', { userId, bypass });
  }

  /**
   * Resolve the user's effective permission mode (`auto` | `bypass` | `legacy`).
   * Defaults to `auto`; migrates a legacy `bypassPermission:true` to `bypass`.
   */
  getUserPermissionMode(userId: string): PermissionMode {
    return resolvePermissionMode(this.settings[userId]);
  }

  /**
   * Set the user's permission mode. Keeps the legacy `bypassPermission` boolean
   * in sync so any remaining boolean readers stay consistent.
   */
  setUserPermissionMode(userId: string, mode: PermissionMode): void {
    if (!isPermissionMode(mode)) {
      logger.warn('Ignoring invalid permission mode', { userId, mode });
      return;
    }
    this.patchUserSettings(userId, { permissionMode: mode, bypassPermission: mode === 'bypass' });
    logger.info('Set user permission mode', { userId, mode });
  }

  /**
   * Get user's sandbox disabled setting. Returns false (sandbox ON) by default.
   */
  getUserSandboxDisabled(userId: string): boolean {
    return this.settings[userId]?.sandboxDisabled ?? false;
  }

  /**
   * Set user's sandbox disabled setting. Admin-only toggle.
   */
  setUserSandboxDisabled(userId: string, disabled: boolean): void {
    this.patchUserSettings(userId, { sandboxDisabled: disabled });
    logger.info('Set user sandbox disabled', { userId, disabled });
  }

  /**
   * Get user's sandbox-network disabled setting. Returns false (network ON)
   * by default. Any user may toggle this; value is only effective when
   * `sandboxDisabled` is also false.
   */
  getUserNetworkDisabled(userId: string): boolean {
    return this.settings[userId]?.networkDisabled ?? false;
  }

  /**
   * Set user's sandbox-network disabled setting.
   *
   * Applies from the next user turn — in-flight SDK queries are not mutated
   * because sandbox settings are OS-enforced (Seatbelt/bubblewrap) and
   * captured at `query()` init time.
   */
  setUserNetworkDisabled(userId: string, disabled: boolean): void {
    this.patchUserSettings(userId, { networkDisabled: disabled });
    logger.info('Set user network disabled', { userId, disabled });
  }

  /**
   * Get user's persona setting
   */
  getUserPersona(userId: string): string {
    return this.settings[userId]?.persona ?? 'default';
  }

  /**
   * Set user's persona setting
   */
  setUserPersona(userId: string, persona: string): void {
    this.patchUserSettings(userId, { persona });
    logger.info('Set user persona', { userId, persona });
  }

  /**
   * Get user's default model
   */
  getUserDefaultModel(userId: string): ModelId {
    return this.settings[userId]?.defaultModel ?? DEFAULT_MODEL;
  }

  /**
   * Set user's default model
   */
  setUserDefaultModel(userId: string, model: ModelId): void {
    this.patchUserSettings(userId, { defaultModel: model });
    logger.info('Set user default model', { userId, model });
  }

  /**
   * Get user's default log verbosity
   */
  getUserDefaultLogVerbosity(userId: string): LogVerbosity {
    return this.settings[userId]?.defaultLogVerbosity ?? DEFAULT_LOG_VERBOSITY;
  }

  /**
   * Get user's default log verbosity as bitmask
   */
  getUserLogVerbosityFlags(userId: string): number {
    return getVerbosityFlags(this.getUserDefaultLogVerbosity(userId));
  }

  /**
   * Set user's default log verbosity
   */
  setUserDefaultLogVerbosity(userId: string, verbosity: LogVerbosity): void {
    this.patchUserSettings(userId, { defaultLogVerbosity: verbosity });
    logger.info('Set user default log verbosity', { userId, verbosity });
  }

  /**
   * Get user's compaction threshold (percent, 50–95).
   * Returns `DEFAULT_COMPACT_THRESHOLD` when unset (#617 AC2).
   */
  getUserCompactThreshold(userId: string): number {
    return this.settings[userId]?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
  }

  /**
   * Set user's compaction threshold (#617 AC1). Validates bounds + integer-ness
   * before persisting. Throws on invalid input — caller surfaces the message.
   */
  setUserCompactThreshold(userId: string, value: number): void {
    const validated = validateCompactThreshold(value);
    this.patchUserSettings(userId, { compactThreshold: validated });
    logger.info('Set user compact threshold', { userId, value: validated });
  }

  /**
   * Get user's default effort level
   */
  getUserDefaultEffort(userId: string): EffortLevel {
    return this.settings[userId]?.defaultEffort ?? DEFAULT_EFFORT;
  }

  /**
   * Set user's default effort level
   */
  setUserDefaultEffort(userId: string, effort: EffortLevel): void {
    this.patchUserSettings(userId, { defaultEffort: effort });
    logger.info('Set user default effort', { userId, effort });
  }

  /**
   * Get user's autogoal mode (S2). Default `false`.
   */
  getUserAutoGoalEnabled(userId: string): boolean {
    return this.settings[userId]?.autoGoalEnabled ?? false;
  }

  /**
   * Set user's autogoal mode and return the persisted value.
   */
  setUserAutoGoalEnabled(userId: string, enabled: boolean): void {
    this.patchUserSettings(userId, { autoGoalEnabled: enabled });
    logger.info('Set user autogoal mode', { userId, enabled });
  }

  /**
   * Toggle user's autogoal mode, returning the NEW value.
   */
  toggleUserAutoGoalEnabled(userId: string): boolean {
    const next = !this.getUserAutoGoalEnabled(userId);
    this.setUserAutoGoalEnabled(userId, next);
    return next;
  }

  /**
   * Get user's default goal max-continuations (S4). Undefined ⇒ caller falls
   * back to `DEFAULT_GOAL_MAX_CONTINUATIONS`.
   */
  getUserGoalMaxContinuations(userId: string): number | undefined {
    return this.settings[userId]?.goalMaxContinuations;
  }

  /**
   * Set user's default goal max-continuations (already validated/clamped by
   * {@link validateGoalMaxContinuations}).
   */
  setUserGoalMaxContinuations(userId: string, value: number): void {
    this.patchUserSettings(userId, { goalMaxContinuations: value });
    logger.info('Set user goal max-continuations', { userId, value });
  }

  /**
   * Get user's auto-injected skill names (S-autoskill). Returns a defensive
   * copy so callers can't mutate the stored array. Empty when unset.
   */
  getUserAutoskills(userId: string): string[] {
    const list = this.settings[userId]?.autoskills;
    return Array.isArray(list) ? [...list] : [];
  }

  /**
   * Replace the user's auto-injected skill list wholesale. Order-preserving
   * de-duplication; capped at {@link MAX_AUTOSKILLS} (excess silently dropped
   * from the tail). Persisting fires the system-prompt invalidation hook via
   * `patchUserSettings`, so the next session build re-injects the new set.
   */
  setUserAutoskills(userId: string, skills: string[]): void {
    const deduped = this.dedupeAutoskills(skills);
    this.patchUserSettings(userId, { autoskills: deduped });
    logger.info('Set user autoskills', { userId, skills: deduped });
  }

  /**
   * Add one skill to the user's auto-injected list. No-op (returns false) when
   * already present or the cap is reached. Returns true when the list changed.
   */
  addUserAutoskill(userId: string, skill: string): boolean {
    const current = this.getUserAutoskills(userId);
    if (current.includes(skill)) return false;
    if (current.length >= MAX_AUTOSKILLS) return false;
    this.setUserAutoskills(userId, [...current, skill]);
    return true;
  }

  /**
   * Remove one skill from the user's auto-injected list. Returns true when the
   * list changed (the skill was present), false otherwise.
   */
  removeUserAutoskill(userId: string, skill: string): boolean {
    const current = this.getUserAutoskills(userId);
    if (!current.includes(skill)) return false;
    this.setUserAutoskills(
      userId,
      current.filter((s) => s !== skill),
    );
    return true;
  }

  /** Order-preserving de-dup + cap helper for autoskill writes. */
  private dedupeAutoskills(skills: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of skills) {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= MAX_AUTOSKILLS) break;
    }
    return out;
  }

  /**
   * Get user's thinking enabled setting (adaptive reasoning)
   */
  getUserThinkingEnabled(userId: string): boolean {
    return this.settings[userId]?.thinkingEnabled ?? DEFAULT_THINKING_ENABLED;
  }

  /**
   * Set user's thinking enabled setting
   */
  setUserThinkingEnabled(userId: string, enabled: boolean): void {
    this.patchUserSettings(userId, { thinkingEnabled: enabled });
    logger.info('Set user thinking enabled', { userId, enabled });
  }

  /**
   * Get user's show thinking setting (display thinking in Slack)
   */
  getUserShowThinking(userId: string): boolean {
    return this.settings[userId]?.showThinking ?? DEFAULT_SHOW_THINKING;
  }

  /**
   * Set user's show thinking setting
   */
  setUserShowThinking(userId: string, show: boolean): void {
    this.patchUserSettings(userId, { showThinking: show });
    logger.info('Set user show thinking', { userId, show });
  }

  /**
   * Get user's UI theme. Returns stored theme or DEFAULT_THEME.
   * Automatically migrates legacy A-L themes to 3-tier system.
   */
  getUserSessionTheme(userId: string): SessionTheme {
    const stored = this.settings[userId]?.sessionTheme;
    if (!stored) return DEFAULT_THEME;
    return migrateLegacyTheme(stored);
  }

  /**
   * Get user's raw theme setting. undefined means "use default".
   */
  getUserRawSessionTheme(userId: string): SessionTheme | undefined {
    return this.settings[userId]?.sessionTheme;
  }

  /**
   * Set user's UI theme. Pass undefined to reset to default.
   */
  setUserSessionTheme(userId: string, theme: SessionTheme | undefined): void {
    this.patchUserSettings(userId, { sessionTheme: theme } as Partial<UserSettings>);
    logger.info('Set user session theme', { userId, theme: theme ?? 'default' });
  }

  /**
   * Resolve theme input string to SessionTheme or 'reset' (to clear override).
   * Accepts: 'default', 'compact', 'minimal', legacy letters A-L, full names.
   */
  resolveThemeInput(input: string): SessionTheme | 'reset' | null {
    const trimmed = input.trim().toLowerCase();
    // Reset keywords
    if (trimmed === 'reset' || trimmed === 'auto') return 'reset';
    // Direct 3-tier name match
    if (SESSION_THEMES.includes(trimmed as SessionTheme)) return trimmed as SessionTheme;
    // Full display name match
    for (const [key, name] of Object.entries(THEME_NAMES)) {
      if (name.toLowerCase() === trimmed) return key as SessionTheme;
    }
    // Legacy letter migration
    const upper = input.toUpperCase().trim();
    if (upper.length === 1 && upper >= 'A' && upper <= 'L') {
      return migrateLegacyTheme(upper);
    }
    return null;
  }

  /**
   * Patch notification settings for a user.
   * Merges the patch into existing notification settings.
   */
  patchNotification(userId: string, patch: Partial<NotificationSettings>): void {
    const existing = this.settings[userId]?.notification ?? {};
    this.patchUserSettings(userId, {
      notification: { ...existing, ...patch },
    } as Partial<UserSettings>);
    // Mask sensitive fields in log output
    const safePatch = { ...patch };
    if (safePatch.webhookUrl) {
      safePatch.webhookUrl = maskUrl(safePatch.webhookUrl);
    }
    logger.info('Updated notification settings', { userId, patch: safePatch });
  }

  /**
   * Resolve verbosity input string to LogVerbosity
   */
  resolveVerbosityInput(input: string): LogVerbosity | null {
    const normalized = input.toLowerCase().trim();
    return VERBOSITY_NAMES.includes(normalized as LogVerbosity) ? (normalized as LogVerbosity) : null;
  }

  /**
   * Validate and normalize effort input. Returns null for unknown values.
   */
  resolveEffortInput(input: string): EffortLevel | null {
    const normalized = input.toLowerCase().trim();
    return EFFORT_LEVELS.includes(normalized as EffortLevel) ? (normalized as EffortLevel) : null;
  }

  /**
   * Parse and resolve model input (handle aliases)
   */
  resolveModelInput(input: string): ModelId | null {
    const normalized = input.toLowerCase().trim();

    // Check if it's already a valid model ID
    if (AVAILABLE_MODELS.includes(normalized as ModelId)) {
      return normalized as ModelId;
    }

    // Check aliases
    if (MODEL_ALIASES[normalized]) {
      return MODEL_ALIASES[normalized];
    }

    return null;
  }

  /**
   * Get display name for a model.
   *
   * Covers all 10 entries in AVAILABLE_MODELS. The `[1m]` variants append
   * `" (1M)"` so users can tell them apart in the Slack UI.
   */
  getModelDisplayName(model: ModelId): string {
    switch (model) {
      case 'claude-fable-5':
        // Native 1M context on the bare id — surface "(1M)" so users see the
        // window without a `[1m]` suffix existing.
        return 'Fable 5 (1M)';
      case 'claude-opus-4-8':
        return 'Opus 4.8';
      case 'claude-opus-4-8[1m]':
        return 'Opus 4.8 (1M)';
      case 'claude-opus-4-7':
        return 'Opus 4.7';
      case 'claude-opus-4-7[1m]':
        return 'Opus 4.7 (1M)';
      case 'claude-opus-4-6':
        return 'Opus 4.6';
      case 'claude-opus-4-6[1m]':
        return 'Opus 4.6 (1M)';
      case 'claude-sonnet-4-6':
        return 'Sonnet 4.6';
      case 'claude-sonnet-4-5-20250929':
        return 'Sonnet 4.5';
      case 'claude-opus-4-5-20251101':
        return 'Opus 4.5';
      case 'claude-haiku-4-5-20251001':
        return 'Haiku 4.5';
      default:
        return model;
    }
  }

  /**
   * Has the `/z` migration tombstone hint been shown to this user?
   * Phase 1 of /z refactor (#506).
   */
  hasMigrationHintShown(userId: string): boolean {
    return this.settings[userId]?.migrationHintShown === true;
  }

  /**
   * Atomically set the `migrationHintShown` flag (compare-and-set).
   *
   * Returns `true` if the flag was freshly set (caller should show the
   * tombstone), or `false` if another call already set it for this user
   * (caller must suppress duplicate hints).
   *
   * Concurrency: Node.js is single-threaded, so "compare-and-set" here
   * is an atomic check-then-write on the in-memory record plus an async
   * `writeFileSync`. For safety against the (rare) interleaving where
   * two async tombstone paths race, the first caller to observe
   * `migrationHintShown !== true` wins and writes the flag + persists to
   * disk before yielding to the event loop.
   */
  async markMigrationHintShown(userId: string): Promise<boolean> {
    // Synchronous CAS — no awaits between read and write.
    const existing = this.settings[userId];
    if (existing?.migrationHintShown === true) {
      return false;
    }
    if (existing) {
      existing.migrationHintShown = true;
      existing.lastUpdated = new Date().toISOString();
    } else {
      this.settings[userId] = {
        userId,
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: DEFAULT_MODEL,
        accepted: true,
        migrationHintShown: true,
        lastUpdated: new Date().toISOString(),
      };
    }
    // Persist asynchronously — the in-memory CAS is already committed.
    this.saveSettings();
    logger.info('Marked /z migrationHintShown for user', { userId });
    return true;
  }

  /**
   * Test-only: reset the `migrationHintShown` flag for a user.
   * Used by the tombstone table-driven test.
   */
  resetMigrationHintShown(userId: string): void {
    const existing = this.settings[userId];
    if (existing) {
      existing.migrationHintShown = false;
      existing.lastUpdated = new Date().toISOString();
      this.saveSettings();
    }
  }

  /**
   * Get all settings for a user
   */
  getUserSettings(userId: string): UserSettings | undefined {
    return this.settings[userId];
  }

  /**
   * Ensure a user settings record exists.
   * Creates default settings if the user doesn't have any.
   * Used during onboarding completion/skip to mark 'already onboarded' state.
   * @param userId - Slack user ID
   * @param slackName - Optional Slack display name to store
   * @returns The user settings (created or existing)
   */
  ensureUserExists(userId: string, slackName?: string): UserSettings {
    const existing = this.settings[userId];
    if (existing) {
      // Update slackName if provided and different
      if (slackName && existing.slackName !== slackName) {
        existing.slackName = slackName;
        existing.lastUpdated = new Date().toISOString();
        this.saveSettings();
        logger.debug('Updated slackName for existing user', { userId, slackName });
      }
      return existing;
    }

    // Create new settings with defaults (accepted=true for ensureUserExists — called after onboarding)
    const newSettings: UserSettings = {
      userId,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: DEFAULT_MODEL,
      lastUpdated: new Date().toISOString(),
      slackName,
      accepted: true,
    };

    this.settings[userId] = newSettings;
    this.saveSettings();
    logger.info('Created user settings via ensureUserExists', { userId, slackName });

    return newSettings;
  }

  /**
   * Create a pending user record (accepted=false).
   * Used when a new user messages the bot before admin approval.
   */
  createPendingUser(userId: string, slackName?: string): UserSettings {
    const existing = this.settings[userId];
    if (existing) return existing;

    const newSettings: UserSettings = {
      userId,
      defaultDirectory: '',
      bypassPermission: false,
      persona: 'default',
      defaultModel: DEFAULT_MODEL,
      lastUpdated: new Date().toISOString(),
      slackName,
      accepted: false,
    };

    this.settings[userId] = newSettings;
    this.saveSettings();
    logger.info('Created pending user', { userId, slackName });
    return newSettings;
  }

  /**
   * Accept a user (set accepted=true with admin info).
   * Creates the user record if it doesn't exist.
   */
  acceptUser(userId: string, adminUserId: string): void {
    this.patchUserSettings(userId, {
      accepted: true,
      acceptedBy: adminUserId,
      acceptedAt: new Date().toISOString(),
    });
    logger.info('User accepted', { userId, acceptedBy: adminUserId });
  }

  /**
   * Check if a user is accepted.
   */
  isUserAccepted(userId: string): boolean {
    return this.settings[userId]?.accepted === true;
  }

  /**
   * Get all user settings as an array.
   */
  getAllUsers(): UserSettings[] {
    return Object.values(this.settings);
  }

  /**
   * Remove user's settings
   */
  removeUserSettings(userId: string): boolean {
    if (this.settings[userId]) {
      delete this.settings[userId];
      this.saveSettings();
      logger.info('Removed user settings', { userId });
      return true;
    }
    return false;
  }

  /**
   * List all users with settings
   */
  listUsers(): string[] {
    return Object.keys(this.settings);
  }

  /**
   * Get statistics
   */
  getStats(): { userCount: number; directories: string[] } {
    const directories = [...new Set(Object.values(this.settings).map((s) => s.defaultDirectory))];
    return {
      userCount: Object.keys(this.settings).length,
      directories,
    };
  }
}

// Singleton instance
export const userSettingsStore = new UserSettingsStore();
