/**
 * Markdown-to-Slack Block Kit converter
 *
 * Converts markdown text to Slack Block Kit blocks using rich_text, table, and header blocks.
 * Uses markdown-to-slack-blocks library wrapped behind a stable interface.
 *
 * Block types produced:
 * - header: H1/H2 headings
 * - rich_text: paragraphs, code blocks (preformatted), quotes, lists with inline formatting
 * - table: GFM tables with rich_text cells
 * - section: plain paragraphs with mrkdwn
 *
 * Constraints enforced:
 * - Max 45 blocks per message (Slack limit: 50, leaving room for header/footer)
 * - Max 1 table per message (Slack constraint)
 * - Max 100 rows per table, max 20 columns
 * - Fallback to plain text on conversion failure
 */

import { markdownToBlocks as libMarkdownToBlocks } from 'markdown-to-slack-blocks';
import { Logger } from '../../logger';
import { MessageFormatter } from '../message-formatter';

const logger = new Logger('MarkdownToBlocks');

/**
 * Maximum blocks per Slack message.
 * Slack limit is 50; we reserve 5 for header/footer blocks that may be added
 * by the stream processor (vtag, action panel, etc).
 */
const MAX_BLOCKS_PER_MESSAGE = 45;

/** Maximum characters for header block text (Slack limit) */
const MAX_HEADER_TEXT = 150;

/** Maximum rows per table block */
const MAX_TABLE_ROWS = 100;

/** Maximum columns per table block */
const MAX_TABLE_COLUMNS = 20;

export interface SlackBlock {
  type: string;
  [key: string]: any;
}

export interface ConvertResult {
  /** Block Kit blocks for the message */
  blocks: SlackBlock[];
  /** Plain text fallback (always provided) */
  fallbackText: string;
  /** Additional messages if content exceeds single message limit */
  overflow: SlackBlock[][];
}

/**
 * Convert markdown text to Slack Block Kit blocks.
 *
 * Returns blocks for use with context.say({ text, blocks }).
 * Always provides fallbackText for clients that don't support blocks.
 * Splits into overflow messages if content exceeds 45-block limit.
 */
export function markdownToBlocks(markdown: string): ConvertResult {
  const fallbackText = markdownToMrkdwn(markdown);

  try {
    const rawBlocks = libMarkdownToBlocks(markdown) as SlackBlock[];

    if (!rawBlocks || rawBlocks.length === 0) {
      return { blocks: [], fallbackText, overflow: [] };
    }

    const sanitized = sanitizeBlocks(rawBlocks);
    const { primary, overflow } = splitMessages(sanitized);

    return { blocks: primary, fallbackText, overflow };
  } catch (error) {
    logger.warn('Markdown-to-blocks conversion failed, using fallback', { error });
    return { blocks: [], fallbackText, overflow: [] };
  }
}

/**
 * Build rich_text_quote blocks for thinking output.
 *
 * Wraps thinking text in a rich_text block with rich_text_quote sub-element.
 */
export function thinkingToQuoteBlock(thinkingText: string): SlackBlock {
  return {
    type: 'rich_text',
    elements: [
      {
        type: 'rich_text_quote',
        elements: [
          {
            type: 'emoji',
            name: 'thought_balloon',
          },
          {
            type: 'text',
            text: ` ${thinkingText}`,
            style: { italic: true },
          },
        ],
      },
    ],
  };
}

/**
 * Sanitize blocks to comply with Slack constraints.
 * - Truncate tables exceeding row/column limits
 * - Remove invalid block structures
 */
function sanitizeBlocks(blocks: SlackBlock[]): SlackBlock[] {
  return blocks.map((block) => {
    if (block.type === 'table') {
      return sanitizeTable(block);
    }
    if (block.type === 'header') {
      return sanitizeHeader(block);
    }
    return block;
  });
}

/**
 * Ensure table block stays within Slack limits (rows, columns, column_settings).
 */
function sanitizeTable(block: SlackBlock): SlackBlock {
  const rows = block.rows as any[][];
  if (!rows || rows.length === 0) return block;

  const truncatedRows = rows.slice(0, MAX_TABLE_ROWS);
  const truncatedCols = truncatedRows.map((row) => row.slice(0, MAX_TABLE_COLUMNS));

  return {
    ...block,
    rows: truncatedCols,
    ...(block.column_settings ? { column_settings: block.column_settings.slice(0, MAX_TABLE_COLUMNS) } : {}),
  };
}

/**
 * Ensure header block text stays within 150 char limit.
 */
function sanitizeHeader(block: SlackBlock): SlackBlock {
  const text = block.text?.text || '';
  if (text.length <= MAX_HEADER_TEXT) return block;

  return {
    ...block,
    text: {
      ...block.text,
      text: text.slice(0, MAX_HEADER_TEXT - 3) + '...',
    },
  };
}

/**
 * Split blocks into multiple messages if needed.
 * Rules:
 * - Primary message: up to MAX_BLOCKS_PER_MESSAGE blocks
 * - Each table must be in its own message (1 table per message limit)
 * - Overflow messages contain remaining blocks
 */
function splitMessages(blocks: SlackBlock[]): {
  primary: SlackBlock[];
  overflow: SlackBlock[][];
} {
  if (blocks.length <= MAX_BLOCKS_PER_MESSAGE && countTables(blocks) <= 1) {
    return { primary: blocks, overflow: [] };
  }

  const messages: SlackBlock[][] = [];
  let current: SlackBlock[] = [];
  let currentTableCount = 0;

  for (const block of blocks) {
    const isTable = block.type === 'table';

    // If adding this block would exceed limits, start new message
    const wouldExceedBlocks = current.length >= MAX_BLOCKS_PER_MESSAGE;
    const wouldExceedTables = isTable && currentTableCount >= 1;

    if (wouldExceedBlocks || wouldExceedTables) {
      if (current.length > 0) {
        messages.push(current);
      }
      current = [];
      currentTableCount = 0;
    }

    current.push(block);
    if (isTable) {
      currentTableCount++;
    }
  }

  if (current.length > 0) {
    messages.push(current);
  }

  const [primary, ...overflow] = messages;
  return { primary: primary || [], overflow };
}

function countTables(blocks: SlackBlock[]): number {
  return blocks.filter((b) => b.type === 'table').length;
}

/**
 * Generate fallback text using existing MessageFormatter mrkdwn conversion.
 */
function markdownToMrkdwn(text: string): string {
  return MessageFormatter.formatMessage(text, false);
}
