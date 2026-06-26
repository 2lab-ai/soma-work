import type { WebClient } from '@slack/web-api';
import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { getPermissionRequest, markRequestHandled, type PermissionRequest } from '../../skill-permission-request-store';
import { addOneTimeGrant, consumeOneTimeGrant, grantAllSkills, grantSkill } from '../../user-skill-grants-store';
import { copyUserSkill, getUserSkill, userSkillExists } from '../../user-skill-store';
import {
  VALUE_KIND_PERM_ALLOW_ALL,
  VALUE_KIND_PERM_ALLOW_SKILL,
  VALUE_KIND_PERM_YES_ONCE,
} from '../skill-permission-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface SkillPermissionContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

type PermKind = typeof VALUE_KIND_PERM_YES_ONCE | typeof VALUE_KIND_PERM_ALLOW_SKILL | typeof VALUE_KIND_PERM_ALLOW_ALL;

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  VALUE_KIND_PERM_YES_ONCE,
  VALUE_KIND_PERM_ALLOW_SKILL,
  VALUE_KIND_PERM_ALLOW_ALL,
]);

/**
 * Handles the 3 buttons of the cross-user skill permission prompt (Q2):
 *   - 네 (1회 허용)       → one-time grant, then fulfill once
 *   - 이 스킬 항상 허용    → persist per-skill grant, then fulfill
 *   - 모든 스킬 허용       → persist all-skills grant, then fulfill
 *
 * Owner-bound: only the skill owner (B) may grant. The authoritative request
 * data is read server-side by `requestId` (the button carries nothing else), so
 * a forged/replayed payload cannot fabricate a grant. Once handled, the request
 * is marked to prevent replay.
 */
export class SkillPermissionActionHandler {
  private logger = new Logger('SkillPermissionActionHandler');

  constructor(private ctx: SkillPermissionContext) {}

  async handleAction(body: any, respond: RespondFn, client?: WebClient): Promise<void> {
    try {
      const action = body?.actions?.[0];
      const rawValue: unknown =
        typeof action?.selected_option?.value === 'string'
          ? action.selected_option.value
          : typeof action?.value === 'string'
            ? action.value
            : null;
      if (typeof rawValue !== 'string') {
        this.logger.warn('skill_perm: missing action value');
        return;
      }

      let parsed: { kind?: unknown; requestId?: unknown };
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        this.logger.warn('skill_perm: malformed value JSON');
        return;
      }
      const kind = typeof parsed.kind === 'string' && KNOWN_KINDS.has(parsed.kind) ? (parsed.kind as PermKind) : null;
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : '';
      if (!kind || !requestId) {
        this.logger.warn('skill_perm: invalid kind/requestId', { kind, requestId });
        return;
      }

      const req = getPermissionRequest(requestId);
      if (!req) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ 만료되었거나 더 이상 유효하지 않은 권한 요청입니다.',
          replace_original: false,
        });
        return;
      }

      // Owner-bound: only B (the skill owner) may grant.
      const clickerId: string | undefined = body?.user?.id;
      if (!clickerId || clickerId !== req.ownerId) {
        await respond({
          response_type: 'ephemeral',
          text: `⚠️ 이 권한 요청은 스킬 소유자 <@${req.ownerId}>님만 처리할 수 있습니다.`,
          replace_original: false,
        });
        return;
      }

      if (req.handled) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ 이미 처리된 권한 요청입니다.',
          replace_original: false,
        });
        return;
      }

      // Skill must still exist before granting/fulfilling.
      if (!userSkillExists(req.ownerId, req.skillName)) {
        markRequestHandled(requestId);
        await respond({
          response_type: 'ephemeral',
          text: `❌ \`$user:${req.skillName}\` 스킬이 더 이상 존재하지 않습니다.`,
          replace_original: false,
        });
        return;
      }

      // Apply the grant.
      let grantLabel: string;
      switch (kind) {
        case VALUE_KIND_PERM_ALLOW_ALL:
          grantAllSkills(req.ownerId, req.requesterId);
          grantLabel = `<@${req.requesterId}>님에게 모든 스킬 사용을 허용했습니다.`;
          break;
        case VALUE_KIND_PERM_ALLOW_SKILL:
          grantSkill(req.ownerId, req.skillName, req.requesterId);
          grantLabel = `<@${req.requesterId}>님을 \`${req.skillName}\` 허용 리스트에 추가했습니다.`;
          break;
        default: // VALUE_KIND_PERM_YES_ONCE
          addOneTimeGrant(req.ownerId, req.skillName, req.requesterId);
          grantLabel = `<@${req.requesterId}>님에게 \`${req.skillName}\` 1회 사용을 허용했습니다.`;
          break;
      }
      markRequestHandled(requestId);

      // Replace the prompt with a confirmation (buttons removed).
      await respond({
        response_type: 'in_channel',
        replace_original: true,
        text: `✅ ${grantLabel}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✅ ${grantLabel}` } }],
      });

      await this.fulfill(req);
      this.logger.info('skill_perm: granted + fulfilled', {
        kind,
        operation: req.operation,
        ownerId: req.ownerId,
        requesterId: req.requesterId,
        skillName: req.skillName,
      });
    } catch (error) {
      this.logger.error('skill_perm: unexpected error', error);
      try {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ 권한 처리 중 오류가 발생했습니다.',
          replace_original: false,
        });
      } catch {
        /* best effort */
      }
    }
  }

  /**
   * Fulfill the originally-requested operation now that permission is granted.
   *   - invoke → re-dispatch A's original message (re-runs the now-allowed gate)
   *   - view   → post the SKILL.md content into the thread
   *   - copy   → install the copy into A's set + confirm
   */
  private async fulfill(req: PermissionRequest): Promise<void> {
    const say = this.createSayFn(req.channel);

    if (req.operation === 'invoke' && req.originalText) {
      await this.ctx.messageHandler(
        {
          user: req.requesterId,
          channel: req.channel,
          thread_ts: req.threadTs,
          ts: '',
          text: req.originalText,
        },
        say,
      );
      return;
    }

    if (req.operation === 'view') {
      // Strict single-use: a one-time grant for this view is spent here.
      consumeOneTimeGrant(req.ownerId, req.skillName, req.requesterId);
      const detail = getUserSkill(req.ownerId, req.skillName);
      if (!detail) return;
      await say({
        text:
          `👀 <@${req.requesterId}> — <@${req.ownerId}>님이 \`${req.skillName}\` 보기를 허용했습니다.\n` +
          '```\n' +
          detail.content.slice(0, 2500) +
          '\n```',
        thread_ts: req.threadTs,
      });
      return;
    }

    if (req.operation === 'copy') {
      // Strict single-use: a one-time grant for this copy is spent here.
      consumeOneTimeGrant(req.ownerId, req.skillName, req.requesterId);
      const result = copyUserSkill(req.ownerId, req.skillName, req.requesterId);
      await say({
        text: result.ok
          ? `📋 <@${req.requesterId}> — \`$user:${req.skillName}\` 를 내 스킬로 복사했습니다.`
          : `❌ 복사 실패: ${result.message}`,
        thread_ts: req.threadTs,
      });
    }
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
