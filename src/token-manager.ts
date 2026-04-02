/**
 * TokenManager — Manages a pool of Claude Code OAuth tokens with
 * automatic rotation on rate limits and manual switching.
 *
 * Singleton: use the exported `tokenManager` instance.
 */

import { Logger } from './logger';

const logger = new Logger('TokenManager');

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
 * Parse "resets Xpm" or "resets X:XXam/pm" from rate limit error messages.
 * Returns a Date for today at the parsed time, or null if no match.
 */
export function parseCooldownTime(message: string): Date | null {
  const match = message.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3].toLowerCase();

  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;

  const now = new Date();
  const cooldown = new Date(now);
  cooldown.setHours(hours, minutes, 0, 0);

  // If the parsed time is in the past, assume it's tomorrow
  if (cooldown <= now) {
    cooldown.setDate(cooldown.getDate() + 1);
  }

  return cooldown;
}

export class TokenManager {
  private tokens: TokenEntry[] = [];
  private activeIndex: number = 0;

  /**
   * Load tokens from environment variables.
   * Priority: CLAUDE_CODE_OAUTH_TOKEN_LIST > CLAUDE_CODE_OAUTH_TOKEN
   */
  initialize(): void {
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
          return {
            name: entry.slice(0, eqIndex),
            value: entry.slice(eqIndex + 1),
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
    this.applyToken();

    logger.info(`TokenManager initialized: ${this.tokens.length} token(s) loaded, active=${this.tokens[0]?.name}`, {
      count: this.tokens.length,
      names: this.tokens.map((t) => t.name),
    });
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

  /** Mask a token value for safe display: first 20 + last 10 chars */
  static maskToken(value: string): string {
    if (value.length <= 33) return value;
    return `${value.slice(0, 20)}...${value.slice(-10)}`;
  }
}

/** Singleton instance */
export const tokenManager = new TokenManager();
