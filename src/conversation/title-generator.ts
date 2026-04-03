import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { Logger } from '../logger';

const logger = new Logger('TitleGenerator');

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set, title generation disabled');
    return null;
  }
  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Generate a concise title for a conversation using the subordinate (codex) model.
 * Returns null on failure (graceful degradation).
 */
export async function generateTitle(conversationContent: string): Promise<string | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const truncated =
    conversationContent.length > 3000
      ? conversationContent.substring(0, 3000) + '\n...[truncated]'
      : conversationContent;

  try {
    const response = await anthropic.messages.create({
      model: config.conversation.summaryModel,
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: `Generate a concise, descriptive Korean title (max 40 chars) for this conversation. Output ONLY the title text, nothing else.\n\nConversation:\n${truncated}`,
        },
      ],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('')
      .replace(/[\r\n]+/g, ' ')
      .trim();

    // Clamp to 40 chars (matching the prompt constraint) to prevent UI overflow
    return text.substring(0, 40) || null;
  } catch (error) {
    logger.error('Title generation failed', error);
    return null;
  }
}
