import { Logger } from '../../logger';
import { listUserSkills, type UserSkillMeta, userSkillExists } from '../../user-skill-store';
// Pulled from the leaf module instead of '../actions/user-skill-menu-action-handler'
// to break the cycle list-handler → menu-action-handler → view-submission-shared
// → list-handler (#745).
import {
  LEGACY_INVOKE_ACTION_ID_PREFIX,
  MENU_ACTION_ID_PREFIX,
  VALUE_KIND_COPY,
  VALUE_KIND_DELETE,
  VALUE_KIND_EDIT,
  VALUE_KIND_INVOKE,
  VALUE_KIND_RENAME,
  VALUE_KIND_SHARE,
  VALUE_KIND_VIEW,
} from '../actions/user-skill-action-kinds';
import { escapeSlackMrkdwn } from '../mrkdwn-escape';
import type { CommandContext, CommandHandler, CommandResult } from './types';
import { resolveUserIdentifier, type UserResolver } from './user-identity-resolver';

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
/** Slack `overflow` element accepts at most 5 options. Hit the cap on
 *  single-file skills (invoke/edit/delete/rename/share); multi-file skills
 *  drop the edit option to stay at 4. */
const OVERFLOW_MAX_OPTIONS = 5;

const helperLogger = new Logger('UserSkillsListBuilder');

/**
 * Pure helper — fetches the user's skills, builds Slack blocks (sections +
 * overflow accessories), and returns them along with a fallback text. Used by
 * both the bare `$user` command (`UserSkillsListHandler.execute`) and the
 * rename / delete view-submission handlers, which need to re-render the same
 * list after a successful mutation in order to update the originating message
 * in place.
 *
 * Returning `null` means "no skills" — caller decides whether to render a
 * placeholder or hide the message entirely.
 */
export interface UserSkillListBlocks {
  blocks: any[];
  fallback: string;
  count: number;
}

export function buildUserSkillListBlocks(userId: string): UserSkillListBlocks | null {
  const skills = listUserSkills(userId);
  if (skills.length === 0) return null;

  // Defensive trim if store cap is ever raised above 50 in the future.
  const overflowed = skills.length > STORE_CAP;
  const renderable = overflowed ? skills.slice(0, MAX_SECTIONS_BEFORE_OVERFLOW) : skills;

  const blocks: any[] = renderable.map((s) => buildSkillSection(s, userId));

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

  const fallback = `🎯 Personal Skills (${skills.length}) — 버튼을 눌러 발동/편집/삭제/이름변경/공유`;

  return { blocks, fallback, count: skills.length };
}

/**
 * Build blocks for ANOTHER user's skill list (`$user:{otherUser}`, S4).
 *
 * Each skill renders with an overflow hamburger carrying three verbs:
 *   🚀 발동 (invoke the owner's skill via `$<@owner>:name`)
 *   👀 보기 (view the SKILL.md — read-only)
 *   📋 복사 (copy into the clicker's own skill set)
 *
 * The action value carries BOTH `ownerId` (the source user) and `requesterId`
 * (the clicker who rendered the list, used for the click-binding guard).
 */
export function buildOtherUserSkillListBlocks(ownerId: string, requesterId: string): UserSkillListBlocks | null {
  const skills = listUserSkills(ownerId);
  if (skills.length === 0) return null;

  // Slack hard-caps a message at 50 blocks. This list reserves 1 block for the
  // owner header, so at most STORE_CAP-1 (49) section blocks fit. When the owner
  // has more skills than that, we render one fewer section and append a single
  // truncation context block — keeping header + sections + note ≤ 50.
  const SECTION_BUDGET = STORE_CAP - 1; // 49 (reserve 1 for the header)
  const overflowed = skills.length > SECTION_BUDGET;
  const renderable = overflowed ? skills.slice(0, SECTION_BUDGET - 1) : skills;

  const blocks: any[] = [
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `🎯 <@${ownerId}> 님의 Personal Skills (${skills.length})` }],
    },
    ...renderable.map((s) => buildOtherUserSkillSection(s, ownerId, requesterId)),
  ];

  if (overflowed) {
    const hidden = skills.length - renderable.length;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `⚠️ ${hidden} more skills hidden — open their list to see all.` }],
    });
  }

  const fallback = `🎯 <@${ownerId}> 님의 Personal Skills (${skills.length}) — 발동/보기/복사`;
  return { blocks, fallback, count: skills.length };
}

function buildOtherUserSkillSection(skill: UserSkillMeta, ownerId: string, requesterId: string): any {
  const baseDesc = skill.description || '_(no description)_';
  const safeDesc = escapeSlackMrkdwn(baseDesc).substring(0, DESC_TRUNC_LEN);
  const multiFileNote = skill.isSingleFile ? '' : '\n_📁 multi-file_';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*\`$<@${ownerId}>:${skill.name}\`*\n${safeDesc}${multiFileNote}`,
    },
    accessory: {
      type: 'overflow',
      action_id: `${MENU_ACTION_ID_PREFIX}${skill.name}`,
      options: [
        buildOwnerOption('🚀 발동', VALUE_KIND_INVOKE, skill.name, requesterId, ownerId),
        buildOwnerOption('👀 보기', VALUE_KIND_VIEW, skill.name, requesterId, ownerId),
        buildOwnerOption('📋 복사', VALUE_KIND_COPY, skill.name, requesterId, ownerId),
      ],
    },
  };
}

function buildOwnerOption(
  label: string,
  kind: string,
  skillName: string,
  requesterId: string,
  ownerId: string,
): OverflowOption {
  return {
    text: { type: 'plain_text', text: label, emoji: true },
    value: JSON.stringify({ kind, skillName, requesterId, ownerId }),
  };
}

function buildSkillSection(skill: UserSkillMeta, requesterId: string): any {
  const baseDesc = skill.description || '_(no description)_';
  const safeDesc = escapeSlackMrkdwn(baseDesc).substring(0, DESC_TRUNC_LEN);
  const multiFileNote = skill.isSingleFile ? '' : '\n_📁 multi-file — 편집은 `MANAGE_SKILL update` 사용_';
  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*\`$user:${skill.name}\`*\n${safeDesc}${multiFileNote}`,
    },
    accessory: buildSkillAccessory(skill.name, requesterId, skill.isSingleFile),
  };
}

interface OverflowOption {
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  value: string;
}

function buildOption(label: string, kind: string, skillName: string, requesterId: string): OverflowOption {
  return {
    text: { type: 'plain_text', text: label, emoji: true },
    value: JSON.stringify({ kind, skillName, requesterId }),
  };
}

/**
 * Build the accessory element (overflow / button / undefined).
 *
 * - Single-file skill → overflow with 5 options (발동 + 편집 + 삭제 + 이름변경 + 공유).
 * - Multi-file skill → overflow with 4 options (발동 + 삭제 + 이름변경 + 공유).
 *   `편집` (inline-edit modal) requires single-file because the modal can only
 *   round-trip a single SKILL.md.
 * - Slack `overflow` accepts ≤5 options; we hit the cap exactly on single-file.
 *
 * The legacy `user_skill_invoke_*` button prefix is retained only as a defensive
 * single-option fallback (e.g. if every-option-but-one exceeds the 75-char cap).
 * Today's labels are 4-Korean-char emoji prefixes, far under the cap, so this
 * branch is unreachable under normal conditions.
 */
function buildSkillAccessory(skillName: string, requesterId: string, isSingle: boolean): any {
  // Build options in user-facing order. Single-file gets 편집 inserted second
  // (right after 발동) so the most-used pair sits at the top of the menu.
  const candidates: (OverflowOption | null)[] = [
    buildOption('🚀 발동', VALUE_KIND_INVOKE, skillName, requesterId),
    isSingle ? buildOption('✏️ 편집', VALUE_KIND_EDIT, skillName, requesterId) : null,
    buildOption('🗑 삭제', VALUE_KIND_DELETE, skillName, requesterId),
    buildOption('📝 이름변경', VALUE_KIND_RENAME, skillName, requesterId),
    buildOption('📤 공유', VALUE_KIND_SHARE, skillName, requesterId),
  ];

  // Filter null + per-Slack 75-char cap (defensive against future label changes).
  const safe = candidates
    .filter((o): o is OverflowOption => o !== null)
    .filter((o) => o.text.text.length <= OVERFLOW_OPTION_TEXT_MAX)
    .slice(0, OVERFLOW_MAX_OPTIONS);

  if (safe.length === 0) {
    // Defensive zero-option fallback — render no accessory at all so the
    // Slack client doesn't reject the block. Users can still invoke the
    // skill by typing `$user:<name>` directly.
    helperLogger.warn('user-skill list: zero renderable options', { skillName });
    return undefined;
  }

  if (safe.length >= OVERFLOW_MIN_OPTIONS) {
    return {
      type: 'overflow',
      action_id: `${MENU_ACTION_ID_PREFIX}${skillName}`,
      options: safe,
    };
  }

  // Exactly one option ⇒ button (overflow needs ≥2). Defensive fallback only.
  // We keep the legacy `user_skill_invoke_` prefix so any in-flight message
  // rendered by an older release still routes correctly even after the BC
  // regex is eventually removed.
  const only = safe[0];
  return {
    type: 'button',
    text: { type: 'plain_text', text: only.text.text, emoji: true },
    action_id: `${LEGACY_INVOKE_ACTION_ID_PREFIX}${skillName}`,
    value: only.value,
  };
}

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

  /**
   * @param resolveUser maps a Slack identifier to a uid for the cross-user list
   *   form `$user:{otherUser}` (S4/S6). Defaults to the offline resolver;
   *   injected as a stub in tests.
   */
  constructor(private resolveUser: UserResolver = resolveUserIdentifier) {}

  /** Matches exactly `$user` with optional surrounding whitespace, case-insensitive. */
  private static readonly BARE_RE = /^\s*\$user\s*$/i;
  /** Matches `$user:{target}` — a single token after the colon. */
  private static readonly TARGET_RE = /^\s*\$user:(\S+)\s*$/i;

  /**
   * Resolve `$user:{target}` to ANOTHER user's uid, or `null` when the form
   * doesn't apply. Own-skill invocation wins for backward compatibility: if
   * `target` is the requester's own skill, this returns `null` so the qualified
   * `$user:{skill}` ref falls through to `SkillForceHandler`.
   */
  private resolveOtherUser(text: string, userId?: string): string | null {
    if (!userId) return null;
    const m = text.match(UserSkillsListHandler.TARGET_RE);
    if (!m) return null;
    const target = m[1];
    // Own skill wins (BC) — let SkillForceHandler invoke it.
    if (userSkillExists(userId, target)) return null;
    const ownerId = this.resolveUser(target);
    if (!ownerId || ownerId === userId) return null;
    return ownerId;
  }

  canHandle(text: string, userId?: string): boolean {
    if (UserSkillsListHandler.BARE_RE.test(text)) return true;
    return this.resolveOtherUser(text, userId) !== null;
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { user, say, threadTs, text } = ctx;

    // Cross-user list: `$user:{otherUser}` (S4).
    const ownerId = this.resolveOtherUser(text, user);
    if (ownerId) {
      const built = buildOtherUserSkillListBlocks(ownerId, user);
      if (!built) {
        await say({
          text: `📭 <@${ownerId}> 님은 등록된 personal skill이 없습니다.`,
          thread_ts: threadTs,
        });
        return { handled: true };
      }
      this.logger.info('Listed another user’s skills', { requester: user, owner: ownerId, count: built.count });
      await say({ text: built.fallback, thread_ts: threadTs, blocks: built.blocks });
      return { handled: true };
    }

    const built = buildUserSkillListBlocks(user);

    if (!built) {
      await say({
        text: '📭 등록된 personal skill이 없습니다. `MANAGE_SKILL` 커맨드 또는 `skills` 도움말을 참고하세요.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    this.logger.info('Listed personal skills as buttons', {
      user,
      count: built.count,
      blocks: built.blocks.length,
    });

    await say({
      text: built.fallback,
      thread_ts: threadTs,
      blocks: built.blocks,
    });

    return { handled: true };
  }
}
