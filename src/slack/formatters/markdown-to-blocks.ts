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
 * - Max 3000 chars per section text / rich_text text element
 * - Max ~35KB payload per message (Slack undocumented ~40KB limit)
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

/** Maximum characters for section block text (Slack limit: 3000) */
const MAX_SECTION_TEXT = 3000;

/**
 * Maximum estimated payload size per message in bytes.
 * Slack's undocumented limit is ~40KB for blocks payload.
 * We use 35KB as a safe threshold to leave room for metadata.
 */
const MAX_PAYLOAD_BYTES = 35_000;

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
 * - Truncate section text exceeding 3000 chars
 * - Truncate rich_text element text lengths
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
    if (block.type === 'section') {
      return sanitizeSection(block);
    }
    if (block.type === 'rich_text') {
      return sanitizeRichText(block);
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
 * Ensure section block text stays within 3000 char limit.
 */
function sanitizeSection(block: SlackBlock): SlackBlock {
  const text = block.text?.text || '';
  if (text.length <= MAX_SECTION_TEXT) return block;

  return {
    ...block,
    text: {
      ...block.text,
      text: text.slice(0, MAX_SECTION_TEXT - 3) + '...',
    },
  };
}

/**
 * Truncate text elements in rich_text blocks to prevent oversized payloads.
 * Walks all nested elements and caps text at 3000 chars per element.
 */
function sanitizeRichText(block: SlackBlock): SlackBlock {
  if (!block.elements || !Array.isArray(block.elements)) return block;

  return {
    ...block,
    elements: block.elements.map((subElement: any) => truncateRichTextElement(subElement)),
  };
}

function truncateRichTextElement(element: any): any {
  if (!element) return element;

  // Leaf text element — cap at 3000 chars
  if (element.type === 'text' && typeof element.text === 'string' && element.text.length > MAX_SECTION_TEXT) {
    return { ...element, text: element.text.slice(0, MAX_SECTION_TEXT - 3) + '...' };
  }

  // Container elements (rich_text_section, rich_text_preformatted, rich_text_quote, rich_text_list)
  if (element.elements && Array.isArray(element.elements)) {
    return { ...element, elements: element.elements.map((child: any) => truncateRichTextElement(child)) };
  }

  return element;
}

/**
 * Estimate the JSON payload size of a blocks array in bytes.
 * Uses a fast approximation — exact JSON.stringify is too expensive for hot paths.
 */
export function estimatePayloadSize(blocks: SlackBlock[]): number {
  // JSON.stringify is accurate but acceptable here since it only runs once per message
  try {
    return new TextEncoder().encode(JSON.stringify(blocks)).byteLength;
  } catch {
    // Fallback: rough estimate
    return blocks.length * 500;
  }
}

/**
 * Split blocks into multiple messages if needed.
 * Rules:
 * - Primary message: up to MAX_BLOCKS_PER_MESSAGE blocks
 * - Each table must be in its own message (1 table per message limit)
 * - Each message must stay under MAX_PAYLOAD_BYTES (~35KB)
 * - Overflow messages contain remaining blocks
 */
function splitMessages(blocks: SlackBlock[]): {
  primary: SlackBlock[];
  overflow: SlackBlock[][];
} {
  if (
    blocks.length <= MAX_BLOCKS_PER_MESSAGE &&
    countTables(blocks) <= 1 &&
    estimatePayloadSize(blocks) <= MAX_PAYLOAD_BYTES
  ) {
    return { primary: blocks, overflow: [] };
  }

  const messages: SlackBlock[][] = [];
  let current: SlackBlock[] = [];
  let currentTableCount = 0;
  let currentSize = 0;

  for (const block of blocks) {
    const isTable = block.type === 'table';
    const blockSize = estimatePayloadSize([block]);

    // If adding this block would exceed any limit, start new message
    const wouldExceedBlocks = current.length >= MAX_BLOCKS_PER_MESSAGE;
    const wouldExceedTables = isTable && currentTableCount >= 1;
    const wouldExceedSize = current.length > 0 && currentSize + blockSize > MAX_PAYLOAD_BYTES;

    if (wouldExceedBlocks || wouldExceedTables || wouldExceedSize) {
      if (current.length > 0) {
        messages.push(current);
      }
      current = [];
      currentTableCount = 0;
      currentSize = 0;
    }

    current.push(block);
    currentSize += blockSize;
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
