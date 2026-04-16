import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from '../../env-paths';
import { Logger } from '../../logger';
import { isSafePathSegment } from '../../path-utils';
import { listUserSkills } from '../../user-skill-store';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles user personal skill management commands:
 *   skills list     → list all personal skills
 *   skills download → send all personal skills as individual files
 */
export class SkillsHandler implements CommandHandler {
  private logger = new Logger('SkillsHandler');

  canHandle(text: string): boolean {
    return /^skills?\s+(list|download)/i.test(text.trim());
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { text, user, say, threadTs } = ctx;
    const trimmed = text.trim().toLowerCase();

    if (trimmed.startsWith('skills list') || trimmed.startsWith('skill list')) {
      return this.handleList(ctx);
    }
    if (trimmed.startsWith('skills download') || trimmed.startsWith('skill download')) {
      return this.handleDownload(ctx);
    }

    return { handled: false };
  }

  private async handleList(ctx: CommandContext): Promise<CommandResult> {
    const { user, say, threadTs } = ctx;
    const skills = listUserSkills(user);

    if (skills.length === 0) {
      await say({
        text: '📭 No personal skills found. Use `MANAGE_SKILL` command to create one.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    const list = skills
      .map((s, i) => `${i + 1}. \`$user:${s.name}\` — ${s.description || '(no description)'}`)
      .join('\n');

    await say({
      text: `🎯 *Your Personal Skills* (${skills.length})\n\n${list}\n\nInvoke with \`$user:skill-name\` or manage with \`MANAGE_SKILL\` command.`,
      thread_ts: threadTs,
    });
    return { handled: true };
  }

  private async handleDownload(ctx: CommandContext): Promise<CommandResult> {
    const { user, say, threadTs } = ctx;

    if (!isSafePathSegment(user)) {
      await say({ text: '❌ Invalid user context.', thread_ts: threadTs });
      return { handled: true };
    }

    const skillsDir = path.join(DATA_DIR, user, 'skills');
    if (!fs.existsSync(skillsDir)) {
      await say({ text: '📭 No personal skills to download.', thread_ts: threadTs });
      return { handled: true };
    }

    const skills = listUserSkills(user);
    if (skills.length === 0) {
      await say({ text: '📭 No personal skills to download.', thread_ts: threadTs });
      return { handled: true };
    }

    // Collect all skill files into a single markdown document for download
    const parts: string[] = [];
    for (const skill of skills) {
      const skillFile = path.join(skillsDir, skill.name, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf-8');
        parts.push(`# ${skill.name}\n\n${content}`);
      }
    }

    const combined = parts.join('\n\n---\n\n');
    await say({
      text: `📦 *Skills Export* (${skills.length} skills)\n\n\`\`\`\n${combined}\n\`\`\``,
      thread_ts: threadTs,
    });

    this.logger.info('Skills downloaded', { user, count: skills.length });
    return { handled: true };
  }
}
