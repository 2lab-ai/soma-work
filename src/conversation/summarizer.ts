import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config';
import { ensureValidCredentials } from '../credentials-manager';
import { Logger } from '../logger';

const logger = new Logger('Summarizer');

/**
 * Summary result from the summarizer
 */
export interface SummaryResult {
  title: string; // 1-line title
  body: string; // 3-line summary
}

/**
 * Get the summary model from config (default: claude-haiku-4-20250414)
 */
function getSummaryModel(): string {
  return config.conversation.summaryModel;
}

/**
 * Summarize assistant response into a title and body.
 * Uses Agent SDK (OAuth) — same auth path as all other Claude calls.
 * Returns null on failure (graceful degradation).
 */
export async function summarizeResponse(content: string): Promise<SummaryResult | null> {
  // Validate credentials (shared with all Agent SDK calls)
  const credentialResult = await ensureValidCredentials();
  if (!credentialResult.valid) {
    logger.warn('Credentials invalid, summarization disabled', { error: credentialResult.error });
    return null;
  }

  // Truncate very long content to save tokens
  const maxContentLength = 8000;
  const truncatedContent =
    content.length > maxContentLength ? content.substring(0, maxContentLength) + '\n...[truncated]' : content;

  const prompt = `Summarize this AI assistant response. Output ONLY a JSON object with "title" (1 short line, max 60 chars) and "body" (3 concise lines separated by \\n). No markdown, no code blocks, just raw JSON.

Response to summarize:
${truncatedContent}`;

  const options: Options = {
    model: getSummaryModel(),
    maxTurns: 1,
    tools: [],
    systemPrompt: 'You are a concise summarizer. Output only what is requested.',
    settingSources: [],
    plugins: [],
    stderr: (data: string) => {
      logger.warn('Summarizer stderr', { data: data.trimEnd() });
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

    // Strip markdown code block wrappers (LLMs frequently add them despite instructions)
    let cleanText = assistantText.trim();
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

    logger.warn('Summarizer returned unexpected format', { text: assistantText.substring(0, 200) });
    return null;
  } catch (error) {
    logger.error('Summarization failed', error);
    return null;
  }
}
