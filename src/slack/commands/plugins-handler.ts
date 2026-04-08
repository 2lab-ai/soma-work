import { isAdminUser } from '../../admin-utils';
import { isDefaultPlugin } from '../../plugin/defaults';
import type { BackupEntry, FetchFailureCode, PluginUpdateDetail } from '../../plugin/types';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

// ---------------------------------------------------------------------------
// Slack Block Kit limits — keep payloads under these or Slack returns
// `invalid_blocks` and the entire message is dropped.
//   - section text mrkdwn:  3000 chars
//   - confirm dialog text:   300 chars
//   - message blocks:         50 total
//   - confirm dialog name budget = 300 - template overhead (~50 chars)
// ---------------------------------------------------------------------------
const SECTION_TEXT_MAX = 3000;
const CONFIRM_TEXT_MAX = 300;
const MESSAGE_BLOCKS_MAX = 50;
const CONFIRM_NAME_MAX = 200;

function truncateMrkdwn(text: string, max = SECTION_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function truncateConfirmText(text: string, max = CONFIRM_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Cap a blocks array at MESSAGE_BLOCKS_MAX, preserving the leading
 * header/summary/divider blocks and replacing trailing overflow with a
 * single "+N more" notice so users still know content was elided.
 */
function capBlocks(blocks: any[]): any[] {
  if (blocks.length <= MESSAGE_BLOCKS_MAX) return blocks;

  // Reserve the last slot for an overflow notice block
  const kept = blocks.slice(0, MESSAGE_BLOCKS_MAX - 1);
  const dropped = blocks.length - kept.length;
  kept.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `… *${dropped}개 블록이 생략되었습니다* (Slack 메시지당 최대 ${MESSAGE_BLOCKS_MAX} blocks)`,
    },
  });
  return kept;
}

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
      case 'rollback':
        return this.handleRollback(parsed.pluginRef, ctx.user, threadTs, say);
      case 'backups':
        return this.handleBackups(parsed.pluginRef, ctx.user, threadTs, say);
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
      const failedDetails = result.details.filter((d) => d.status === 'error' && d.failureCode);

      // If there are failures with structured error codes, use Block Kit UI
      if (failedDetails.length > 0) {
        const blocks = this.buildUpdateResultBlocks(result, failedDetails);
        const fallbackText = this.buildUpdateResultText(result);
        await say({ text: fallbackText, thread_ts: threadTs, blocks });
      } else {
        // No structured failures — use simple text
        const lines = this.buildUpdateResultLines(result);
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

  private async handleRollback(
    pluginRef: string,
    user: string,
    threadTs: string,
    say: CommandContext['say'],
  ): Promise<CommandResult> {
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
      text: `🔄 *${pluginRef}* 를 이전 버전으로 롤백 중...`,
      thread_ts: threadTs,
    });

    try {
      const result = await pluginManager.rollback(pluginRef);
      if (result.success) {
        await say({
          text: [
            `✅ *${pluginRef}* 롤백 완료`,
            `• 이전: \`${result.previousSha ?? '-'}\``,
            `• 복원: \`${result.restoredSha ?? '-'}\` (${result.restoredDate ?? '-'})`,
          ].join('\n'),
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `❌ 롤백 실패: ${result.error}`,
          thread_ts: threadTs,
        });
      }
    } catch (error) {
      await say({
        text: `❌ 롤백 실패: ${(error as Error).message}`,
        thread_ts: threadTs,
      });
    }
    return { handled: true };
  }

  private async handleBackups(
    pluginRef: string,
    user: string,
    threadTs: string,
    say: CommandContext['say'],
  ): Promise<CommandResult> {
    if (!isAdminUser(user)) {
      await say({ text: '⛔ Admin only command.', thread_ts: threadTs });
      return { handled: true };
    }

    const pluginManager = this.deps.mcpManager.getPluginManager();
    if (!pluginManager) {
      await say({ text: 'Plugin system is not available.', thread_ts: threadTs });
      return { handled: true };
    }

    // Extract bare plugin name from ref (name@marketplace → name)
    const pluginName = pluginRef.includes('@') ? pluginRef.split('@')[0] : pluginRef;
    const backups: BackupEntry[] = pluginManager.getBackups(pluginName);

    if (backups.length === 0) {
      await say({
        text: `📦 *${pluginRef}* — 사용 가능한 백업이 없습니다.`,
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const lines = [`📦 *${pluginRef}* 백업 목록 (${backups.length}개)`, ''];

    for (const b of backups) {
      const sha = b.sha ? b.sha.slice(0, 8) : '-';
      lines.push(`• \`${sha}\` — ${b.timestamp} (${b.marketplace})`);
    }

    lines.push('');
    lines.push(`_\`plugins rollback ${pluginRef}\` 로 최신 백업으로 롤백 가능_`);

    await say({ text: lines.join('\n'), thread_ts: threadTs });
    return { handled: true };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Returns true when pluginRef refers to the hardcoded built-in local plugin. */
  private isBuiltInLocal(pluginRef: string): boolean {
    return pluginRef === 'local' || pluginRef.startsWith('local@');
  }

  /** Build simple text lines for update result (no failures). */
  private buildUpdateResultLines(result: {
    total: number;
    updated: number;
    unchanged: number;
    errors: string[];
    details: PluginUpdateDetail[];
  }): string[] {
    const lines: string[] = [
      '✅ *플러그인 업데이트 완료*',
      '',
      `• 총 플러그인: ${result.total}개`,
      `• 업데이트: ${result.updated}개`,
      `• 변경없음: ${result.unchanged}개`,
    ];

    if (result.details.length > 0) {
      lines.push('');
      lines.push('*플러그인 상세:*');
      for (const d of result.details) {
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

    return lines;
  }

  /** Build fallback text for Block Kit message. */
  private buildUpdateResultText(result: {
    total: number;
    updated: number;
    unchanged: number;
    errors: string[];
  }): string {
    return `플러그인 업데이트 완료 — 총: ${result.total}, 업데이트: ${result.updated}, 에러: ${result.errors.length}`;
  }

  /** Build Block Kit blocks for update result with failure details and action buttons. */
  private buildUpdateResultBlocks(
    result: { total: number; updated: number; unchanged: number; errors: string[]; details: PluginUpdateDetail[] },
    failedDetails: PluginUpdateDetail[],
  ): any[] {
    const blocks: any[] = [];

    // Header
    const hasOnlyErrors = result.updated === 0 && result.unchanged === 0;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: hasOnlyErrors ? '❌ *플러그인 업데이트 실패*' : '⚠️ *플러그인 업데이트 완료 (일부 실패)*',
      },
    });

    // Summary
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `• 총 플러그인: ${result.total}개  •  업데이트: ${result.updated}개  •  변경없음: ${result.unchanged}개  •  실패: ${failedDetails.length}개`,
      },
    });

    blocks.push({ type: 'divider' });

    // Successful plugins (brief)
    const successDetails = result.details.filter((d) => d.status !== 'error');
    if (successDetails.length > 0) {
      for (const d of successDetails) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: truncateMrkdwn(this.formatPluginDetail(d)) },
        });
      }
      blocks.push({ type: 'divider' });
    }

    // Failed plugins with detailed error + action buttons
    for (const d of failedDetails) {
      const errorDesc = this.formatFailureDescription(d);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: truncateMrkdwn(`❌ *${d.name}*\n${errorDesc}`),
        },
      });

      // Action buttons: Ignore always, Force Update only for SECURITY_BLOCKED
      // Slack action_id max is 255 chars — truncate plugin name to stay within limit
      const actionSuffix = d.name.length > 200 ? d.name.slice(0, 200) : d.name;
      const pluginValue = JSON.stringify({ pluginName: d.name, failureCode: d.failureCode });
      const elements: any[] = [
        {
          type: 'button',
          action_id: `plugin_update_ignore_${actionSuffix}`,
          text: { type: 'plain_text', text: '무시 (Ignore)', emoji: true },
          value: pluginValue,
        },
      ];

      if (d.failureCode === 'SECURITY_BLOCKED') {
        // Confirm dialog mrkdwn `text` is capped at 300 chars by Slack — keep
        // the plugin name short enough that the surrounding template fits.
        const displayName = d.name.length > CONFIRM_NAME_MAX ? d.name.slice(0, CONFIRM_NAME_MAX) + '…' : d.name;
        elements.push({
          type: 'button',
          action_id: `plugin_update_force_${actionSuffix}`,
          text: { type: 'plain_text', text: '⚠️ 보안 우회 설치 (Force Update)', emoji: true },
          style: 'danger',
          value: pluginValue,
          confirm: {
            title: { type: 'plain_text', text: '보안 우회 확인' },
            text: {
              type: 'mrkdwn',
              text: truncateConfirmText(
                `*${displayName}* 플러그인의 보안 검사를 우회하고 설치합니다.\n이 작업은 위험할 수 있습니다.`,
              ),
            },
            confirm: { type: 'plain_text', text: '강제 설치' },
            deny: { type: 'plain_text', text: '취소' },
            style: 'danger',
          },
        });
      }

      blocks.push({ type: 'actions', elements });
    }

    return capBlocks(blocks);
  }

  /** Format a human-readable description from a failure code and details. */
  private formatFailureDescription(d: PluginUpdateDetail): string {
    const lines: string[] = [];

    const codeDescriptions: Record<FetchFailureCode, string> = {
      DOWNLOAD_FAILED: '마켓플레이스 다운로드 실패 (네트워크 오류 또는 인증 문제)',
      MANIFEST_NOT_FOUND: 'marketplace.json을 찾을 수 없음 (레포 구조 변경 가능)',
      PLUGIN_NOT_IN_MANIFEST: 'marketplace.json에 해당 플러그인이 없음',
      INSTALL_FAILED: '플러그인 파일 설치 실패',
      SECURITY_BLOCKED: '보안 검사에서 차단됨',
      EXTERNAL_FETCH_FAILED: '외부 플러그인 다운로드 실패',
      EXTERNAL_URL_INVALID: '외부 플러그인 URL 파싱 실패',
    };

    const desc = d.failureCode ? codeDescriptions[d.failureCode] : null;
    lines.push(`> *원인:* ${desc || d.error || 'Unknown error'}`);
    if (d.failureCode) {
      lines.push(`> *코드:* \`${d.failureCode}\``);
    }

    // Security findings
    if (d.securityFindings && d.securityFindings.length > 0) {
      lines.push(`> *위험 수준:* ${d.riskLevel || 'UNKNOWN'}`);
      lines.push('> *보안 스캔 결과:*');
      for (const f of d.securityFindings) {
        const fileInfo = f.file ? ` (\`${f.file}\`)` : '';
        lines.push(`>   • [${f.severity}] ${f.rule}: ${f.description}${fileInfo}`);
      }
    }

    return lines.join('\n');
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

      case 'error':
        return `❌ *${d.name}*  — 오류: ${d.error ?? 'Unknown error'}`;

      default:
        return `❓ *${d.name}*`;
    }
  }
}
