import fs from 'fs';
import { isAdminUser, resetAdminUsersCache } from '../../admin-utils';
import { ENV_FILE } from '../../env-paths';
import { redactAnthropicSecrets } from '../../logger';
import { getTokenManager } from '../../token-manager';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

const SENSITIVE_PATTERNS = /TOKEN|SECRET|KEY|PASSWORD|PRIVATE/i;

const CACHE_RESET_MAP: Partial<Record<string, () => void>> = {
  ADMIN_USERS: () => resetAdminUsersCache(),
};

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4);
}

/** Redact potential Anthropic secrets in a string before echoing to Slack. */
function redactForReply(value: string): string {
  const out = redactAnthropicSecrets(value);
  return typeof out === 'string' ? out : value;
}

/**
 * Parse `CLAUDE_CODE_OAUTH_TOKEN_LIST`-style payloads: `name:value,name2:value2`.
 * Accepts both `name:value` (preferred) and `name=value` (legacy).
 */
interface ParsedSlotEntry {
  readonly name: string;
  readonly value: string;
}
function parseTokenListEntries(raw: string): ParsedSlotEntry[] {
  const entries = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const out: ParsedSlotEntry[] = [];
  entries.forEach((entry, i) => {
    const ci = entry.indexOf(':');
    const ei = entry.indexOf('=');
    let sep: number;
    if (ci === -1) sep = ei;
    else if (ei === -1) sep = ci;
    else sep = Math.min(ci, ei);
    if (sep > 0) {
      out.push({ name: entry.slice(0, sep), value: entry.slice(sep + 1) });
    } else {
      out.push({ name: `cct${i + 1}`, value: entry });
    }
  });
  return out;
}

/**
 * Handles admin commands: accept/deny/users/config (admin only)
 */
export class AdminHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isAdminCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;

    if (!isAdminUser(user)) {
      await say({ text: '⛔ Admin only command', thread_ts: threadTs });
      return { handled: true };
    }

    const action = CommandParser.parseAdminCommand(text);
    if (!action) {
      await say({
        text: 'Usage: `accept @user` | `deny @user` | `users` | `config show` | `config KEY=VALUE`',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    switch (action.action) {
      case 'accept':
        return this.handleAccept(ctx, action.targetUser);
      case 'deny':
        return this.handleDeny(ctx, action.targetUser);
      case 'users':
        return this.handleUsers(ctx);
      case 'config':
        if (action.sub === 'show') return this.handleConfigShow(ctx);
        return this.handleConfigSet(ctx, action.key, action.value);
    }
  }

  private async handleAccept(ctx: CommandContext, targetUser: string): Promise<CommandResult> {
    userSettingsStore.acceptUser(targetUser, ctx.user);
    await ctx.say({
      text: `✅ <@${targetUser}> 승인 완료`,
      thread_ts: ctx.threadTs,
    });
    return { handled: true };
  }

  private async handleDeny(ctx: CommandContext, targetUser: string): Promise<CommandResult> {
    userSettingsStore.removeUserSettings(targetUser);
    await ctx.say({
      text: `❌ <@${targetUser}> 거부됨`,
      thread_ts: ctx.threadTs,
    });
    return { handled: true };
  }

  private async handleUsers(ctx: CommandContext): Promise<CommandResult> {
    const allUsers = userSettingsStore.getAllUsers();

    if (allUsers.length === 0) {
      await ctx.say({ text: '👥 *Users* (0 total)\n\nNo users registered.', thread_ts: ctx.threadTs });
      return { handled: true };
    }

    const accepted = allUsers.filter((u) => u.accepted);
    const pending = allUsers.filter((u) => !u.accepted);

    const lines: string[] = [`👥 *Users* (${allUsers.length} total)\n`];

    if (pending.length > 0) {
      lines.push(`*Pending (${pending.length}):*`);
      for (const u of pending) {
        lines.push(`• <@${u.userId}> — since ${u.lastUpdated}`);
      }
      lines.push('');
    }

    if (accepted.length > 0) {
      lines.push(`*Accepted (${accepted.length}):*`);
      for (const u of accepted) {
        const by = u.acceptedBy ? ` by <@${u.acceptedBy}>` : '';
        const at = u.acceptedAt ? ` on ${u.acceptedAt}` : '';
        lines.push(`• <@${u.userId}> — accepted${by}${at}`);
      }
    }

    await ctx.say({ text: lines.join('\n'), thread_ts: ctx.threadTs });
    return { handled: true };
  }

  private async handleConfigShow(ctx: CommandContext): Promise<CommandResult> {
    let content: string;
    try {
      content = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
      await ctx.say({ text: `❌ .env file not found: \`${ENV_FILE}\``, thread_ts: ctx.threadTs });
      return { handled: true };
    }

    const entries = content
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) return line;
        const key = line.slice(0, eqIdx);
        const value = line.slice(eqIdx + 1);
        if (SENSITIVE_PATTERNS.test(key)) {
          return `${key}=${maskSecret(value)}`;
        }
        return line;
      });

    if (entries.length === 0) {
      await ctx.say({ text: `⚙️ *Config* (\`${ENV_FILE}\`)\n\nConfig is empty.`, thread_ts: ctx.threadTs });
      return { handled: true };
    }

    await ctx.say({
      text: `⚙️ *Config* (\`${ENV_FILE}\`)\n\n\`\`\`\n${entries.join('\n')}\n\`\`\``,
      thread_ts: ctx.threadTs,
    });
    return { handled: true };
  }

  private async handleConfigSet(ctx: CommandContext, key: string, value: string): Promise<CommandResult> {
    if (!key) {
      await ctx.say({ text: 'Usage: `config KEY=VALUE`', thread_ts: ctx.threadTs });
      return { handled: true };
    }

    // CLAUDE_CODE_OAUTH_TOKEN_LIST is no longer stored in .env. The CctStore
    // is the SSOT for CCT slots, so we rewire the admin `config` setter to
    // route through TokenManager.addSlot() for each parsed entry, skipping
    // names already present in the registry.
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN_LIST') {
      return this.handleTokenListConfig(ctx, value);
    }

    // Step 3: Update process.env
    process.env[key] = value;

    // Step 4: Update .env file
    let envWriteOk = true;
    try {
      let content = fs.readFileSync(ENV_FILE, 'utf8');
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content = content.trimEnd() + `\n${key}=${value}\n`;
      }
      fs.writeFileSync(ENV_FILE, content, 'utf8');
    } catch {
      envWriteOk = false;
    }

    // Step 5: Reset special caches
    const resetFn = CACHE_RESET_MAP[key];
    if (resetFn) resetFn();

    // Step 6: Confirm (redact any anthropic secrets that might have been echoed)
    if (envWriteOk) {
      const cacheNote = resetFn ? '\n🔄 Cache refreshed' : '';
      await ctx.say({
        text: redactForReply(`✅ \`${key}\` updated to \`${value}\`${cacheNote}`),
        thread_ts: ctx.threadTs,
      });
    } else {
      await ctx.say({
        text: redactForReply(
          `⚠️ process.env updated but .env write failed. \`${key}=\`\`${value}\`\` active until restart.`,
        ),
        thread_ts: ctx.threadTs,
      });
    }

    return { handled: true };
  }

  private async handleTokenListConfig(ctx: CommandContext, value: string): Promise<CommandResult> {
    const parsed = parseTokenListEntries(value);
    if (parsed.length === 0) {
      await ctx.say({
        text: '⚠️ No token entries parsed. Expected: `name1:value1,name2:value2`',
        thread_ts: ctx.threadTs,
      });
      return { handled: true };
    }

    const tm = getTokenManager();
    const existingNames = new Set(tm.listTokens().map((s) => s.name));
    const added: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    for (const entry of parsed) {
      if (existingNames.has(entry.name)) {
        skipped.push(entry.name);
        continue;
      }
      try {
        await tm.addSlot({ name: entry.name, kind: 'setup_token', value: entry.value });
        added.push(entry.name);
        existingNames.add(entry.name);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ name: entry.name, reason });
      }
    }

    const lines: string[] = [];
    if (added.length > 0) lines.push(`✅ Added ${added.length} slot(s): ${added.join(', ')}`);
    if (skipped.length > 0) lines.push(`↩️ Skipped existing: ${skipped.join(', ')}`);
    if (failed.length > 0) {
      const rendered = failed.map((f) => `${f.name} (${f.reason})`).join(', ');
      lines.push(`❌ Failed: ${rendered}`);
    }
    if (lines.length === 0) lines.push('No changes.');

    await ctx.say({ text: redactForReply(lines.join('\n')), thread_ts: ctx.threadTs });
    return { handled: true };
  }
}
