import fs from 'fs';
import path from 'path';
import { DATA_DIR as ENV_DATA_DIR } from './env-paths';
import { Logger } from './logger.js';
import { DEFAULT_LOG_VERBOSITY, getVerbosityFlags, type LogVerbosity, VERBOSITY_NAMES } from './slack/output-flags';
import { maskUrl } from './turn-notifier.js';

const logger = new Logger('UserSettingsStore');

// Available models (user-facing).
// Context window is determined by the `[1m]` suffix — see
// `src/metrics/model-registry.ts#resolveContextWindow`. Bare = 200k, `[1m]` = 1M.
// Claude Agent SDK strips the suffix and injects the beta header internally (#648).
export const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
] as const;

export type ModelId = (typeof AVAILABLE_MODELS)[number];

// Model aliases for user-friendly input. Keys are lowercased alias forms; the
// `resolveModelInput` function lowercases/trims before lookup (so `OPUS[1M]`
// resolves via the `opus[1m]` key).
export const MODEL_ALIASES: Record<string, ModelId> = {
  opus: 'claude-opus-4-7',
  'opus[1m]': 'claude-opus-4-7[1m]',
  'opus-4.7': 'claude-opus-4-7',
  'opus-4.7[1m]': 'claude-opus-4-7[1m]',
  'opus-4.6': 'claude-opus-4-6',
  'opus-4.6[1m]': 'claude-opus-4-6[1m]',
};

export const DEFAULT_MODEL: ModelId = 'claude-opus-4-7';

/** Set form of `AVAILABLE_MODELS` for O(1) membership checks. */
const AVAILABLE_MODEL_SET: ReadonlySet<string> = new Set(AVAILABLE_MODELS);

/**
 * Coerce an arbitrary persisted model string to the current allow-list.
 * Returns the input unchanged when it's a valid `ModelId`; otherwise returns
 * `DEFAULT_MODEL`. Comparison is case-insensitive on the `[1m]` suffix —
 * `claude-opus-4-7[1M]` is normalized to `claude-opus-4-7[1m]`.
 *
 * Used at every persistence boundary (settings load, session deserialize,
 * deploy bootstrap) so legacy or hand-edited values never reach the hot path.
 */
export function coerceToAvailableModel(raw: unknown): ModelId {
  if (typeof raw !== 'string') return DEFAULT_MODEL;
  if (AVAILABLE_MODEL_SET.has(raw)) return raw as ModelId;
  // Normalize `[1M]` → `[1m]` so case-only drift does not trigger a default.
  const lower = raw.toLowerCase();
  return AVAILABLE_MODEL_SET.has(lower) ? (lower as ModelId) : DEFAULT_MODEL;
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
export const SESSION_THEMES = ['default', 'compact', 'minimal'] as const;
export type SessionTheme = (typeof SESSION_THEMES)[number];
export const DEFAULT_THEME: SessionTheme = 'default';
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
  bypassPermission: boolean;
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
  slackName?: string;
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
   * Get display name for a model. Inputs are constrained to `ModelId` by the
   * type system; persistence boundaries normalize via `coerceToAvailableModel`
   * before any value reaches this method.
   */
  getModelDisplayName(model: ModelId): string {
    switch (model) {
      case 'claude-opus-4-7':
        return 'Opus 4.7';
      case 'claude-opus-4-7[1m]':
        return 'Opus 4.7 (1M)';
      case 'claude-opus-4-6':
        return 'Opus 4.6';
      case 'claude-opus-4-6[1m]':
        return 'Opus 4.6 (1M)';
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
