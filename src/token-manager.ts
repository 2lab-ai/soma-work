/**
 * TokenManager — Manages a pool of Claude Code OAuth tokens with
 * automatic rotation on rate limits and manual switching.
 *
 * Cooldown state is persisted to disk so it survives service restarts.
 * Singleton: use the exported `tokenManager` instance.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './logger';

const logger = new Logger('TokenManager');

/** Month abbreviation → 0-based month index */
const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Persisted cooldown state for a single token */
interface PersistedCooldown {
  until: string; // ISO 8601
}

/** On-disk JSON format */
interface CooldownFileData {
  cooldowns: Record<string, PersistedCooldown>;
  activeToken?: string;
}

export interface TokenEntry {
  readonly name: string; // e.g. "ai3", "ai2", or fallback "cct1"
  readonly value: string; // actual token value
  cooldownUntil: Date | null; // null = available
}

export interface RotationResult {
  readonly rotated: boolean;
  readonly reason?: 'already_rotated' | 'no_tokens';
  readonly newToken?: string;
  readonly allOnCooldown?: boolean;
  readonly earliestRecovery?: Date;
}

/**
 * Parse cooldown reset time from rate limit error messages.
 *
 * Supported formats:
 *   - 5-hour limit:  "resets 7pm",  "resets 7:30pm"
 *   - Weekly limit:  "resets Apr 7, 7pm (Asia/Seoul)"
 *
 * Returns a Date at the parsed time (and date, if present), or null on no match.
 */
export function parseCooldownTime(message: string): Date | null {
  // Groups: 1=month? 2=day? 3=hour 4=minutes? 5=am/pm
  const match = message.match(/resets?\s+(?:([A-Za-z]+)\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;

  const monthStr = match[1]; // e.g. "Apr" (optional)
  const dayStr = match[2]; // e.g. "7"   (optional)
  let hours = parseInt(match[3], 10);
  const minutes = match[4] ? parseInt(match[4], 10) : 0;
  const period = match[5].toLowerCase();

  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const cooldown = new Date(now);
  cooldown.setHours(hours, minutes, 0, 0);

  if (monthStr && dayStr) {
    // Weekly limit — explicit date provided
    const monthIndex = MONTH_MAP[monthStr.toLowerCase()];
    if (monthIndex !== undefined) {
      cooldown.setMonth(monthIndex, parseInt(dayStr, 10));
      // If the resulting date is in the past, it must be next year
      if (cooldown <= now) {
        cooldown.setFullYear(cooldown.getFullYear() + 1);
      }
    }
  } else {
    // 5-hour limit — time only, assume today (or tomorrow if past)
    if (cooldown <= now) {
      cooldown.setDate(cooldown.getDate() + 1);
    }
  }

  return cooldown;
}

export class TokenManager {
  private tokens: TokenEntry[] = [];
  private activeIndex: number = 0;
  private cooldownFilePath: string | null = null;

  /**
   * Load tokens from environment variables.
   * Priority: CLAUDE_CODE_OAUTH_TOKEN_LIST > CLAUDE_CODE_OAUTH_TOKEN
   *
   * If dataDir is provided, cooldown state is persisted to
   * `${dataDir}/token-cooldowns.json` and restored on init.
   */
  initialize(dataDir?: string): void {
    // Set up persistence path (lazy — only if dataDir known)
    if (dataDir) {
      this.cooldownFilePath = path.join(dataDir, 'token-cooldowns.json');
    }

    const tokenList = process.env.CLAUDE_CODE_OAUTH_TOKEN_LIST;
    const singleToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

    if (tokenList) {
      const entries = tokenList
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      this.tokens = entries.map((entry, i) => {
        const eqIndex = entry.indexOf('=');
        if (eqIndex > 0) {
          const name = entry.slice(0, eqIndex);
          const rawValue = entry.slice(eqIndex + 1);
          return {
            name,
            value: TokenManager.resolveEnvRef(rawValue),
            cooldownUntil: null,
          };
        }
        return { name: `cct${i + 1}`, value: entry, cooldownUntil: null };
      });
    } else if (singleToken) {
      this.tokens = [
        {
          name: 'cct1',
          value: singleToken,
          cooldownUntil: null,
        },
      ];
    } else {
      this.tokens = [];
      logger.warn('No OAuth tokens configured (CLAUDE_CODE_OAUTH_TOKEN_LIST / CLAUDE_CODE_OAUTH_TOKEN)');
      return;
    }

    this.activeIndex = 0;

    // Restore persisted cooldown state (before choosing active token)
    this.restoreCooldowns();

    this.applyToken();

    logger.info(
      `TokenManager initialized: ${this.tokens.length} token(s) loaded, active=${this.tokens[this.activeIndex]?.name}`,
      {
        count: this.tokens.length,
        names: this.tokens.map((t) => t.name),
        restoredCooldowns: this.tokens.filter((t) => t.cooldownUntil !== null).map((t) => t.name),
      },
    );
  }

  getActiveToken(): TokenEntry {
    return this.tokens[this.activeIndex];
  }

  getAllTokens(): readonly TokenEntry[] {
    return this.tokens;
  }

  /**
   * Manually switch active token by name (e.g. "cct2").
   * Clears cooldown on the target token.
   */
  setActiveToken(name: string): boolean {
    const index = this.tokens.findIndex((t) => t.name === name);
    if (index === -1) return false;

    this.activeIndex = index;
    this.tokens[index] = { ...this.tokens[index], cooldownUntil: null };
    this.applyToken();

    logger.info(`Manual token switch: active=${name} (${TokenManager.maskToken(this.tokens[index].value)})`);
    return true;
  }

  /**
   * Switch to the next token in round-robin order (manual nextcct).
   * Skips tokens on cooldown if possible.
   */
  rotateToNext(): { name: string } | null {
    if (this.tokens.length <= 1) return null;

    const now = new Date();
    for (let i = 1; i < this.tokens.length; i++) {
      const nextIndex = (this.activeIndex + i) % this.tokens.length;
      const next = this.tokens[nextIndex];
      if (next.cooldownUntil === null || next.cooldownUntil <= now) {
        const previousName = this.tokens[this.activeIndex].name;
        this.activeIndex = nextIndex;
        this.applyToken();
        logger.info(`Manual next rotation: ${previousName} → ${next.name}`);
        return { name: next.name };
      }
    }

    // All others on cooldown — just move to next anyway
    const nextIndex = (this.activeIndex + 1) % this.tokens.length;
    const previousName = this.tokens[this.activeIndex].name;
    this.activeIndex = nextIndex;
    this.applyToken();
    logger.info(`Manual next rotation (all cooldown): ${previousName} → ${this.tokens[nextIndex].name}`);
    return { name: this.tokens[nextIndex].name };
  }

  /**
   * Idempotent token rotation on rate limit (CAS pattern).
   * Only rotates if the caller's failed token matches the current active token.
   */
  rotateOnRateLimit(failedTokenValue: string, cooldownUntil: Date | null): RotationResult {
    if (this.tokens.length === 0) {
      return { rotated: false, reason: 'no_tokens' };
    }

    // CAS check: only rotate if the failed token is still the active one
    if (this.tokens[this.activeIndex].value !== failedTokenValue) {
      return { rotated: false, reason: 'already_rotated' };
    }

    // Set cooldown on the failed token
    this.tokens[this.activeIndex] = {
      ...this.tokens[this.activeIndex],
      cooldownUntil,
    };

    const now = new Date();

    // Find next available token (not on cooldown)
    for (let i = 1; i <= this.tokens.length; i++) {
      const nextIndex = (this.activeIndex + i) % this.tokens.length;
      const next = this.tokens[nextIndex];
      if (next.cooldownUntil === null || next.cooldownUntil <= now) {
        const previousName = this.tokens[this.activeIndex].name;
        this.activeIndex = nextIndex;
        this.applyToken();
        this.saveCooldowns();
        logger.info(`Token auto-rotated: ${previousName} → ${next.name}`);
        return { rotated: true, newToken: next.name };
      }
    }

    // All tokens on cooldown — pick the one with earliest recovery
    let earliestIndex = 0;
    let earliestTime = this.tokens[0].cooldownUntil ?? new Date(8640000000000000);
    for (let i = 1; i < this.tokens.length; i++) {
      const cd = this.tokens[i].cooldownUntil;
      if (cd && cd < earliestTime) {
        earliestTime = cd;
        earliestIndex = i;
      }
    }

    const previousName = this.tokens[this.activeIndex].name;
    this.activeIndex = earliestIndex;
    this.applyToken();
    this.saveCooldowns();

    logger.warn(
      `All tokens on cooldown! Using ${this.tokens[earliestIndex].name} (earliest recovery: ${earliestTime.toLocaleTimeString()})`,
      {
        previous: previousName,
        active: this.tokens[earliestIndex].name,
        earliestRecovery: earliestTime.toISOString(),
      },
    );

    return {
      rotated: true,
      newToken: this.tokens[earliestIndex].name,
      allOnCooldown: true,
      earliestRecovery: earliestTime,
    };
  }

  /** Apply the active token to process.env so the SDK picks it up */
  private applyToken(): void {
    if (this.tokens.length > 0) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = this.tokens[this.activeIndex].value;
    }
  }

  // ── Persistence ──────────────────────────────────────────────

  /** Persist cooldown state + active token to disk. Atomic write (tmp + rename). */
  private saveCooldowns(): void {
    if (!this.cooldownFilePath) return;

    try {
      const data: CooldownFileData = { cooldowns: {}, activeToken: this.tokens[this.activeIndex]?.name };
      for (const t of this.tokens) {
        if (t.cooldownUntil) {
          data.cooldowns[t.name] = { until: t.cooldownUntil.toISOString() };
        }
      }

      const dir = path.dirname(this.cooldownFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmp = `${this.cooldownFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.cooldownFilePath);
    } catch (error) {
      logger.warn('Failed to save cooldown state', error);
    }
  }

  /**
   * Restore cooldown state from disk on initialize().
   * Expired cooldowns are silently discarded.
   * If persisted active token still has a valid (future) cooldown,
   * the active index moves to the best available token instead.
   */
  private restoreCooldowns(): void {
    if (!this.cooldownFilePath) return;

    try {
      if (!fs.existsSync(this.cooldownFilePath)) return;

      const raw = fs.readFileSync(this.cooldownFilePath, 'utf-8');
      const data = JSON.parse(raw) as CooldownFileData;
      const now = new Date();
      let restoredCount = 0;

      for (const t of this.tokens) {
        const persisted = data.cooldowns[t.name];
        if (persisted) {
          const until = new Date(persisted.until);
          if (until > now) {
            t.cooldownUntil = until;
            restoredCount++;
          }
        }
      }

      // Restore active token preference
      if (data.activeToken) {
        const preferredIndex = this.tokens.findIndex((t) => t.name === data.activeToken);
        if (preferredIndex !== -1) {
          this.activeIndex = preferredIndex;
        }
      }

      // If the active token is on cooldown, find the best available
      const active = this.tokens[this.activeIndex];
      if (active?.cooldownUntil && active.cooldownUntil > now) {
        for (let i = 0; i < this.tokens.length; i++) {
          const t = this.tokens[i];
          if (t.cooldownUntil === null || t.cooldownUntil <= now) {
            this.activeIndex = i;
            break;
          }
        }
        // If all on cooldown, pick earliest recovery
        const activeCd = this.tokens[this.activeIndex].cooldownUntil;
        if (activeCd && activeCd > now) {
          let earliestIndex = 0;
          let earliestTime = this.tokens[0].cooldownUntil ?? new Date(8640000000000000);
          for (let i = 1; i < this.tokens.length; i++) {
            const cd = this.tokens[i].cooldownUntil;
            if (cd && cd < earliestTime) {
              earliestTime = cd;
              earliestIndex = i;
            }
          }
          this.activeIndex = earliestIndex;
        }
      }

      if (restoredCount > 0) {
        logger.info(`Restored ${restoredCount} cooldown(s) from disk, active=${this.tokens[this.activeIndex]?.name}`);
      }
    } catch (error) {
      logger.warn('Failed to restore cooldown state', error);
    }
  }

  // ── Static helpers ───────────────────────────────────────────

  /** Resolve ${VAR_NAME} references from process.env */
  static resolveEnvRef(value: string): string {
    const match = value.match(/^\$\{(\w+)\}$/);
    if (match) {
      const resolved = process.env[match[1]];
      if (resolved) return resolved;
    }
    return value;
  }

  /** Mask a token value for safe display: first 20 + last 10 chars */
  static maskToken(value: string): string {
    if (value.length <= 33) return value;
    return `${value.slice(0, 20)}...${value.slice(-10)}`;
  }
}

/** Singleton instance */
export const tokenManager = new TokenManager();
