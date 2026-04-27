import type { WebClient } from '@slack/web-api';
import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import {
  computeContentHash,
  getUserSkill,
  isSingleFileSkill,
  isValidSkillName,
  MAX_INLINE_EDIT_CHARS,
  userSkillExists,
} from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface UserSkillMenuContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/**
 * Single source of truth for the verb embedded in the action `value` payload.
 * The renderer (`UserSkillsListHandler`) imports these to build the option
 * value, and the dispatch in `handleAction` switches on the parsed `kind`.
 * Keeping them here means a typo on either side fails to compile rather than
 * silently degrading to "default invoke".
 */
export const VALUE_KIND_INVOKE = 'user_skill_invoke';
export const VALUE_KIND_EDIT = 'user_skill_edit';

/**
 * Action_id prefixes for the per-skill accessory.
 *
 * Issue #750 promotes the single-button accessory to an overflow menu carrying
 * `발동` + `편집` for single-file skills (multi-file skills still get a plain
 * button). The new prefix `user_skill_menu_` covers overflow accessories;
 * `user_skill_invoke_` stays as the BC button prefix. `actions/index.ts`
 * registers two regexes (`/^user_skill_invoke_/` for legacy in-flight
 * messages, `/^user_skill_menu_/` for new ones) and routes both to the same
 * handler.
 */
export const MENU_ACTION_ID_PREFIX = 'user_skill_menu_';
export const LEGACY_INVOKE_ACTION_ID_PREFIX = 'user_skill_invoke_';

/** callback_id for the inline-edit modal — paired with the view handler. */
export const USER_SKILL_EDIT_MODAL_CALLBACK_ID = 'user_skill_edit_modal_submit';
/** input block_id used inside the edit modal. */
export const USER_SKILL_EDIT_BLOCK_ID = 'user_skill_edit_body';
/**
 * input action_id (the field that carries the new SKILL.md body).
 *
 * Qualified rather than the generic `'value'` so it stays grep-able in logs
 * and won't collide with any future Slack-reserved action_id.
 */
export const USER_SKILL_EDIT_ACTION_ID = 'user_skill_edit_value';

interface ParsedActionValue {
  kind: typeof VALUE_KIND_INVOKE | typeof VALUE_KIND_EDIT;
  skillName: string;
  requesterId: string;
}

interface ResolvedClick {
  value: ParsedActionValue;
  clickerId?: string;
  channel?: string;
  messageTs?: string;
  threadTs?: string;
  triggerId?: string;
}

/**
 * Handles clicks on the buttons / overflow elements rendered by
 * {@link UserSkillsListHandler}.
 *
 * Two action_id prefixes route here:
 *   - `user_skill_invoke_*`  → legacy BC button (single-file skills had a
 *     button accessory before issue #750, and multi-file skills still do).
 *   - `user_skill_menu_*`    → new overflow accessory carrying both
 *     `발동` (invoke) and `편집` (edit) options for single-file skills.
 *
 * The verb is taken from the option/button `value` payload (`kind` field) —
 * not from the action_id prefix — so a future regex consolidation just
 * removes the BC route without touching dispatch logic.
 *
 * Click → requester guard → kind dispatch:
 *   - kind=invoke → stale-skill guard → replace buttons → re-inject
 *     `$user:{name}` as a synthetic user message via `messageHandler`. The
 *     synthetic message re-enters `CommandRouter.route()`, hits
 *     `SkillForceHandler` for `$user:{name}`, and the SKILL.md is resolved
 *     into an `<invoked_skills>` block exactly like a typed `$user:{name}`.
 *   - kind=edit → stale + single-file + length guard → compute SHA-256 hash
 *     of current SKILL.md → `views.open` with `private_metadata` carrying
 *     `{ requesterId, skillName, channelId, threadTs, contentHash }`. The
 *     hash is the stale-guard for the modal-submit path
 *     ({@link UserSkillEditViewSubmissionHandler}).
 */
export class UserSkillMenuActionHandler {
  private logger = new Logger('UserSkillMenuActionHandler');

  constructor(private ctx: UserSkillMenuContext) {}

  /**
   * Single entry point for both `user_skill_invoke_*` and `user_skill_menu_*`
   * action_ids. The framework `ack()` MUST be called before this runs — for
   * `views.open` (edit branch) the framework's 3-second ack budget is shared
   * with the trigger_id usability window, but the wiring layer (`actions/index.ts`)
   * already calls `ack()` first.
   */
  async handleAction(body: any, respond: RespondFn, client?: WebClient): Promise<void> {
    try {
      const click = this.resolveClick(body);
      if (!click) return; // resolveClick already logged

      // Defense: skill name must pass the SAME predicate the store uses
      // (kebab-case + path-segment safety), not just the bare regex —
      // untrusted serialized payload could embed `..` or null bytes.
      if (!isValidSkillName(click.value.skillName)) {
        this.logger.warn('user_skill_menu: invalid skillName', { skillName: click.value.skillName });
        return;
      }

      // Requester binding — only the user who typed `$user` may consume the
      // menu. Other clickers get an ephemeral notice and the menu stays live.
      if (!click.value.requesterId || !click.clickerId || click.clickerId !== click.value.requesterId) {
        this.logger.info('user_skill_menu: clicker !== requester (ephemeral reject)', {
          requesterId: click.value.requesterId,
          clickerId: click.clickerId,
        });
        await respond({
          response_type: 'ephemeral',
          text: click.value.requesterId
            ? `⚠️ 이 메뉴는 <@${click.value.requesterId}>님 전용입니다.`
            : '⚠️ 이 메뉴의 소유자 정보가 누락되었습니다.',
          replace_original: false,
        });
        return;
      }

      if (click.value.kind === VALUE_KIND_EDIT) {
        await this.handleEdit(click, respond, client);
        return;
      }

      // Default: invoke (covers both `kind=user_skill_invoke` and any
      // unrecognized kind — fail safe by routing to the existing invoke
      // path).
      await this.handleInvoke(click, respond);
    } catch (error) {
      this.logger.error('Error processing user skill menu action', error);
    }
  }

  private async handleInvoke(click: ResolvedClick, respond: RespondFn): Promise<void> {
    const { value, channel, messageTs, threadTs } = click;

    if (!channel) {
      this.logger.warn('user_skill_menu invoke: missing channel id', {
        requesterId: value.requesterId,
        skillName: value.skillName,
      });
      return;
    }

    // Stale-skill guard — if the skill was deleted/renamed via MANAGE_SKILL
    // between menu render and click, fail closed and tell the user. Single
    // `existsSync` (via userSkillExists) — no need to enumerate every skill.
    if (!userSkillExists(value.requesterId, value.skillName)) {
      this.logger.info('user_skill_menu invoke: stale click — skill no longer exists', {
        requesterId: value.requesterId,
        skillName: value.skillName,
      });
      await respond({
        response_type: 'ephemeral',
        text: `❌ 스킬이 더 이상 존재하지 않습니다: \`$user:${value.skillName}\``,
        replace_original: false,
      });
      return;
    }

    // Replace the buttons in-place to prevent double-fire confusion. The
    // requester binding above is the actual lock — this is just UI hygiene.
    if (messageTs) {
      const completedBlocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *Personal skill 발동:* \`$user:${value.skillName}\``,
          },
        },
      ];
      await this.ctx.slackApi
        .updateMessage(channel, messageTs, `✅ $user:${value.skillName}`, completedBlocks, [])
        .catch((err: unknown) =>
          this.logger.warn('user_skill_menu invoke: updateMessage failed', {
            channel,
            messageTs,
            error: (err as Error)?.message ?? String(err),
          }),
        );
    }

    // Re-inject `$user:{name}` as a synthetic user message. `requesterId` is
    // used as the message `user` so `SkillForceHandler.resolveSkillPath`
    // reads from the requester's skill dir, not the clicker's. (They are
    // equal here by the requester-binding guard above; this is defense in
    // depth in case the guard ever changes.)
    const say = this.createSayFn(channel);
    await this.ctx.messageHandler(
      {
        user: value.requesterId,
        channel,
        thread_ts: threadTs,
        ts: messageTs ?? '',
        text: `$user:${value.skillName}`,
      },
      say,
    );

    this.logger.info('user_skill_menu: invoke dispatched', {
      requesterId: value.requesterId,
      skillName: value.skillName,
    });
  }

  private async handleEdit(click: ResolvedClick, respond: RespondFn, client?: WebClient): Promise<void> {
    const { value, channel, messageTs, threadTs, triggerId } = click;

    // 1. Read current content. `getUserSkill` returns null when the skill is
    //    missing (stale guard) — no need to call `listUserSkills` separately.
    const detail = getUserSkill(value.requesterId, value.skillName);
    if (!detail) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ 스킬이 더 이상 존재하지 않습니다: \`$user:${value.skillName}\``,
        replace_original: false,
      });
      return;
    }

    // 2. Single-file recheck — gained-a-sibling-file race fails closed.
    if (!isSingleFileSkill(value.requesterId, value.skillName)) {
      await respond({
        response_type: 'ephemeral',
        text: `📁 \`$user:${value.skillName}\` 는 이제 멀티 파일 스킬입니다. \`MANAGE_SKILL update\` 를 사용해주세요.`,
        replace_original: false,
      });
      return;
    }

    // 3. Length fail-closed for the modal cap (Slack `plain_text_input`
    //    `max_length` ≤ 3000 chars).
    if (detail.content.length > MAX_INLINE_EDIT_CHARS) {
      await respond({
        response_type: 'ephemeral',
        text:
          `📏 \`$user:${value.skillName}\` 본문이 너무 깁니다 ` +
          `(${detail.content.length} > ${MAX_INLINE_EDIT_CHARS} chars). ` +
          '`MANAGE_SKILL update` 또는 zip 라운드트립(곧 도입)을 사용해주세요.',
        replace_original: false,
      });
      return;
    }

    // 4. trigger_id has a 3-second usability window; if upstream `ack()` was
    //    slow, `views.open` will fail. Surface that instead of dropping the
    //    click silently.
    if (!triggerId || !client) {
      this.logger.warn('user_skill_menu edit: missing trigger_id or client', {
        hasTriggerId: !!triggerId,
        hasClient: !!client,
      });
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ 모달을 여는 데 필요한 정보가 누락되었습니다 (trigger_id missing).',
        replace_original: false,
      });
      return;
    }

    // 5. Hash the bytes that will become the modal `initial_value`. The
    //    submission handler re-reads SKILL.md and re-hashes; mismatch ⇒ the
    //    skill changed under us between modal-open and modal-submit.
    const contentHash = computeContentHash(detail.content);

    const privateMetadata = JSON.stringify({
      requesterId: value.requesterId,
      skillName: value.skillName,
      channelId: channel ?? '',
      threadTs: threadTs ?? '',
      messageTs: messageTs ?? '',
      contentHash,
    });

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildSkillEditModal({
          skillName: value.skillName,
          initialValue: detail.content,
          privateMetadata,
        }) as any,
      });
      this.logger.info('user_skill_menu: edit modal opened', {
        requesterId: value.requesterId,
        skillName: value.skillName,
      });
    } catch (err) {
      this.logger.error('user_skill_menu edit: views.open failed', {
        skillName: value.skillName,
        err: (err as Error)?.message ?? String(err),
      });
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 편집 모달을 여는 데 실패했습니다: ${(err as Error)?.message ?? String(err)}`,
        replace_original: false,
      });
    }
  }

  private resolveClick(body: any): ResolvedClick | null {
    const action = body?.actions?.[0];
    if (!action) {
      this.logger.warn('user_skill_menu: missing action payload');
      return null;
    }

    // Overflow elements deliver the picked option in `selected_option.value`.
    // Buttons (BC + multi-file) deliver the value directly on `action.value`.
    const rawValue: unknown =
      typeof action.selected_option?.value === 'string'
        ? action.selected_option.value
        : typeof action.value === 'string'
          ? action.value
          : null;

    if (typeof rawValue !== 'string') {
      this.logger.warn('user_skill_menu: missing string value on action');
      return null;
    }

    let parsed: { kind?: unknown; skillName?: unknown; requesterId?: unknown };
    try {
      parsed = JSON.parse(rawValue);
    } catch (parseError) {
      this.logger.warn('user_skill_menu: malformed JSON value', {
        error: (parseError as Error)?.message,
      });
      return null;
    }

    const skillName = typeof parsed.skillName === 'string' ? parsed.skillName : '';
    const requesterId = typeof parsed.requesterId === 'string' ? parsed.requesterId : '';
    const rawKind = typeof parsed.kind === 'string' ? parsed.kind : VALUE_KIND_INVOKE;
    const kind = rawKind === VALUE_KIND_EDIT ? VALUE_KIND_EDIT : VALUE_KIND_INVOKE;

    const messageTs: string | undefined = body?.message?.ts;
    return {
      value: { kind, skillName, requesterId },
      clickerId: body?.user?.id,
      channel: body?.channel?.id,
      messageTs,
      threadTs: body?.message?.thread_ts || messageTs,
      triggerId: body?.trigger_id,
    };
  }

  private createSayFn(channel: string): SayFn {
    return async (args: any) => {
      const msgArgs = typeof args === 'string' ? { text: args } : args;
      return this.ctx.slackApi.postMessage(channel, msgArgs.text, {
        threadTs: msgArgs.thread_ts,
        blocks: msgArgs.blocks,
        attachments: msgArgs.attachments,
      });
    };
  }
}

/**
 * Build the inline-edit Slack modal view payload.
 *
 * Exposed for tests + the action-handler. The body (skill content) lives in
 * the `multiline plain_text_input` element with the issue-#750-fixed
 * `block_id` / `action_id`. `initial_value` is the verbatim SKILL.md bytes
 * the menu handler read at click time.
 */
export function buildSkillEditModal(args: {
  skillName: string;
  initialValue: string;
  privateMetadata: string;
}): Record<string, any> {
  return {
    type: 'modal',
    callback_id: USER_SKILL_EDIT_MODAL_CALLBACK_ID,
    private_metadata: args.privateMetadata,
    title: { type: 'plain_text', text: `✏️ $user:${args.skillName}`.slice(0, 24) },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              `\`$user:${args.skillName}\` 의 SKILL.md (frontmatter 포함) 를 그대로 수정하세요. ` +
              '저장 시 본인 책임이며 잘못된 frontmatter 는 description 빈 값으로 처리됩니다.',
          },
        ],
      },
      {
        type: 'input',
        block_id: USER_SKILL_EDIT_BLOCK_ID,
        label: { type: 'plain_text', text: 'SKILL.md' },
        element: {
          type: 'plain_text_input',
          action_id: USER_SKILL_EDIT_ACTION_ID,
          multiline: true,
          initial_value: args.initialValue,
          max_length: MAX_INLINE_EDIT_CHARS,
        },
      },
    ],
  };
}
