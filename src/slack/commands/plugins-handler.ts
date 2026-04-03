import { isAdminUser } from '../../admin-utils';
import { isDefaultPlugin } from '../../plugin/defaults';
import type { PluginUpdateDetail } from '../../plugin/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles `plugins` slash commands: list / add / remove.
 *
 * The built-in `local` plugin (src/local/) is always present via
 * LOCAL_PLUGINS_DIR fallback in claude-handler.ts and is NOT managed
 * through PluginManager.  It is shown as a locked entry in the list
 * and cannot be removed.
 */
export class PluginsHandler implements CommandHandler {
  constructor(private readonly deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isPluginsCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, threadTs, say } = ctx;
    const parsed = CommandParser.parsePluginsCommand(text);

    switch (parsed.action) {
      case 'list':
        return this.handleList(threadTs, say);
      case 'add':
        return this.handleAdd(parsed.pluginRef, threadTs, say);
      case 'remove':
        return this.handleRemove(parsed.pluginRef, threadTs, say);
      case 'update':
        return this.handleUpdate(ctx.user, threadTs, say);
      default:
        return { handled: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Subcommand handlers
  // ---------------------------------------------------------------------------

  private async handleList(threadTs: string, say: CommandContext['say']): Promise<CommandResult> {
    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({ text: 'Plugin system is not available.', thread_ts: threadTs });
      return { handled: true };
    }

    const installed = pluginManager.getInstalledPlugins();
    const resolved = pluginManager.getResolvedPlugins();

    const lines: string[] = [
      '\ud83d\udd0c *Installed Plugins*',
      '',
      '\ud83d\udd12 *local* (built-in) \u2014 Always loaded',
    ];

    // Show default plugins as locked
    for (const r of resolved) {
      if (r.source === 'default') {
        lines.push(`\ud83d\udd12 *${r.name}* (default) \u2014 Always loaded`);
      }
    }

    // Show user-installed marketplace plugins
    const userPlugins = installed.filter((ref) => !isDefaultPlugin(ref));
    if (userPlugins.length === 0) {
      lines.push('');
      lines.push('_No additional marketplace plugins installed. Use `plugins add name@marketplace` to install._');
    } else {
      for (const ref of userPlugins) {
        const detail = resolved.find((r) => r.name === ref);
        const pathInfo = detail ? ` (resolved: ${detail.localPath})` : '';
        lines.push(`\u2022 *${ref}* \u2014 Marketplace plugin${pathInfo}`);
      }
    }

    await say({ text: lines.join('\n'), thread_ts: threadTs });
    return { handled: true };
  }

  private async handleAdd(pluginRef: string, threadTs: string, say: CommandContext['say']): Promise<CommandResult> {
    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({ text: 'Plugin system is not available.', thread_ts: threadTs });
      return { handled: true };
    }

    const result = pluginManager.addPlugin(pluginRef);
    if (result.success) {
      await say({
        text: `\u2705 Plugin *${pluginRef}* added. Run \`mcp reload\` to activate.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `\u274c Failed to add plugin: ${result.error}`,
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }

  private async handleRemove(pluginRef: string, threadTs: string, say: CommandContext['say']): Promise<CommandResult> {
    // Protect the built-in local plugin and default plugins
    if (this.isBuiltInLocal(pluginRef) || isDefaultPlugin(pluginRef)) {
      const label = this.isBuiltInLocal(pluginRef) ? 'Built-in local' : 'Default';
      await say({
        text: `\u274c ${label} plugin cannot be removed.`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({ text: 'Plugin system is not available.', thread_ts: threadTs });
      return { handled: true };
    }

    const result = pluginManager.removePlugin(pluginRef);
    if (result.success) {
      await say({
        text: `\u2705 Plugin *${pluginRef}* removed.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `\u274c Failed to remove plugin: ${result.error}`,
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }

  private async handleUpdate(user: string, threadTs: string, say: CommandContext['say']): Promise<CommandResult> {
    // Admin-only gate
    if (!isAdminUser(user)) {
      await say({ text: '⛔ Admin only command.', thread_ts: threadTs });
      return { handled: true };
    }

    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({ text: 'Plugin system is not available.', thread_ts: threadTs });
      return { handled: true };
    }

    await say({
      text: '🔄 플러그인 전체 업데이트를 시작합니다. 캐시를 삭제하고 새로 다운로드합니다...',
      thread_ts: threadTs,
    });

    try {
      const result = await pluginManager.forceRefresh();

      // Check for security-blocked plugins
      const blockedDetails = result.details.filter((d) => d.status === 'security_blocked');
      const nonBlockedDetails = result.details.filter((d) => d.status !== 'security_blocked');

      const lines: string[] = [
        '✅ *플러그인 업데이트 완료*',
        '',
        `• 총 플러그인: ${result.total}개`,
        `• 업데이트: ${result.updated}개`,
        `• 변경없음: ${result.unchanged}개`,
      ];

      if (blockedDetails.length > 0) {
        lines.push(`• 보안 차단: ${blockedDetails.length}개`);
      }

      // Per-plugin version details (non-blocked)
      if (nonBlockedDetails.length > 0) {
        lines.push('');
        lines.push('*플러그인 상세:*');

        for (const d of nonBlockedDetails) {
          lines.push(this.formatPluginDetail(d));
        }
      }

      if (result.errors.length > 0) {
        lines.push('');
        lines.push('⚠️ *Errors:*');
        for (const err of result.errors) {
          lines.push(`  • ${err}`);
        }
      }

      // If there are security-blocked plugins, use Block Kit with buttons
      if (blockedDetails.length > 0) {
        const blocks: any[] = [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: lines.join('\n') },
          },
        ];

        for (const d of blockedDetails) {
          // Parse pluginName and marketplaceName from display name "pluginName@marketplaceName"
          const [pName, mName] = d.name.split('@');

          blocks.push({ type: 'divider' });
          blocks.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🛡️ *${d.name}*  — 보안 스캔 차단\n${d.securityReport ?? ''}`,
            },
          });
          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '🔓 Force Update' },
                style: 'danger',
                action_id: 'plugin_force_update',
                value: JSON.stringify({ pluginName: pName, marketplaceName: mName }),
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '❌ Cancel' },
                action_id: 'plugin_force_cancel',
                value: JSON.stringify({ pluginName: pName, marketplaceName: mName }),
              },
            ],
          });
        }

        await say({ text: lines.join('\n'), thread_ts: threadTs, blocks });
      } else {
        await say({ text: lines.join('\n'), thread_ts: threadTs });
      }
    } catch (error) {
      await say({
        text: `❌ 플러그인 업데이트 실패: ${(error as Error).message}`,
        thread_ts: threadTs,
      });
    }

    return { handled: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Returns true when pluginRef refers to the hardcoded built-in local plugin. */
  private isBuiltInLocal(pluginRef: string): boolean {
    return pluginRef === 'local' || pluginRef.startsWith('local@');
  }

  /** Format a single plugin update detail for Slack display. */
  private formatPluginDetail(d: PluginUpdateDetail): string {
    const formatDate = (iso: string | null): string => {
      if (!iso) return '-';
      try {
        const date = new Date(iso);
        // YYYY-MM-DD HH:mm (UTC)
        return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      } catch {
        return iso;
      }
    };

    switch (d.status) {
      case 'unchanged':
        return `⏸️ *${d.name}*  — 변경없음 \`${d.oldSha ?? '-'}\` (${formatDate(d.oldDate)})`;

      case 'updated':
        return [
          `🔄 *${d.name}*  — *업데이트됨*`,
          `    기존: \`${d.oldSha ?? '-'}\` (${formatDate(d.oldDate)})`,
          `    최신: \`${d.newSha ?? '-'}\` (${formatDate(d.newDate)})`,
        ].join('\n');

      case 'new':
        return `🆕 *${d.name}*  — 신규설치 \`${d.newSha ?? '-'}\` (${formatDate(d.newDate)})`;

      case 'security_blocked':
        return `🛡️ *${d.name}*  — 보안 스캔 차단\n${d.securityReport ?? ''}`;

      case 'error':
        return `❌ *${d.name}*  — 오류: ${d.error ?? 'Unknown error'}`;

      default:
        return `❓ *${d.name}*`;
    }
  }
}
