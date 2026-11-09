import { buildOneShotOptions, runOneShotText } from '../agent-runtime';
import { buildQueryEnv } from '../auth/query-env-builder';
import { userTenantKey } from '../auth/user-tenant-key';
import { config } from '../config';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from '../credentials-manager';
import { Logger } from '../logger';
import { getTokenManager } from '../token-manager';

const logger = new Logger('TitleGenerator');

/**
 * Generate a concise title for a conversation.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 *
 * `tenantUserId` = the user whose conversation it is: in llmux mode the call
 * carries their own key (metered under their tenant); absent → the shared key.
 */
export async function generateTitle(
  conversationContent: string,
  opts: { tenantUserId?: string } = {},
): Promise<string | null> {
  let lease: SlotAuthLease | null = null;
  try {
    try {
      lease = await ensureActiveSlotAuth(getTokenManager(), 'title-generator');
    } catch (credErr) {
      if (credErr instanceof NoHealthySlotError) {
        logger.warn('Credentials invalid, title generation disabled', { error: credErr.message });
        return null;
      }
      throw credErr;
    }

    const truncated =
      conversationContent.length > 3000
        ? `${conversationContent.substring(0, 3000)}\n...[truncated]`
        : conversationContent;

    const prompt = `Generate a concise, descriptive Korean title (max 40 chars) for this conversation. Output ONLY the title text, nothing else.\n\nConversation:\n${truncated}`;

    // Use options.env (not process.env) so concurrent leases don't
    // clobber the shared CLAUDE_CODE_OAUTH_TOKEN.
    const { env } = buildQueryEnv(lease, { llmuxTenant: await userTenantKey(opts.tenantUserId) });
    const options = buildOneShotOptions({
      model: config.conversation.summaryModel,
      systemPrompt: 'You generate concise conversation titles. Output only the title text.',
      env,
      logger,
      stderrLabel: 'TitleGenerator',
    });

    try {
      const assistantText = await runOneShotText(prompt, options);

      const text = assistantText.replace(/[\r\n]+/g, ' ').trim();

      // Clamp to 40 chars (matching the prompt constraint) to prevent UI overflow
      return text.substring(0, 40) || null;
    } catch (error) {
      logger.error('Title generation failed', error);
      return null;
    }
  } finally {
    if (lease) await lease.release();
  }
}
