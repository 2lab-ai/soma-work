import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAdminUser } from '../../admin-utils';
import { DATA_DIR } from '../../env-paths';
import { type EnvSkillRegistry, envSkillRegistry, listEnvSkills } from '../../env-skill-registry';
import { Logger } from '../../logger';
import { isSafePathSegment } from '../../path-utils';
import { type GrantScope, isEnvSkillUseAllowed } from '../../user-skill-grants-store';
import { listUserSkills } from '../../user-skill-store';
import { escapeSlackMrkdwn } from '../mrkdwn-escape';
import type { CommandContext, CommandHandler, CommandResult } from './types';
import { buildOwnSkillListMessage } from './user-skills-list-handler';

/** `skill` / `skills` / `/skill`, optionally followed by `list` or `download`. */
const SKILL_COMMAND = /^\/?skills?(?:\s+(list|download))?$/i;

/** Slack caps a message at 50 blocks: header + context + sections + one "more" note. */
const ENV_SECTION_BUDGET = 47;
/** Description truncation, same as the personal list. */
const DESC_TRUNC_LEN = 200;

export interface SkillListMessage {
  text: string;
  blocks: any[];
}

/**
 * This host's environment skills (skills of its deploy-time environment plugins) as one message.
 *
 * A non-admin sees an environment skill's description only once an admin granted it: until then
 * the skill reads as "🔐 어드민 승인 필요" — the same gate `$plugin:skill` and the model's `Skill`
 * tool apply (`env-skill-registry.ts`). The name is always shown so the user knows what to ask for.
 */
export function buildEnvSkillListMessage(
  userId: string,
  registry: EnvSkillRegistry,
  scope?: GrantScope,
): SkillListMessage {
  const skills = listEnvSkills(registry);
  const header = { type: 'header', text: { type: 'plain_text', text: '🌐 환경 스킬', emoji: true } };

  if (skills.length === 0) {
    const text = 'ℹ️ 이 호스트에는 환경 스킬이 없습니다.';
    return { text, blocks: [header, { type: 'section', text: { type: 'mrkdwn', text } }] };
  }

  const admin = isAdminUser(userId);
  const shown = skills.length > ENV_SECTION_BUDGET + 1 ? skills.slice(0, ENV_SECTION_BUDGET) : skills;
  const blocks: any[] = [
    header,
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `이 호스트의 배포 환경 스킬 ${skills.length}개 — \`$plugin:skill\`로 실행합니다. 🔐 표시는 어드민 승인 후 실행됩니다.`,
        },
      ],
    },
    ...shown.map((s) => {
      const allowed = admin || isEnvSkillUseAllowed(s.key, userId, scope);
      // Truncate before escaping: cutting an escaped string can split an entity (`&amp;` → `&am`).
      const desc = escapeSlackMrkdwn((s.description || '(no description)').substring(0, DESC_TRUNC_LEN));
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: allowed ? `*\`$${s.key}\`*\n${desc}` : `*\`$${s.key}\`* 🔐 어드민 승인 필요` },
      };
    }),
  ];
  if (shown.length < skills.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `⚠️ ${skills.length - shown.length} more environment skills not shown.` }],
    });
  }
  return { text: `🌐 환경 스킬 (${skills.length})`, blocks };
}

/** What `skill` posts, in order: the requester's personal skill list, then the environment skills. */
export function buildSkillListMessages(
  userId: string,
  registry: EnvSkillRegistry,
  scope?: GrantScope,
): [SkillListMessage, SkillListMessage] {
  return [buildOwnSkillListMessage(userId), buildEnvSkillListMessage(userId, registry, scope)];
}

/**
 * `skill` — lists the skills the user can run: their personal skills as the interactive list
 * (same UI as `$user`: run / edit / delete / rename / share), then this host's environment skills.
 *
 *   skill | skills | /skill | skill list   → the two lists
 *   skill download                         → export the personal skills as one markdown message
 */
export class SkillsHandler implements CommandHandler {
  private logger = new Logger('SkillsHandler');

  /** @param envRegistry this host's environment plugins — the plugin manager's in production. */
  constructor(private envRegistry: () => EnvSkillRegistry = () => envSkillRegistry(undefined)) {}

  canHandle(text: string): boolean {
    return SKILL_COMMAND.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const verb = ctx.text.trim().match(SKILL_COMMAND)?.[1]?.toLowerCase();
    if (verb === 'download') return this.handleDownload(ctx);
    return this.handleList(ctx);
  }

  private async handleList(ctx: CommandContext): Promise<CommandResult> {
    const { user, channel, say, threadTs } = ctx;
    for (const message of buildSkillListMessages(user, this.envRegistry(), { channel, threadTs })) {
      await say({ ...message, thread_ts: threadTs });
    }
    return { handled: true };
  }

  private async handleDownload(ctx: CommandContext): Promise<CommandResult> {
    const { user, say, threadTs } = ctx;

    if (!isSafePathSegment(user)) {
      await say({ text: '❌ Invalid user context.', thread_ts: threadTs });
      return { handled: true };
    }

    const skills = listUserSkills(user);
    if (skills.length === 0) {
      await say({ text: '📭 No personal skills to download.', thread_ts: threadTs });
      return { handled: true };
    }

    const skillsDir = path.join(DATA_DIR, user, 'skills');
    const parts: string[] = [];
    for (const skill of skills) {
      const skillFile = path.join(skillsDir, skill.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        parts.push(`# ${skill.name}\n\n${fs.readFileSync(skillFile, 'utf-8')}`);
      }
    }

    await say({
      text: `📦 *Skills Export* (${skills.length} skills)\n\n\`\`\`\n${parts.join('\n\n---\n\n')}\n\`\`\``,
      thread_ts: threadTs,
    });

    this.logger.info('Skills downloaded', { user, count: skills.length });
    return { handled: true };
  }
}
