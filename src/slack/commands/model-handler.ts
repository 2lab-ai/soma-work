import { isAdminUser } from '../../admin-utils';
import { modelCatalog } from '../../model-catalog';
import { AVAILABLE_MODELS, MODEL_ALIASES, userSettingsStore } from '../../user-settings-store';
import { CommandParser } from '../command-parser';
import { applyModel, renderModelCard } from '../z/topics/model-topic';
import type { CommandContext, CommandDependencies, CommandHandler, CommandResult } from './types';

/**
 * Handles model commands (status/list/set) — persists to user default.
 *
 * Phase 2 (#507):
 *   - bare `model` → Block Kit setting card (via /z topic builder)
 *   - `model list` → text listing (back-compat)
 *   - `model set <n>` → apply + text ack (back-compat)
 */
export class ModelHandler implements CommandHandler {
  constructor(private deps: CommandDependencies) {}

  canHandle(text: string): boolean {
    return CommandParser.isModelCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, text, threadTs, say } = ctx;
    const modelAction = CommandParser.parseModelCommand(text);

    if (modelAction.action === 'status') {
      // Admin `model` → synchronous FORCED llmux catalog refresh (bypasses the
      // 60s cooldown + 10min TTL) so the card below renders the fresh catalog.
      // Non-admins keep the fire-and-forget TTL revalidation inside
      // renderModelCard — the card never blocks on llmux for them.
      let refreshNote: string | null = null;
      if (isAdminUser(user)) {
        const refresh = await modelCatalog.refresh(undefined, { force: true });
        const fetchedAt = modelCatalog.getFetchedAt();
        const at = fetchedAt
          ? `<!date^${Math.floor(fetchedAt / 1000)}^{time_secs}|${new Date(fetchedAt).toISOString()}>`
          : '-';
        refreshNote = refresh.ok
          ? `🔄 llmux 모델 카탈로그 갱신됨 — ${refresh.count} models (fetched ${at})`
          : refresh.skipped
            ? `🔄 llmux 모델 카탈로그 — ${refresh.count} models (방금 갱신되어 재조회 생략, fetched ${at})`
            : `⚠️ llmux 카탈로그 갱신 실패 (${refresh.error ?? 'unknown'}) — 캐시된 ${refresh.count} models 표시 중`;
      }
      const { text: fallback, blocks } = await renderModelCard({
        userId: user,
        issuedAt: Date.now(),
      });
      if (refreshNote) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: refreshNote }] });
      }
      await say({ text: fallback ?? '🤖 Model', blocks, thread_ts: threadTs });
    } else if (modelAction.action === 'list') {
      const currentModel = userSettingsStore.getUserDefaultModel(user);
      const modelList = AVAILABLE_MODELS.map((m) => {
        const displayName = userSettingsStore.getModelDisplayName(m);
        return m === currentModel ? `• *${displayName}* _(current)_\n  \`${m}\`` : `• ${displayName}\n  \`${m}\``;
      }).join('\n');

      await say({
        text: `🤖 *Available Models*\n\n${modelList}\n\n_Use \`model set <name>\` to change your default model._`,
        thread_ts: threadTs,
      });
    } else if (modelAction.action === 'set' && modelAction.model) {
      const result = await applyModel({ userId: user, value: modelAction.model });
      if (result.ok) {
        // Also apply to current session (mirrors legacy behaviour). applyModel
        // just persisted the resolved id as the user default — read it back
        // instead of re-resolving (the resolution may have required a fresh
        // llmux catalog fetch).
        const resolvedModel = userSettingsStore.getUserDefaultModel(user);
        if (resolvedModel) {
          const session = this.deps.claudeHandler.getSession(channel, threadTs);
          if (session) {
            session.model = resolvedModel;
          }
        }
        await say({
          text: `✅ *Model Changed*\n\n${result.summary}\n\n${result.description ?? ''}`,
          thread_ts: threadTs,
        });
      } else {
        const aliasesText = Object.keys(MODEL_ALIASES)
          .map((a) => `\`${a}\``)
          .join(', ');
        await say({
          text: `❌ *Unknown Model*\n\n${result.summary}\n\n*Available aliases:* ${aliasesText}\n\n_Use \`model list\` to see all available models._`,
          thread_ts: threadTs,
        });
      }
    }

    return { handled: true };
  }
}
