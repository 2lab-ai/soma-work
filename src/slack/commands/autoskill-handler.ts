import { autoskillExists } from '../../skill-locator';
import { MAX_AUTOSKILLS, userSettingsStore } from '../../user-settings-store';
import { buildAutoskillCard } from '../autoskill-blocks';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles the `autoskill` command family:
 *
 *   - `autoskill`                  → render the management card (list + delete
 *                                    buttons + ➕ 추가 button).
 *   - `set autoskill a, b, c`      → replace the registered list in one shot.
 *   - `set autoskill clear`/`none` → clear the list.
 *
 * Registered skills are force-injected into every fresh system-prompt build for
 * the user (see `prompt-builder.applyAutoskills`), so a new session/task always
 * starts with them active. Skill names are validated against the same fallback
 * chain `$skill` uses (`skill-locator`).
 */
export class AutoskillHandler implements CommandHandler {
  canHandle(text: string): boolean {
    return CommandParser.isAutoskillCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, text, threadTs, say } = ctx;
    const action = CommandParser.parseAutoskillCommand(text);

    if (action.action === 'set') {
      return this.applySet(ctx, action.skills);
    }

    // status → render the management card.
    const skills = userSettingsStore.getUserAutoskills(user);
    const card = buildAutoskillCard({ requesterId: user, skills });
    await say({ text: card.text, blocks: card.blocks, thread_ts: threadTs });
    return { handled: true };
  }

  /**
   * Replace the registered list. Unknown skill names (not resolvable via the
   * fallback chain) are rejected up-front so the user can't register a typo
   * that would silently no-op at injection time.
   */
  private async applySet(ctx: CommandContext, requested: string[]): Promise<CommandResult> {
    const { user, threadTs, say } = ctx;

    if (requested.length === 0) {
      userSettingsStore.setUserAutoskills(user, []);
      const card = buildAutoskillCard({ requesterId: user, skills: [] });
      await say({ text: '✅ autoskill 목록을 비웠습니다.', blocks: card.blocks, thread_ts: threadTs });
      return { handled: true };
    }

    const valid: string[] = [];
    const unknown: string[] = [];
    for (const name of requested) {
      if (autoskillExists(name, user)) valid.push(name);
      else unknown.push(name);
    }

    if (valid.length === 0) {
      await say({
        text:
          `❌ 등록할 수 있는 스킬을 찾지 못했습니다: ${unknown.map((s) => `\`${s}\``).join(', ')}\n` +
          '`autoskill` 을 입력해 추가 가능한 스킬 목록을 확인하세요.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const capped = valid.slice(0, MAX_AUTOSKILLS);
    userSettingsStore.setUserAutoskills(user, capped);
    const stored = userSettingsStore.getUserAutoskills(user);
    const card = buildAutoskillCard({ requesterId: user, skills: stored });

    let msg = `✅ autoskill 설정 완료: ${stored.map((s) => `\`${s}\``).join(', ')}`;
    if (unknown.length > 0) {
      msg += `\n⚠️ 무시된(찾을 수 없는) 스킬: ${unknown.map((s) => `\`${s}\``).join(', ')}`;
    }
    if (valid.length > MAX_AUTOSKILLS) {
      msg += `\n⚠️ 최대 ${MAX_AUTOSKILLS}개까지만 저장됩니다.`;
    }
    await say({ text: msg, blocks: card.blocks, thread_ts: threadTs });
    return { handled: true };
  }
}
