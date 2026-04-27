import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { buildQueryEnv } from '../auth/query-env-builder';
import { config } from '../config';
import { ensureActiveSlotAuth, NoHealthySlotError, type SlotAuthLease } from '../credentials-manager';
import { Logger } from '../logger';
import { getTokenManager } from '../token-manager';

const logger = new Logger('TitleGenerator');

/**
 * Generate a concise title for a conversation.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 */
export async function generateTitle(conversationContent: string): Promise<string | null> {
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

    // Pass the fresh lease token via options.env (built by `buildQueryEnv`)
    // so concurrent spawns each see their own token — mutating
    // `process.env.CLAUDE_CODE_OAUTH_TOKEN` globally would race against
    // other in-flight dispatches holding leases on different slots.
    const { env } = buildQueryEnv(lease);
    const options: Options = {
      model: config.conversation.summaryModel,
      maxTurns: 1,
      tools: [],
      systemPrompt: 'You generate concise conversation titles. Output only the title text.',
      settingSources: [],
      plugins: [],
      env,
      // Adaptive thinking on Haiku/Sonnet 4.5 silently consumes the entire
      // output budget on these tiny prompts, leaving an empty response that
      // truncates the title text to "". Disable thinking — title generation
      // is a 1-shot text task where reasoning is unnecessary. (#762)
      thinking: { type: 'disabled' },
      stderr: (data: string) => {
        logger.warn('TitleGenerator stderr', { data: data.trimEnd() });
      },
    };

    try {
      let assistantText = '';

      for await (const message of query({ prompt, options })) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              assistantText += block.text;
            }
          }
        }
      }

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
