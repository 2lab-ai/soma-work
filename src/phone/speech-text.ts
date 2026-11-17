/**
 * Text on its way to speech: the reply streams in token by token, and the phone should start talking at the
 * end of the first sentence instead of waiting for the whole reply (.prd/31-phone-calls-architecture.md §3).
 *
 * The split rule follows the voice service's own voice chat (sentence marks once a sentence has a few
 * characters; a comma once it runs long), so a sentence sounds the same here as in the browser.
 */

const SENTENCE_END = /[.!?…。！？\n]/;
const MIN_SENTENCE_CHARS = 6;
const LONG_SENTENCE_CHARS = 120;

export class SentenceSplitter {
  private buffer = '';

  /** Add a piece of streamed text; returns every sentence it completed. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      const length = i + 1 - start;
      const atEnd = SENTENCE_END.test(ch) && length >= MIN_SENTENCE_CHARS;
      const atComma = (ch === ',' || ch === '，') && length > LONG_SENTENCE_CHARS;
      if (!atEnd && !atComma) continue;
      // Keep runs of closing marks ("?!", "...") with the sentence they end.
      let end = i + 1;
      while (end < this.buffer.length && SENTENCE_END.test(this.buffer[end]) && this.buffer[end] !== '\n') end++;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence) out.push(sentence);
      start = end;
      i = end - 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** The rest of the reply once the model stopped. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

/**
 * What a voice can say: markdown marks, links, emoji and stage directions removed. The original text stays in the
 * transcript; only the spoken copy is cleaned.
 */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A pause the model asked for with "(…)" or "[…]" stage directions is not spoken. */
export function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
