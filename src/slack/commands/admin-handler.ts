import fs from 'fs';
import { getAdminUsers, isAdminUser, resetAdminUsersCache } from '../../admin-utils';
import { invalidateChannelCache } from '../../channel-description-cache';
import { getAllChannels, scanChannels } from '../../channel-registry';
import { ENV_FILE } from '../../env-paths';
import { redactAnthropicSecrets } from '../../logger';
import { getTokenManager } from '../../token-manager';
import { userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Optional dependencies for `admin setup`. Each step degrades to an explicit
 * "not wired" report line when its dependency is missing — never silently.
 */
export interface AdminHandlerDeps {
  slackApi?: { getClient(): unknown };
  mcpManager?: { reloadConfiguration(): { mcpServers: Record<string, unknown> } | null };
}

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
 * Handles the `admin` command namespace (admin only):
 * - `admin` — menu of admin-only commands
 * - `admin setup` — idempotent re-run of startup setup
 * - `admin accept/deny/users/config` — namespaced user/config management
 *   (legacy bare `accept`/`deny`/`users`/`config` forms remain as aliases)
 * - `admin <delegated>` — admin-gated commands owned by other handlers
 *   (`admin show prompt`, `admin sandbox on`, `admin plugins update`, …)
 */
export class AdminHandler implements CommandHandler {
  constructor(
    private deps: AdminHandlerDeps = {},
    private delegates: CommandHandler[] = [],
  ) {}

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
        text: 'Usage: `admin` | `admin setup` | `admin accept @user` | `admin deny @user` | `admin users` | `admin config show` | `admin config KEY=VALUE`',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    switch (action.action) {
      case 'menu':
        return this.handleMenu(ctx);
      case 'setup':
        return this.handleSetup(ctx);
      case 'delegate':
        return this.handleDelegate(ctx, action.rest);
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

  private async handleMenu(ctx: CommandContext): Promise<CommandResult> {
    const lines = [
      '🛡️ *Admin Commands* (admin only)',
      '',
      '*Setup:*',
      '• `admin setup` — Idempotently re-run startup setup: channel-repo registry rescan, channel description cache invalidation, MCP config reload, admin user cache refresh',
      '',
      '*User management:*',
      '• `admin accept @user` — Approve a pending user',
      '• `admin deny @user` — Deny/remove a user',
      '• `admin users` — List pending/accepted users',
      '',
      '*Config:*',
      '• `admin config show` — Show .env config (secrets masked)',
      '• `admin config KEY=VALUE` — Update env config',
      '',
      '*Session inspection:*',
      '• `admin show prompt` — Show the system prompt of this session',
      '• `admin show instructions` — Show stored user instructions',
      '',
      '*Sandbox:*',
      '• `admin sandbox on|off` — Toggle process sandbox',
      '• `admin sandbox network on|off` — Toggle network allowlist',
      '',
      '*Plugins:*',
      '• `admin plugins update` — Force re-download all plugins',
      '• `admin plugins add|remove|rollback <ref>` — Manage plugins',
      '',
      '*Token pool:*',
      '• `admin cct` — OAuth token pool admin card',
      '• `admin cct set <name>` / `admin cct next` / `admin cct auto [dry]` — Rotate tokens',
      '',
      '*UI test:*',
      '• `admin ui-test <case>` — Internal Block Kit UI tests',
      '',
      '_Legacy bare forms (`accept`, `users`, `config`, `show prompt`, `sandbox`, `plugins`, `cct`, `ui-test`) still work as aliases._',
    ];
    await ctx.say({ text: lines.join('\n'), thread_ts: ctx.threadTs });
    return { handled: true };
  }

  /**
   * Idempotent re-run of startup-time setup. Every step reports success or
   * failure explicitly; a failed step never blocks the remaining steps.
   */
  private async handleSetup(ctx: CommandContext): Promise<CommandResult> {
    const lines: string[] = ['🔄 *Admin Setup* — idempotent re-initialization', ''];

    // Step 1: Channel-repo registry rescan (same scan as startup)
    if (this.deps.slackApi && typeof this.deps.slackApi.getClient === 'function') {
      try {
        const total = await scanChannels(this.deps.slackApi.getClient() as never);
        const channels = getAllChannels();
        for (const ch of channels) invalidateChannelCache(ch.id);
        const mapped = channels.filter((c) => c.repos.length > 0);
        lines.push(`✅ Channel scan: ${total} channel(s), ${mapped.length} with repo mappings`);
        for (const ch of mapped) {
          lines.push(`    • #${ch.name} → ${ch.repos.join(', ')}`);
        }
      } catch (err) {
        lines.push(`❌ Channel scan failed: ${(err as Error).message}`);
      }
    } else {
      lines.push('❌ Channel scan skipped: slackApi not wired');
    }

    // Step 2: MCP configuration reload
    if (this.deps.mcpManager && typeof this.deps.mcpManager.reloadConfiguration === 'function') {
      try {
        const config = this.deps.mcpManager.reloadConfiguration();
        const count = config?.mcpServers ? Object.keys(config.mcpServers).length : 0;
        lines.push(`✅ MCP config reloaded: ${count} server(s)`);
      } catch (err) {
        lines.push(`❌ MCP config reload failed: ${(err as Error).message}`);
      }
    } else {
      lines.push('❌ MCP config reload skipped: mcpManager not wired');
    }

    // Step 3: Admin user cache refresh (re-reads ADMIN_USERS env)
    try {
      resetAdminUsersCache();
      lines.push(`✅ Admin user cache refreshed: ${getAdminUsers().size} admin(s)`);
    } catch (err) {
      lines.push(`❌ Admin user cache refresh failed: ${(err as Error).message}`);
    }

    await ctx.say({ text: lines.join('\n'), thread_ts: ctx.threadTs });
    return { handled: true };
  }

  /**
   * Route `admin <delegated>` to the original owner handler with the `admin `
   * prefix stripped. The owner handlers keep their own admin gates, so this
   * adds no privilege — it only namespaces the commands.
   */
  private async handleDelegate(ctx: CommandContext, rest: string): Promise<CommandResult> {
    for (const delegate of this.delegates) {
      if (delegate.canHandle(rest, ctx.user)) {
        return delegate.execute({ ...ctx, text: rest });
      }
    }
    await ctx.say({
      text: `❓ Unknown admin command: \`${rest}\`\nType \`admin\` to see available admin commands.`,
      thread_ts: ctx.threadTs,
    });
    return { handled: true };
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
        // Treat the CAS name-uniqueness collision the same as a pre-check
        // skip — another caller landed the name between our `existingNames`
        // snapshot and our `addSlot` attempt.
        if (reason.startsWith('NAME_IN_USE:')) {
          skipped.push(entry.name);
          continue;
        }
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
