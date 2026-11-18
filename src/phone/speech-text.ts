/**
 * Text on its way to speech: the reply streams in token by token, and the phone should start talking at the
 * end of the first sentence instead of waiting for the whole reply (.prd/31-phone-calls-architecture.md §3).
 *
 * The split rule follows the voice service's own voice chat (sentence marks once a sentence has a few
 * characters; a comma once it runs long), so a sentence sounds the same here as in the browser. One exception for
 * the phone: a turn's first chunk may end at a comma once it holds a clause, so the voice starts while the model is
 * still writing the rest of the sentence (first audio is what a caller waits for).
 */

const SENTENCE_END = /[.!?…。！？\n]/;
const MIN_SENTENCE_CHARS = 6;
const LONG_SENTENCE_CHARS = 120;
/**
 * A turn's first chunk may end at a comma followed by a space, from this many characters on ("네," is no clause;
 * "123,456" is one number).
 */
const FIRST_CLAUSE_CHARS = 10;

export class SentenceSplitter {
  private buffer = '';
  /** Nothing of this turn released yet: the first chunk may end at a clause. */
  private turnStart = true;

  /** Add a piece of streamed text; returns every sentence it completed. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      const length = i + 1 - start;
      // "1.5배" is one number: a point between digits ends nothing. With nothing after it yet, the next piece decides.
      const decimal = ch === '.' && /\d/.test(this.buffer[i - 1] ?? '') && /^\d?$/.test(this.buffer[i + 1] ?? '');
      const atEnd = SENTENCE_END.test(ch) && length >= MIN_SENTENCE_CHARS && !decimal;
      const comma = ch === ',' || ch === '，';
      // A clause ends at a comma with a space after it; "123,456원" has none. The next character may not have
      // arrived yet: then the comma waits for the next piece.
      const clause =
        this.turnStart && out.length === 0 && length >= FIRST_CLAUSE_CHARS && /\s/.test(this.buffer[i + 1] ?? '');
      const atComma = comma && (length > LONG_SENTENCE_CHARS || clause);
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
    if (out.length) this.turnStart = false;
    return out;
  }

  /** The rest of the reply once the model stopped; the next push starts a new turn. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    this.turnStart = true;
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

/**
 * A reply's opening acknowledgment ("네,", "네네.", "아, 네.", "음…") taken off — said when the phone already said one
 * the moment the other side stopped talking. What follows it stays as it is.
 */
export function stripAcknowledgment(text: string): string {
  return text.replace(/^\s*(?:아,?\s*)?(?:네네|네|예|음)(?:[,.!~…]+\s*|\s+(?=\S))/, '').trimStart();
}
