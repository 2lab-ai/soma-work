import { describe, expect, it } from 'vitest';
import { hasSpeech, SentenceSplitter, toSpeakable } from '../speech-text';

describe('SentenceSplitter', () => {
  it('releases each sentence as soon as its mark arrives', () => {
    const s = new SentenceSplitter();
    expect(s.push('안녕하세요, 소마')).toEqual([]);
    expect(s.push('예요. 지금 통')).toEqual(['안녕하세요, 소마예요.']);
    expect(s.push('화 괜찮으세요?')).toEqual(['지금 통화 괜찮으세요?']);
    expect(s.flush()).toEqual([]);
  });

  it('keeps short bits with the next sentence, and runs of marks together', () => {
    const s = new SentenceSplitter();
    expect(s.push('네. 그렇군요!? 다음')).toEqual(['네. 그렇군요!?']);
    expect(s.flush()).toEqual(['다음']);
  });

  it('cuts a very long sentence at a comma', () => {
    const s = new SentenceSplitter();
    const long = `${'가'.repeat(125)}, 나머지`;
    expect(s.push(long)).toEqual([`${'가'.repeat(125)},`]);
    expect(s.flush()).toEqual(['나머지']);
  });

  it('starts a turn sooner: its first chunk may end at a comma once it has a clause, later ones may not', () => {
    const s = new SentenceSplitter();
    expect(s.push('오늘 오후 두 시에 디자인 회의가 있고, 저녁에는')).toEqual(['오늘 오후 두 시에 디자인 회의가 있고,']);
    expect(s.push(' 코드 리뷰가 있고, 내일은 쉬어요. 그리고')).toEqual(['저녁에는 코드 리뷰가 있고, 내일은 쉬어요.']);
    expect(s.flush()).toEqual(['그리고']);
    // A short opener ("네,") is not a clause: it waits for the sentence.
    expect(s.push('네, 알겠습니다. ')).toEqual(['네, 알겠습니다.']);
    s.flush();
    // The next turn may start at a comma again.
    expect(s.push('말씀하신 내용은 담당자에게, ')).toEqual(['말씀하신 내용은 담당자에게,']);
  });

  it('splits at a newline', () => {
    const s = new SentenceSplitter();
    expect(s.push('첫째 줄 끝\n둘째')).toEqual(['첫째 줄 끝']);
  });
});

describe('toSpeakable', () => {
  it('drops markdown, links, emoji and list marks, keeps the words', () => {
    expect(toSpeakable('**중요**: [주문](https://x.y/z) 확인했어요 😊')).toBe('중요 : 주문 확인했어요');
    expect(toSpeakable('- 첫째\n- 둘째')).toBe('첫째 둘째');
    expect(toSpeakable('코드 `abc` 와 https://example.com 끝')).toBe('코드 abc 와 끝');
  });
  it('knows when nothing is left to say', () => {
    expect(hasSpeech(toSpeakable('😊 ...'))).toBe(false);
    expect(hasSpeech('네')).toBe(true);
  });
});
