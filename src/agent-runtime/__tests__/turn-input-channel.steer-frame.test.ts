/**
 * SSOT 2026-11-06 (dev, this thread): two follow-ups steered into one running
 * turn, "1234" and "123435676", reached the model as "1234123435676" — the CLI
 * hands the messages queued between two tool calls to the model run together,
 * and the agent read the result as noise and ignored both. Every steered
 * message carries its own header line and stands apart, however the CLI joins
 * them.
 */

import { describe, expect, it } from 'vitest';
import { buildSteerUserMessage, STEER_MESSAGE_HEADER } from '../turn-input-channel';

const textOf = (text: string): string => {
  const content = buildSteerUserMessage({ uuid: 'u-1', text }).message.content as unknown as Array<{
    type: string;
    text?: string;
  }>;
  return String(content[0]?.text);
};

describe('a message steered into a running turn reads as its own user message', () => {
  it('carries the header line before the user words, the words unchanged', () => {
    const text = textOf('1234');
    expect(text).toContain(STEER_MESSAGE_HEADER);
    expect(text.indexOf(STEER_MESSAGE_HEADER)).toBeLessThan(text.indexOf('1234'));
    expect(text.trim().endsWith('1234')).toBe(true);
  });

  it('two messages joined with nothing between them stay two messages', () => {
    const joined = textOf('1234') + textOf('123435676');
    expect(joined).not.toContain('1234123435676');
    expect(joined.split(STEER_MESSAGE_HEADER)).toHaveLength(3);
    expect(joined).toMatch(/1234\s*\n\s*\n/);
  });

  it('images still follow the text block', () => {
    const content = buildSteerUserMessage({
      uuid: 'u-2',
      text: '이거 봐',
      images: [{ mediaType: 'image/png', base64: 'AAAA' }],
    }).message.content as unknown as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual(['text', 'image']);
  });
});
