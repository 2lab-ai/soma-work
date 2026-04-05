import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config';
import { ensureValidCredentials } from '../credentials-manager';
import { Logger } from '../logger';

const logger = new Logger('TitleGenerator');

/**
 * Generate a concise title for a conversation.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 */
export async function generateTitle(conversationContent: string): Promise<string | null> {
  // Validate credentials (shared with all Agent SDK calls)
  const credentialResult = await ensureValidCredentials();
  if (!credentialResult.valid) {
    logger.warn('Credentials invalid, title generation disabled', { error: credentialResult.error });
    return null;
  }

  const truncated =
    conversationContent.length > 3000
      ? `${conversationContent.substring(0, 3000)}\n...[truncated]`
      : conversationContent;

  const prompt = `Generate a concise, descriptive Korean title (max 40 chars) for this conversation. Output ONLY the title text, nothing else.\n\nConversation:\n${truncated}`;

  const options: Options = {
    model: config.conversation.summaryModel,
    maxTurns: 1,
    tools: [],
    systemPrompt: 'You generate concise conversation titles. Output only the title text.',
    settingSources: [],
    plugins: [],
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
}
