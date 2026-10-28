import { isAdminUser } from '../../admin-utils';
import { envSkillExists, envSkillRegistry } from '../../env-skill-registry';
import { Logger } from '../../logger';
import type { McpManager } from '../../mcp-manager';
import { getPermissionRequest, markRequestHandled, type PermissionRequest } from '../../skill-permission-request-store';
import { addThreadGrant, ENV_SKILL_GRANT_OWNER, grantAllSkills, grantSkill } from '../../user-skill-grants-store';
import {
  describeRequestPlace,
  VALUE_KIND_ENV_SKILL_ALL,
  VALUE_KIND_ENV_SKILL_ALWAYS,
  VALUE_KIND_ENV_SKILL_DENY,
  VALUE_KIND_ENV_SKILL_ONCE,
} from '../env-skill-permission-blocks';
import type { SlackApiHelper } from '../slack-api-helper';
import type { MessageHandler, RespondFn, SayFn } from './types';

interface EnvSkillPermissionContext {
  slackApi: SlackApiHelper;
  messageHandler: MessageHandler;
  /** Resolves the environment plugins (`plugin.envPlugins`) to check the skill still exists. */
  mcpManager?: Pick<McpManager, 'getPluginManager'>;
}

type EnvPermKind =
  | typeof VALUE_KIND_ENV_SKILL_ONCE
  | typeof VALUE_KIND_ENV_SKILL_ALWAYS
  | typeof VALUE_KIND_ENV_SKILL_ALL
  | typeof VALUE_KIND_ENV_SKILL_DENY;

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  VALUE_KIND_ENV_SKILL_ONCE,
  VALUE_KIND_ENV_SKILL_ALWAYS,
  VALUE_KIND_ENV_SKILL_ALL,
  VALUE_KIND_ENV_SKILL_DENY,
]);

/**
 * Handles the 4 buttons of the environment-skill permission prompt the admins receive:
 *   - ✅ 1회 허용 (이 스레드)    → thread grant, then send the requester's turn again
 *   - 📋 이 스킬 항상 허용        → persist a per-skill grant, then send the turn again
 *   - 🌐 모든 환경 스킬 항상 허용  → persist an all-environment-skills grant, then send the turn again
 *   - ❌ 거부                     → no grant; the requester is told
 *
 * Admin-bound: any admin (ADMIN_USERS) may answer, nobody else. The button carries only a
 * `requestId`; the request is read server-side, so a forged or replayed payload cannot fabricate
 * a grant, and the read and `markRequestHandled` stay in one synchronous span so a second click —
 * the same admin twice, or two admins — finds it handled. The cross-user skill prompt
 * (`SkillPermissionActionHandler`) is the pattern: the owner there is the admins here.
 */
export class EnvSkillPermissionActionHandler {
  private logger = new Logger('EnvSkillPermissionActionHandler');

  constructor(private ctx: EnvSkillPermissionContext) {}

  async handleAction(body: any, respond: RespondFn): Promise<void> {
    try {
      const rawValue: unknown = body?.actions?.[0]?.value;
      if (typeof rawValue !== 'string') {
        this.logger.warn('env_skill_perm: missing action value');
        return;
      }
      let parsed: { kind?: unknown; requestId?: unknown };
      try {
        parsed = JSON.parse(rawValue);
      } catch {
        this.logger.warn('env_skill_perm: malformed value JSON');
        return;
      }
      const kind =
        typeof parsed.kind === 'string' && KNOWN_KINDS.has(parsed.kind) ? (parsed.kind as EnvPermKind) : null;
      const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : '';
      if (!kind || !requestId) {
        this.logger.warn('env_skill_perm: invalid kind/requestId', { kind, requestId });
        return;
      }

      const req = getPermissionRequest(requestId);
      if (!req || req.ownerId !== ENV_SKILL_GRANT_OWNER) {
        await this.ephemeral(respond, '⚠️ 만료되었거나 더 이상 유효하지 않은 환경 스킬 권한 요청입니다.');
        return;
      }

      // Admin-bound.
      const clickerId: string | undefined = body?.user?.id;
      if (!clickerId || !isAdminUser(clickerId)) {
        await this.ephemeral(respond, '⚠️ 환경 스킬 권한 요청은 어드민만 처리할 수 있습니다.');
        return;
      }

      // NOTE: the read above and markRequestHandled below must stay in one synchronous span — an
      // `await` inserted between them reopens the double-click double-grant this guard closes.
      if (req.handled) {
        await this.ephemeral(respond, '⚠️ 이미 처리된 환경 스킬 권한 요청입니다.');
        return;
      }

      if (kind === VALUE_KIND_ENV_SKILL_DENY) {
        markRequestHandled(requestId);
        const label = `🚫 <@${clickerId}>님이 <@${req.requesterId}>님의 환경 스킬 \`${req.skillName}\` 실행 요청을 거부했습니다.`;
        await this.closePrompts(req, respond, label);
        await this.notifyRequester(
          req,
          `🚫 <@${req.requesterId}> — 환경 스킬 \`${req.skillName}\` 실행 요청이 거부되었습니다.`,
        );
        this.logger.info('env_skill_perm: denied', { requestId, admin: clickerId, requesterId: req.requesterId });
        return;
      }

      const registry = envSkillRegistry(this.ctx.mcpManager?.getPluginManager());
      if (!envSkillExists(req.skillName, registry)) {
        markRequestHandled(requestId);
        await this.closePrompts(req, respond, `❌ 환경 스킬 \`${req.skillName}\` 이 더 이상 이 호스트에 없습니다.`);
        return;
      }

      let grantLabel: string;
      switch (kind) {
        case VALUE_KIND_ENV_SKILL_ALL:
          grantAllSkills(ENV_SKILL_GRANT_OWNER, req.requesterId);
          grantLabel = `<@${req.requesterId}>님에게 모든 환경 스킬 실행을 항상 허용했습니다.`;
          break;
        case VALUE_KIND_ENV_SKILL_ALWAYS:
          grantSkill(ENV_SKILL_GRANT_OWNER, req.skillName, req.requesterId);
          grantLabel = `<@${req.requesterId}>님에게 환경 스킬 \`${req.skillName}\` 실행을 항상 허용했습니다.`;
          break;
        default: // VALUE_KIND_ENV_SKILL_ONCE
          addThreadGrant(ENV_SKILL_GRANT_OWNER, req.skillName, req.requesterId, {
            channel: req.channel,
            threadTs: req.threadTs,
          });
          grantLabel =
            `<@${req.requesterId}>님에게 환경 스킬 \`${req.skillName}\` 1회 실행을 허용했습니다 ` +
            `(${describeRequestPlace(req.channel, req.threadTs)}에서만).`;
          break;
      }
      markRequestHandled(requestId);

      await this.closePrompts(req, respond, `✅ <@${clickerId}> — ${grantLabel}`);
      await this.notifyRequester(
        req,
        `✅ <@${req.requesterId}> — 어드민 <@${clickerId}>님이 환경 스킬 \`${req.skillName}\` 실행을 허용했습니다. 이어서 실행합니다.`,
      );
      await this.fulfill(req);
      this.logger.info('env_skill_perm: granted + fulfilled', {
        kind,
        requestId,
        admin: clickerId,
        requesterId: req.requesterId,
        skillKey: req.skillName,
      });
    } catch (error) {
      this.logger.error('env_skill_perm: unexpected error', error);
      try {
        await this.ephemeral(respond, '⚠️ 환경 스킬 권한 처리 중 오류가 발생했습니다.');
      } catch {
        /* best effort */
      }
    }
  }

  /** Send the requester's ask again as them, now that the gate lets it through. */
  private async fulfill(req: PermissionRequest): Promise<void> {
    if (!req.originalText) return;
    await this.ctx.messageHandler(
      { user: req.requesterId, channel: req.channel, thread_ts: req.threadTs, ts: '', text: req.originalText },
      this.createSayFn(req.channel),
    );
  }

  /**
   * Replace the clicked prompt (via `respond`) and every other admin's copy (via `chat.update`) with
   * the outcome, so no stale buttons are left in anyone's DMs.
   */
  private async closePrompts(req: PermissionRequest, respond: RespondFn, text: string): Promise<void> {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }];
    await respond({ response_type: 'in_channel', replace_original: true, text, blocks });
    for (const prompt of req.prompts ?? []) {
      await this.ctx.slackApi
        .updateMessage(prompt.channel, prompt.ts, text, blocks, [])
        .catch((err: unknown) =>
          this.logger.warn('env_skill_perm: prompt close failed', { err: (err as Error)?.message ?? String(err) }),
        );
    }
  }

  private async notifyRequester(req: PermissionRequest, text: string): Promise<void> {
    if (!req.channel) return;
    await this.ctx.slackApi
      .postMessage(req.channel, text, { threadTs: req.threadTs })
      .catch((err: unknown) =>
        this.logger.warn('env_skill_perm: requester notify failed', { err: (err as Error)?.message ?? String(err) }),
      );
  }

  private async ephemeral(respond: RespondFn, text: string): Promise<void> {
    await respond({ response_type: 'ephemeral', replace_original: false, text });
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
