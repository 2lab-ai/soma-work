import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentDisplayLang,
  DEFAULT_DISPLAY_LANG,
  displayLangOf,
  parseDisplayLang,
  registerDisplayCatalog,
  runWithDisplayLang,
  setCurrentDisplayLang,
  t,
  templateKey,
  tr,
  translateText,
  trIn,
} from '../i18n';

registerDisplayCatalog('en', {
  '__테스트 저장 완료': 'Test saved',
  '__테스트 ❌ {0} 실패: {1}': 'Test ❌ {1} — {0} failed',
  '__테스트 {0}개 남음': '{0} left (test)',
});

describe('display language', () => {
  it('defaults to ko', () => {
    expect(DEFAULT_DISPLAY_LANG).toBe('ko');
    expect(currentDisplayLang()).toBe('ko');
  });

  it('parses the names people type', () => {
    for (const v of ['ko', 'KO', ' kr ', 'korean', '한국어', '한글']) expect(parseDisplayLang(v)).toBe('ko');
    for (const v of ['en', 'EN', 'english', 'English', '영어', 'en-US']) expect(parseDisplayLang(v)).toBe('en');
    for (const v of ['', 'jp', 'fr', undefined, 3]) expect(parseDisplayLang(v)).toBeNull();
  });

  it('reads a stored value as ko unless it is exactly en', () => {
    expect(displayLangOf('en')).toBe('en');
    expect(displayLangOf('ko')).toBe('ko');
    expect(displayLangOf(undefined)).toBe('ko');
    expect(displayLangOf('EN')).toBe('ko');
  });

  it('carries the language across awaits and timers inside the scope', async () => {
    const seen = await runWithDisplayLang('en', async () => {
      await new Promise((r) => setTimeout(r, 1));
      const inner = await new Promise<string>((r) => setImmediate(() => r(currentDisplayLang())));
      return [currentDisplayLang(), inner];
    });
    expect(seen).toEqual(['en', 'en']);
    expect(currentDisplayLang()).toBe('ko');
  });

  it('lets a running scope change its language; outside a scope that does nothing', () => {
    setCurrentDisplayLang('en');
    expect(currentDisplayLang()).toBe('ko');
    runWithDisplayLang('ko', () => {
      setCurrentDisplayLang('en');
      expect(currentDisplayLang()).toBe('en');
    });
  });
});

describe('t()', () => {
  it('returns the Korean source in ko and the catalog text in en', () => {
    expect(t('__테스트 저장 완료')).toBe('__테스트 저장 완료');
    expect(runWithDisplayLang('en', () => t('__테스트 저장 완료'))).toBe('Test saved');
    expect(t('__테스트 저장 완료', 'en')).toBe('Test saved');
  });

  it('shows a source string the catalog does not know as written', () => {
    expect(runWithDisplayLang('en', () => t('__테스트 없는 문구'))).toBe('__테스트 없는 문구');
  });
});

describe('tr``', () => {
  it('keys a template by its literal parts and numbered placeholders', () => {
    expect(templateKey(['❌ ', ' 실패: ', ''])).toBe('❌ {0} 실패: {1}');
    expect(templateKey(['plain'])).toBe('plain');
  });

  it('reads exactly like the untagged literal in ko', () => {
    const name = 'deploy';
    const why = { toString: () => 'timeout' };
    expect(tr`__테스트 ❌ ${name} 실패: ${why}`).toBe(`__테스트 ❌ ${name} 실패: ${why}`);
    expect(tr`${undefined}/${null}/${3}`).toBe(`${undefined}/${null}/${3}`);
  });

  it('fills the English text, placeholders in any order', () => {
    const out = runWithDisplayLang('en', () => tr`__테스트 ❌ ${'deploy'} 실패: ${'timeout'}`);
    expect(out).toBe('Test ❌ timeout — deploy failed');
    expect(trIn('en', Object.assign(['__테스트 ', '개 남음'], { raw: ['__테스트 ', '개 남음'] }), 3)).toBe(
      '3 left (test)',
    );
  });

  it('falls back to the cooked Korean template when the catalog has no text', () => {
    expect(runWithDisplayLang('en', () => tr`__테스트 ${1}분 남음`)).toBe('__테스트 1분 남음');
  });
});

describe('translateText — text already composed (the output boundary)', () => {
  registerDisplayCatalog('en', {
    '__tt 세션 종료': '__tt Session closed',
    '__tt ✅ {0} 저장 완료 ({1}개)': '__tt ✅ Saved {0} ({1} items)',
    '__tt 상태: {0}': '__tt Status: {0}',
    '__tt 진행 중': '__tt Running',
    '__tt 모델': '__tt Model',
  });

  it('ko is always the input', () => {
    expect(translateText('__tt 세션 종료', 'ko')).toBe('__tt 세션 종료');
  });

  it('whole strings, templates and their Korean values', () => {
    expect(translateText('__tt 세션 종료', 'en')).toBe('__tt Session closed');
    expect(translateText('__tt ✅ deploy 저장 완료 (3개)', 'en')).toBe('__tt ✅ Saved deploy (3 items)');
    expect(translateText('__tt 상태: __tt 진행 중', 'en')).toBe('__tt Status: __tt Running');
  });

  it('line by line and part by part, unknown text as written', () => {
    expect(translateText('*내 제목*\n__tt 세션 종료', 'en')).toBe('*내 제목*\n__tt Session closed');
    expect(translateText('__tt 모델 · opus · 사용자 글', 'en')).toBe('__tt Model · opus · 사용자 글');
    expect(translateText('  __tt 세션 종료', 'en')).toBe('  __tt Session closed');
    expect(translateText('plain english', 'en')).toBe('plain english');
  });

  it('a sentence the catalog knows, then a clause the code appended (`text + " — …"`): both halves', () => {
    registerDisplayCatalog('en', {
      '__tt ⭐ {0}님의 지시를 승인했습니다 — 앞으로 묻지 않습니다.':
        "__tt ⭐ Approved {0}'s instruction — won't ask again.",
      ' — __tt 대시보드에서 응답했습니다.': ' — __tt answered on the dashboard.',
      ' (__tt 대시보드에서 응답)': ' (__tt answered from the dashboard)',
    });
    expect(
      translateText(
        '__tt ⭐ <@U1>님의 지시를 승인했습니다 — 앞으로 묻지 않습니다. — __tt 대시보드에서 응답했습니다.',
        'en',
      ),
    ).toBe("__tt ⭐ Approved <@U1>'s instruction — won't ask again. — __tt answered on the dashboard.");
    expect(translateText('__tt 세션 종료 (__tt 대시보드에서 응답)', 'en')).toBe(
      '__tt Session closed (__tt answered from the dashboard)',
    );
    // Only when the head is the catalog's too: a person's words before the clause stay as written.
    expect(translateText('내가 쓴 말 — __tt 대시보드에서 응답했습니다.', 'en')).toBe(
      '내가 쓴 말 — __tt 대시보드에서 응답했습니다.',
    );
  });

  it('a slot never swallows a separator and the Korean beyond it: each part is matched on its own', () => {
    registerDisplayCatalog('en', {
      '<{0}|__tt 작업 스레드>': '<{0}|__tt Task thread>',
      '<{0}|__tt 대시보드에서 보기>': '<{0}|__tt View on dashboard>',
    });
    expect(translateText('<https://a/t|__tt 작업 스레드>  ·  <https://a/d|__tt 대시보드에서 보기>', 'en')).toBe(
      '<https://a/t|__tt Task thread>  ·  <https://a/d|__tt View on dashboard>',
    );
    // A person's title in the first part stays as written; the bot's link still reads in English.
    expect(translateText('<https://a/t|내 제목>  ·  <https://a/d|__tt 대시보드에서 보기>', 'en')).toBe(
      '<https://a/t|내 제목>  ·  <https://a/d|__tt View on dashboard>',
    );
  });

  it("a person's text with a separator inside a slot keeps the template: the frame translates, their words do not (review P1)", () => {
    // The task-done DM's shape: `{0} *{1}* — {2}\n<{3}|스레드로 이동>` with {2} the session's title.
    registerDisplayCatalog('en', {
      '{0} *__tt 작업 완료* — {1}\n<{2}|__tt 스레드로 이동>': '{0} *__tt Task done* — {1}\n<{2}|__tt Go to thread>',
      '__tt 수정': '__tt Fix',
      '__tt 응답': '__tt Reply',
    });
    for (const title of ['PR #77 리뷰 · __tt 수정', '배포 — 롤백 준비', '__tt 응답 · __tt 수정']) {
      expect(translateText(`✅ *__tt 작업 완료* — ${title}\n<https://t|__tt 스레드로 이동>`, 'en'), title).toBe(
        `✅ *__tt Task done* — ${title}\n<https://t|__tt Go to thread>`,
      );
    }
  });
});

describe('translateText against the real catalog — never claims a person’s Korean (review P1)', () => {
  // The shipped English catalog, registered like @soma/common/i18n-en does.
  registerDisplayCatalog(
    'en',
    JSON.parse(readFileSync(join(__dirname, '..', 'i18n-catalog', 'en-text.json'), 'utf8')) as Record<string, string>,
  );

  it('leaves free Korean text that only starts or ends like a short template as written', () => {
    for (const s of [
      '내일',
      '내일부턴',
      '월 3일',
      '원인: 토큰 만료라서 다시 로그인해',
      '피크 12시까지 기다려',
      '작업 2/5 완료했고 나머지는 내일',
      '파일 3개',
      '2026년 11월 2일',
      '// TODO 3개',
      '총 5회',
    ]) {
      expect(translateText(s, 'en'), s).toBe(s);
    }
  });

  it('still translates the bot’s own composed text', () => {
    expect(translateText('🌐 표시 언어: English', 'en')).toBe('🌐 Display language: English');
    expect(translateText('❌ `ko` 또는 `en`만 받습니다: `fr`', 'en')).toBe('❌ Only `ko` or `en` is accepted: `fr`');
  });
});
