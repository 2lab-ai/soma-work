import { Logger } from '../../logger';
import { listUserSkills, type UserSkillMeta } from '../../user-skill-store';
import {
  LEGACY_INVOKE_ACTION_ID_PREFIX,
  MENU_ACTION_ID_PREFIX,
  VALUE_KIND_EDIT,
  VALUE_KIND_INVOKE,
} from '../actions/user-skill-menu-action-handler';
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

/** Slack overflow option text caps. Each `text.text` is plain_text ≤ 75 chars. */
const OVERFLOW_OPTION_TEXT_MAX = 75;
/** Slack overflow needs at least 2 options; below that we fall back to button. */
const OVERFLOW_MIN_OPTIONS = 2;

/**
 * Handles bare `$user` (single token) — lists the requesting user's personal
 * skills as Slack buttons. Each button, when clicked, dispatches via
 * `UserSkillMenuActionHandler` which re-injects `$user:{name}` into the
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

    const fallback = `🎯 Personal Skills (${skills.length}) — 버튼을 눌러 발동/편집`;

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

  private buildSkillSection(skill: UserSkillMeta, requesterId: string): any {
    const baseDesc = skill.description || '_(no description)_';
    const safeDesc = escapeSlackMrkdwn(baseDesc).substring(0, DESC_TRUNC_LEN);
    // Multi-file skills get an inline label inside the section text — no
    // separate context block (issue #750 §정책 확정: "별도 블록 0").
    const multiFileNote = skill.isSingleFile ? '' : '\n_📁 multi-file — `MANAGE_SKILL update` 사용_';
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*\`$user:${skill.name}\`*\n${safeDesc}${multiFileNote}`,
      },
      accessory: this.buildSkillAccessory(skill.name, requesterId, skill.isSingleFile),
    };
  }

  /**
   * Build the accessory element (overflow / button / undefined).
   *
   * - Single-file skill → overflow with 발동 + 편집 (≥2 options ⇒ overflow valid).
   * - Multi-file skill → button with 발동 only (BC-compatible action_id).
   * - Zero-option fallback → no accessory + a context note. This is defensive;
   *   under current invariants we always emit ≥1 option.
   */
  private buildSkillAccessory(skillName: string, requesterId: string, isSingle: boolean): any {
    const invokeOption = this.buildOption('🚀 발동', VALUE_KIND_INVOKE, skillName, requesterId);
    const editOption = isSingle ? this.buildOption('✏️ 편집', VALUE_KIND_EDIT, skillName, requesterId) : null;

    // Filter out any option whose visible text exceeded Slack's 75-char cap.
    // Today the labels are static emojis + Korean — the filter is defensive
    // for future label changes.
    const options = [invokeOption, editOption].filter((o): o is OverflowOption => o !== null);
    const safe = options.filter((o) => o.text.text.length <= OVERFLOW_OPTION_TEXT_MAX);

    if (safe.length === 0) {
      // Defensive zero-option fallback — render no accessory at all so the
      // Slack client doesn't reject the block. Users can still invoke the
      // skill by typing `$user:<name>` directly.
      this.logger.warn('user-skill list: zero renderable options', { skillName });
      return undefined;
    }

    if (safe.length >= OVERFLOW_MIN_OPTIONS) {
      return {
        type: 'overflow',
        action_id: `${MENU_ACTION_ID_PREFIX}${skillName}`,
        options: safe,
      };
    }

    // Exactly one option ⇒ button (overflow needs ≥2). Multi-file skills land
    // here. We keep the legacy `user_skill_invoke_` prefix so any in-flight
    // message rendered by an older release still routes correctly even after
    // the BC regex is eventually removed.
    const only = safe[0];
    return {
      type: 'button',
      text: { type: 'plain_text', text: only.text.text, emoji: true },
      action_id: `${LEGACY_INVOKE_ACTION_ID_PREFIX}${skillName}`,
      value: only.value,
    };
  }

  private buildOption(label: string, kind: string, skillName: string, requesterId: string): OverflowOption {
    return {
      text: { type: 'plain_text', text: label, emoji: true },
      value: JSON.stringify({ kind, skillName, requesterId }),
    };
  }
}

interface OverflowOption {
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  value: string;
}
