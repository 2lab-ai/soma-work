import type { ClaudeHandler } from '../../claude-handler';
import { Logger } from '../../logger';
import { listUserSkills } from '../../user-skill-store';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface UserSkillInvokeContext {
  slackApi: SlackApiHelper;
  claudeHandler: ClaudeHandler;
  messageHandler: MessageHandler;
}

/** Same kebab-case pattern enforced by `user-skill-store.ts`. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Handles clicks on the buttons rendered by {@link UserSkillsListHandler}.
 *
 * Click → requester guard → stale-skill guard → replace buttons → re-inject
 * `$user:{name}` as a synthetic user message via `messageHandler`. The
 * synthetic message re-enters `CommandRouter.route()`, hits
 * `SkillForceHandler` for `$user:{name}`, and the SKILL.md is resolved into
 * an `<invoked_skills>` block exactly like a typed `$user:{name}`.
 */
export class UserSkillInvokeActionHandler {
  private logger = new Logger('UserSkillInvokeActionHandler');

  constructor(private ctx: UserSkillInvokeContext) {}

  async handleInvoke(body: any, respond: RespondFn): Promise<void> {
    try {
      const action = body?.actions?.[0];
      if (!action || typeof action.value !== 'string') {
        this.logger.warn('user_skill_invoke: missing action payload');
        return;
      }

      let value: { skillName?: unknown; requesterId?: unknown };
      try {
        value = JSON.parse(action.value);
      } catch (parseError) {
        this.logger.warn('user_skill_invoke: malformed JSON value', {
          error: (parseError as Error)?.message,
        });
        return;
      }

      const skillName = typeof value.skillName === 'string' ? value.skillName : '';
      const requesterId = typeof value.requesterId === 'string' ? value.requesterId : '';
      const clickerId: string | undefined = body?.user?.id;
      const channel: string | undefined = body?.channel?.id;
      const messageTs: string | undefined = body?.message?.ts;
      const threadTs: string | undefined = body?.message?.thread_ts || messageTs;

      // Defense: skill name must match the kebab-case pattern even though our
      // own button supplied it (untrusted serialized payload).
      if (!skillName || !SKILL_NAME_PATTERN.test(skillName)) {
        this.logger.warn('user_skill_invoke: invalid skillName', { skillName });
        return;
      }

      // Requester binding — only the user who typed `$user` may consume the
      // menu. Other clickers get an ephemeral notice and the menu stays live.
      if (!requesterId || !clickerId || clickerId !== requesterId) {
        this.logger.info('user_skill_invoke: clicker !== requester (ephemeral reject)', {
          requesterId,
          clickerId,
        });
        await respond({
          response_type: 'ephemeral',
          text: requesterId
            ? `⚠️ 이 메뉴는 <@${requesterId}>님 전용입니다.`
            : '⚠️ 이 메뉴의 소유자 정보가 누락되었습니다.',
          replace_original: false,
        });
        return;
      }

      if (!channel) {
        this.logger.warn('user_skill_invoke: missing channel id', { requesterId, skillName });
        return;
      }

      // Stale-skill guard — if the skill was deleted/renamed via MANAGE_SKILL
      // between menu render and click, fail closed and tell the user.
      const skills = listUserSkills(requesterId);
      const exists = skills.some((s) => s.name === skillName);
      if (!exists) {
        this.logger.info('user_skill_invoke: stale click — skill no longer exists', {
          requesterId,
          skillName,
        });
        await respond({
          response_type: 'ephemeral',
          text: `❌ 스킬이 더 이상 존재하지 않습니다: \`$user:${skillName}\``,
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
              text: `✅ *Personal skill 발동:* \`$user:${skillName}\``,
            },
          },
        ];
        await this.ctx.slackApi
          .updateMessage(channel, messageTs, `✅ $user:${skillName}`, completedBlocks, [])
          .catch((err: unknown) =>
            this.logger.warn('user_skill_invoke: updateMessage failed', {
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
          user: requesterId,
          channel,
          thread_ts: threadTs,
          ts: messageTs ?? '',
          text: `$user:${skillName}`,
        },
        say,
      );

      this.logger.info('user_skill_invoke: dispatched', { requesterId, skillName });
    } catch (error) {
      this.logger.error('Error processing user skill invoke', error);
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
