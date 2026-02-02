import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '../logger';
import { config } from '../config';

const logger = new Logger('Summarizer');

/**
 * Summary result from the summarizer
 */
export interface SummaryResult {
  title: string;    // 1-line title
  body: string;     // 3-line summary
}

// Cache the Anthropic client
let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set, summarization disabled');
    return null;
  }

  client = new Anthropic({ apiKey });
  return client;
}

/**
 * Get the summary model from config (default: claude-haiku-4-20250414)
 */
function getSummaryModel(): string {
  return config.conversation.summaryModel;
}

/**
 * Summarize assistant response into a title and body.
 * Returns null on failure (graceful degradation).
 */
export async function summarizeResponse(content: string): Promise<SummaryResult | null> {
  const anthropic = getClient();
  if (!anthropic) {
    return null;
  }

  // Truncate very long content to save tokens
  const maxContentLength = 8000;
  const truncatedContent = content.length > maxContentLength
    ? content.substring(0, maxContentLength) + '\n...[truncated]'
    : content;

  try {
    const model = getSummaryModel();
    const response = await anthropic.messages.create({
      model,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize this AI assistant response. Output ONLY a JSON object with "title" (1 short line, max 60 chars) and "body" (3 concise lines separated by \\n). No markdown, no code blocks, just raw JSON.

Response to summarize:
${truncatedContent}`,
        },
      ],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    // Strip markdown code block wrappers (LLMs frequently add them despite instructions)
    let cleanText = text.trim();
    if (cleanText.startsWith('```')) {
      cleanText = cleanText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Parse JSON response
    const parsed = JSON.parse(cleanText);
    if (parsed.title && parsed.body) {
      return {
        title: String(parsed.title).substring(0, 100),
        body: String(parsed.body).substring(0, 500),
      };
    }

    logger.warn('Summarizer returned unexpected format', { text: text.substring(0, 200) });
    return null;
  } catch (error) {
    logger.error('Summarization failed', error);
    return null;
  }
}
