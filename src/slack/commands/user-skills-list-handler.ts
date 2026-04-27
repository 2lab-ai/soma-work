import { Logger } from '../../logger';
import { listUserSkills } from '../../user-skill-store';
import { escapeSlackMrkdwn } from '../mrkdwn-escape';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Slack message blocks have a hard cap of 50 (per Slack Block Kit docs).
 * `user-skill-store.ts` enforces `MAX_SKILLS_PER_USER = 50`, so under the
 * current invariant we can render one section per skill and stay at the cap.
 *
 * If that invariant is ever weakened, we trim to {@link MAX_SECTIONS_BEFORE_OVERFLOW}
 * sections and append a single context block summarising the hidden tail —
 * keeping total blocks ≤ 50.
 */
const STORE_CAP = 50;
const MAX_SECTIONS_BEFORE_OVERFLOW = 49; // 49 sections + 1 context = 50 blocks

/** Description truncation for safety against the section.text 3000-char cap. */
const DESC_TRUNC_LEN = 200;

/** Action ID prefix matched by `/^user_skill_invoke_/` in `actions/index.ts`. */
const ACTION_ID_PREFIX = 'user_skill_invoke_';

const VALUE_KIND = 'user_skill_invoke';

/**
 * Handles bare `$user` (single token) — lists the requesting user's personal
 * skills as Slack buttons. Each button, when clicked, dispatches via
 * `UserSkillInvokeActionHandler` which re-injects `$user:{name}` into the
 * Slack message pipeline (the same path a typed `$user:{name}` takes).
 *
 * Registered BEFORE `SkillForceHandler` in `command-router.ts` so that bare
 * `$user` is intercepted here even if a hypothetical local skill named
 * `user` ever existed under `dist/local/skills/user/SKILL.md`.
 *
 * Qualified refs (`$user:foo`) are NOT claimed — they remain with
 * `SkillForceHandler` (preserves existing behavior).
 */
export class UserSkillsListHandler implements CommandHandler {
  private logger = new Logger('UserSkillsListHandler');

  /** Matches exactly `$user` with optional surrounding whitespace, case-insensitive. */
  canHandle(text: string): boolean {
    return /^\s*\$user\s*$/i.test(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, say, threadTs } = ctx;
    const skills = listUserSkills(user);

    if (skills.length === 0) {
      await say({
        text: '📭 등록된 personal skill이 없습니다. `MANAGE_SKILL` 커맨드 또는 `skills` 도움말을 참고하세요.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Defensive trim if store cap is ever raised above 50 in the future.
    const overflowed = skills.length > STORE_CAP;
    const renderable = overflowed ? skills.slice(0, MAX_SECTIONS_BEFORE_OVERFLOW) : skills;

    const blocks: any[] = renderable.map((s) => this.buildSkillSection(s, user));

    if (overflowed) {
      const hidden = skills.length - MAX_SECTIONS_BEFORE_OVERFLOW;
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `⚠️ ${hidden} more skills hidden — store cap exceeded; please update render limit.`,
          },
        ],
      });
    }

    const fallback = `🎯 Personal Skills (${skills.length}) — 버튼을 눌러 발동`;

    this.logger.info('Listed personal skills as buttons', {
      user,
      count: skills.length,
      rendered: renderable.length,
    });

    await say({
      text: fallback,
      thread_ts: threadTs,
      blocks,
    });

    return { handled: true };
  }

  private buildSkillSection(skill: { name: string; description: string }, requesterId: string): any {
    const safeDesc = escapeSlackMrkdwn(skill.description || '_(no description)_').substring(0, DESC_TRUNC_LEN);
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\`$user:${skill.name}\`*\n${safeDesc}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: '발동', emoji: true },
        action_id: `${ACTION_ID_PREFIX}${skill.name}`,
        value: JSON.stringify({
          kind: VALUE_KIND,
          skillName: skill.name,
          requesterId,
        }),
      },
    };
  }
}
