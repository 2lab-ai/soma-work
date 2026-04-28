import type { WebClient } from '@slack/web-api';
import { SHARE_CONTENT_CHAR_LIMIT, shareOverLimitMessage } from 'somalib/model-commands/skill-share-errors';
import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import {
  computeContentHash,
  getUserSkill,
  isSingleFileSkill,
  isValidSkillName,
  MAX_INLINE_EDIT_CHARS,
  MAX_SKILL_NAME_LENGTH,
  shareUserSkill,
  userSkillExists,
} from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';
import { buildSkillViewPrivateMetadata } from './user-skill-view-submission-shared';

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
 * Issue #774 additions — keep verbs alongside the existing pair so the
 * dispatch in `handleAction` stays exhaustive at compile time.
 *
 *   delete  → opens a confirmation modal (Slack overflow options can't carry
 *             their own confirm dialog, so a 2-step modal is the safest UX).
 *   rename  → opens a rename modal (single text input).
 *   share   → posts an ephemeral message with a four-backtick fenced code
 *             block carrying the SKILL.md content + install instructions.
 *             Read-only (does not fire system-prompt invalidation).
 */
export const VALUE_KIND_DELETE = 'user_skill_delete';
export const VALUE_KIND_RENAME = 'user_skill_rename';
export const VALUE_KIND_SHARE = 'user_skill_share';

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

/** callback_id / block / action ids for the rename modal (issue #774). */
export const USER_SKILL_RENAME_MODAL_CALLBACK_ID = 'user_skill_rename_modal_submit';
export const USER_SKILL_RENAME_BLOCK_ID = 'user_skill_rename_input';
export const USER_SKILL_RENAME_ACTION_ID = 'user_skill_rename_value';

/** callback_id for the delete confirmation modal (issue #774). */
export const USER_SKILL_DELETE_MODAL_CALLBACK_ID = 'user_skill_delete_modal_submit';

type SkillMenuKind =
  | typeof VALUE_KIND_INVOKE
  | typeof VALUE_KIND_EDIT
  | typeof VALUE_KIND_DELETE
  | typeof VALUE_KIND_RENAME
  | typeof VALUE_KIND_SHARE;

interface ParsedActionValue {
  kind: SkillMenuKind;
  skillName: string;
  requesterId: string;
}

const KNOWN_KINDS: ReadonlySet<SkillMenuKind> = new Set([
  VALUE_KIND_INVOKE,
  VALUE_KIND_EDIT,
  VALUE_KIND_DELETE,
  VALUE_KIND_RENAME,
  VALUE_KIND_SHARE,
]);

/**
 * Build the fenced share message body.
 *
 * Three backticks is the most common fence; SKILL.md authors frequently embed
 * triple-backtick examples (e.g. ```python ... ```), which would chop a
 * 3-backtick wrapper at the first inner fence. Four backticks works for those
 * but breaks again if a SKILL.md happens to contain a 4-backtick literal of
 * its own. Solution: scan `content` for the longest run of backticks and pick
 * a fence one tick longer (minimum 4). This is the standard CommonMark
 * "longest-fence-wins" trick and guarantees the wrapper outlives anything
 * the body could carry.
 */
function chooseSafeFence(content: string): string {
  // Find the longest contiguous backtick run in the body.
  let longest = 0;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > longest) longest = m.length;
    }
  }
  // Floor at 3 (so the result is ≥ 4) — Slack treats <3 as inline code.
  const fenceLen = Math.max(longest, 3) + 1;
  return '`'.repeat(fenceLen);
}

function buildShareMessage(skillName: string, content: string): string {
  const fence = chooseSafeFence(content);
  return [
    `📤 *Personal skill 공유:* \`$user:${skillName}\``,
    '',
    '복사해서 다른 워크스페이스 / 다른 유저에게 전달하면 됩니다.',
    '받는 쪽은 동일한 이름으로 `MANAGE_SKILL action=create` 호출하면 설치됩니다.',
    '',
    fence,
    content,
    fence,
  ].join('\n');
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

      switch (click.value.kind) {
        case VALUE_KIND_EDIT:
          await this.handleEdit(click, respond, client);
          return;
        case VALUE_KIND_DELETE:
          await this.handleDelete(click, respond, client);
          return;
        case VALUE_KIND_RENAME:
          await this.handleRename(click, respond, client);
          return;
        case VALUE_KIND_SHARE:
          await this.handleShare(click, respond);
          return;
        case VALUE_KIND_INVOKE:
        default:
          // Fail safe: any unrecognized kind routes to invoke (the most-used
          // verb). resolveClick already coerces unknown kinds to INVOKE, so
          // the default branch is defensive.
          await this.handleInvoke(click, respond);
          return;
      }
    } catch (error) {
      this.logger.error('Error processing user skill menu action', error);
      // Best-effort visible failure — without this the click vanishes silently
      // (the spinner stops but no message appears), which is indistinguishable
      // from "Slack ate the click" for the user. Each verb's own try/catch
      // already converts known failures into ephemerals; this catches the
      // pre-dispatch path (resolveClick crash, isValidSkillName throw, etc.).
      // The respond call itself is wrapped so a transport failure here can't
      // mask the original error in the logs.
      try {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ 메뉴 처리 중 예상치 못한 오류가 발생했습니다.',
          replace_original: false,
        });
      } catch (respondErr) {
        this.logger.warn('user_skill_menu: ack-after-error respond failed', {
          err: (respondErr as Error)?.message ?? String(respondErr),
        });
      }
    }
  }

  /**
   * Open the delete confirmation modal. Slack `overflow` options can't carry
   * a per-option `confirm` dialog (the dialog applies to the whole element),
   * so we use a 2-step modal: option click → modal "정말 삭제할까요?" → confirm.
   */
  private async handleDelete(click: ResolvedClick, respond: RespondFn, client?: WebClient): Promise<void> {
    const { value, channel, messageTs, threadTs, triggerId } = click;

    if (!userSkillExists(value.requesterId, value.skillName)) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ 스킬이 더 이상 존재하지 않습니다: \`$user:${value.skillName}\``,
        replace_original: false,
      });
      return;
    }

    if (!triggerId || !client) {
      this.logger.warn('user_skill_menu delete: missing trigger_id or client');
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ 모달을 여는 데 필요한 정보가 누락되었습니다 (trigger_id missing).',
        replace_original: false,
      });
      return;
    }

    const privateMetadata = buildSkillViewPrivateMetadata({
      requesterId: value.requesterId,
      skillName: value.skillName,
      channelId: channel ?? '',
      threadTs: threadTs ?? '',
      messageTs: messageTs ?? '',
    });

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildSkillDeleteModal({ skillName: value.skillName, privateMetadata }) as any,
      });
      this.logger.info('user_skill_menu: delete modal opened', {
        requesterId: value.requesterId,
        skillName: value.skillName,
      });
    } catch (err) {
      this.logger.error('user_skill_menu delete: views.open failed', {
        skillName: value.skillName,
        err: (err as Error)?.message ?? String(err),
      });
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 삭제 확인 모달을 여는 데 실패했습니다: ${(err as Error)?.message ?? String(err)}`,
        replace_original: false,
      });
    }
  }

  /**
   * Open the rename modal. The view-submission handler revalidates the new
   * name and calls `renameUserSkill`. Storage-layer errors map to inline
   * `response_action: 'errors'` strings via the granular error code so the
   * user sees a precise message (target exists / invalid name / etc.).
   */
  private async handleRename(click: ResolvedClick, respond: RespondFn, client?: WebClient): Promise<void> {
    const { value, channel, messageTs, threadTs, triggerId } = click;

    if (!userSkillExists(value.requesterId, value.skillName)) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ 스킬이 더 이상 존재하지 않습니다: \`$user:${value.skillName}\``,
        replace_original: false,
      });
      return;
    }

    if (!triggerId || !client) {
      this.logger.warn('user_skill_menu rename: missing trigger_id or client');
      await respond({
        response_type: 'ephemeral',
        text: '⚠️ 모달을 여는 데 필요한 정보가 누락되었습니다 (trigger_id missing).',
        replace_original: false,
      });
      return;
    }

    const privateMetadata = buildSkillViewPrivateMetadata({
      requesterId: value.requesterId,
      skillName: value.skillName,
      channelId: channel ?? '',
      threadTs: threadTs ?? '',
      messageTs: messageTs ?? '',
    });

    try {
      await client.views.open({
        trigger_id: triggerId,
        view: buildSkillRenameModal({ skillName: value.skillName, privateMetadata }) as any,
      });
      this.logger.info('user_skill_menu: rename modal opened', {
        requesterId: value.requesterId,
        skillName: value.skillName,
      });
    } catch (err) {
      this.logger.error('user_skill_menu rename: views.open failed', {
        skillName: value.skillName,
        err: (err as Error)?.message ?? String(err),
      });
      await respond({
        response_type: 'ephemeral',
        text: `⚠️ 이름변경 모달을 여는 데 실패했습니다: ${(err as Error)?.message ?? String(err)}`,
        replace_original: false,
      });
    }
  }

  /**
   * Post the SKILL.md as an ephemeral four-backtick code block. Read-only —
   * does not fire the system-prompt invalidation hook. The 2500-char cap
   * matches the wire-level dispatcher's `SHARE_CONTENT_CHAR_LIMIT` so a Slack-
   * shared SKILL.md can also be installed via MANAGE_SKILL share without
   * surprise truncation.
   */
  private async handleShare(click: ResolvedClick, respond: RespondFn): Promise<void> {
    const { value } = click;

    const result = shareUserSkill(value.requesterId, value.skillName);
    if (!result.ok || result.content === undefined) {
      await respond({
        response_type: 'ephemeral',
        text: `❌ ${result.message}`,
        replace_original: false,
      });
      return;
    }

    if (result.content.length > SHARE_CONTENT_CHAR_LIMIT) {
      // Same wire-level cap as the model-command dispatcher. Slack would
      // accept the larger payload (the message limit is 40000 chars), but
      // we want the share UX to match what a recipient model can install
      // via MANAGE_SKILL action=create — that path enforces the same cap.
      await respond({
        response_type: 'ephemeral',
        text: `❌ ${shareOverLimitMessage(value.skillName, result.content.length)}`,
        replace_original: false,
      });
      return;
    }

    const body = buildShareMessage(value.skillName, result.content);
    await respond({
      response_type: 'ephemeral',
      text: body,
      replace_original: false,
    });

    this.logger.info('user_skill_menu: share rendered', {
      requesterId: value.requesterId,
      skillName: value.skillName,
      length: result.content.length,
    });
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

    const privateMetadata = buildSkillViewPrivateMetadata(
      {
        requesterId: value.requesterId,
        skillName: value.skillName,
        channelId: channel ?? '',
        threadTs: threadTs ?? '',
        messageTs: messageTs ?? '',
      },
      { contentHash },
    );

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
    // Whitelist known kinds — anything else (forged payload, future verb
    // typo, etc.) collapses to INVOKE (the original BC behavior). New verbs
    // MUST be added to KNOWN_KINDS to be reachable.
    const kind: SkillMenuKind = KNOWN_KINDS.has(rawKind as SkillMenuKind)
      ? (rawKind as SkillMenuKind)
      : VALUE_KIND_INVOKE;

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

/**
 * Build the rename modal — single text input pre-filled with the current name.
 * The view-submission handler revalidates the new name and dispatches to
 * `renameUserSkill`.
 */
export function buildSkillRenameModal(args: { skillName: string; privateMetadata: string }): Record<string, any> {
  return {
    type: 'modal',
    callback_id: USER_SKILL_RENAME_MODAL_CALLBACK_ID,
    private_metadata: args.privateMetadata,
    title: { type: 'plain_text', text: '📝 이름변경'.slice(0, 24) },
    submit: { type: 'plain_text', text: '변경' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `현재 이름: \`$user:${args.skillName}\` — kebab-case (소문자/숫자/하이픈) 만 허용됩니다.`,
          },
        ],
      },
      {
        type: 'input',
        block_id: USER_SKILL_RENAME_BLOCK_ID,
        label: { type: 'plain_text', text: '새 이름' },
        element: {
          type: 'plain_text_input',
          action_id: USER_SKILL_RENAME_ACTION_ID,
          initial_value: args.skillName,
          max_length: MAX_SKILL_NAME_LENGTH,
          placeholder: { type: 'plain_text', text: 'my-new-skill' },
        },
      },
    ],
  };
}

/**
 * Build the delete confirmation modal — body is non-editable, submit acts as
 * "I confirm". 2-step modal because Slack `overflow` options can't carry a
 * per-option `confirm` dialog.
 */
export function buildSkillDeleteModal(args: { skillName: string; privateMetadata: string }): Record<string, any> {
  return {
    type: 'modal',
    callback_id: USER_SKILL_DELETE_MODAL_CALLBACK_ID,
    private_metadata: args.privateMetadata,
    title: { type: 'plain_text', text: '🗑 삭제 확인'.slice(0, 24) },
    submit: { type: 'plain_text', text: '삭제' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `정말 \`$user:${args.skillName}\` 를 삭제할까요?\n\n` +
            '*이 작업은 되돌릴 수 없습니다.* SKILL.md 와 디렉터리 전체가 제거됩니다.',
        },
      },
    ],
  };
}
