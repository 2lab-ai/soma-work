/**
 * #1073 — decision lines on a question card (Plannotator Inbox P2, epic #1076).
 *
 * SSOT (issue #1073 Done): the three lines are optional and a card without them looks exactly as today; blocked work
 * and stakes are one line each; an irreversible choice is shown prominently with its reason; the lines sit in ONE
 * context block so the 50-block message cap holds (a multi form chunks 6 questions per message).
 *
 *   S1 no decision fields → every theme and the multi form are byte-identical to main (snapshot taken on main).
 *   S2 with fields → one context block, directly under the 💡 context (or the question), lines in the fixed order.
 *   S3 an irreversible choice: ⚠️ + bold label + its reason; a reversible one is a quiet line.
 *   S4 model text is escaped (no mention / link injection).
 *   S5 the multi form: an unanswered question carries the block after its context; an answered one does not.
 *   S6 a full 6-question chunk with every field stays within 50 blocks.
 *   S7 the no-tool path (fenced JSON) carries the fields, normalized like the validator.
 */

import { describe, expect, it } from 'vitest';
import type { UserChoice, UserChoices } from '../../types';
import { ChoiceMessageBuilder, type SlackMessagePayload } from '../choice-message-builder';
import { UserChoiceHandler } from '../user-choice-handler';

const themes = ['default', 'compact', 'minimal'] as const;

const BASE: UserChoice = {
  type: 'user_choice',
  question: '[small] 배포 전에 마이그레이션을 돌릴까요?',
  context: '스키마가 바뀌었습니다. 지금 돌리면 다음 배포가 바로 됩니다.',
  recommendedChoiceId: '1',
  choices: [
    { id: '1', label: '지금 돌린다', description: '배포 차단 해제' },
    { id: '2', label: '내일 돌린다' },
    { id: '3', label: '돌리지 않는다' },
  ],
};

const WITH_LINES = {
  ...BASE,
  blockedWork: 'PR #42 배포',
  stakes: '사용자 테이블 2만 행',
  reversible: false,
  reversibleWhy: '컬럼을 지우면 백업에서만 되살릴 수 있다',
} as UserChoice;

const GROUP: UserChoices = {
  type: 'user_choices',
  title: '[medium] 두 가지 결정',
  description: '둘 다 정해야 다음 단계로 갑니다.',
  questions: [
    {
      id: 'q1',
      question: '어떤 브랜치에?',
      context: '릴리스 브랜치가 하나 더 있습니다.',
      recommendedChoiceId: 'a',
      choices: [
        { id: 'a', label: 'main' },
        { id: 'b', label: 'release' },
        { id: 'c', label: 'hotfix' },
      ],
    },
    {
      id: 'q2',
      question: '태그를 붙일까요?',
      choices: [
        { id: 'x', label: '붙인다' },
        { id: 'y', label: '안 붙인다' },
        { id: 'z', label: '나중에' },
      ],
    },
  ],
};

const blocksOf = (p: SlackMessagePayload): any[] => p.attachments![0].blocks as any[];
const isDecisionBlock = (b: any): boolean =>
  b.type === 'context' && typeof b.elements?.[0]?.text === 'string' && /^(🚧|⚖️|⚠️|↩️) /.test(b.elements[0].text);
const decisionBlocks = (blocks: any[]): any[] => blocks.filter(isDecisionBlock);

describe('S1 — no decision fields: byte-identical to main', () => {
  for (const theme of themes) {
    it(`single choice, theme ${theme}`, () => {
      const out = ChoiceMessageBuilder.buildUserChoiceBlocks(BASE, 'C1:t1', theme);
      expect(JSON.stringify(out)).toMatchSnapshot();
    });
    it(`single choice without context, theme ${theme}`, () => {
      const out = ChoiceMessageBuilder.buildUserChoiceBlocks({ ...BASE, context: undefined }, 'C1:t1', theme, 'turn-1');
      expect(JSON.stringify(out)).toMatchSnapshot();
    });
  }
  it('multi form, nothing answered', () => {
    const out = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(GROUP, 'form-1', 'C1:t1');
    expect(JSON.stringify(out)).toMatchSnapshot();
  });
  it('multi form, one answered', () => {
    const out = ChoiceMessageBuilder.buildMultiChoiceFormBlocks(GROUP, 'form-1', 'C1:t1', {
      q1: { choiceId: 'a', label: 'main' },
    });
    expect(JSON.stringify(out)).toMatchSnapshot();
  });
});

describe('S2/S3 — single choice with decision lines', () => {
  for (const theme of themes) {
    it(`theme ${theme}: one context block right under the 💡 context, lines in order`, () => {
      const blocks = blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(WITH_LINES, 'C1:t1', theme));
      const found = decisionBlocks(blocks);
      expect(found).toHaveLength(1);
      const idx = blocks.indexOf(found[0]);
      expect(blocks[idx - 1].type).toBe('context');
      expect(blocks[idx - 1].elements[0].text.startsWith('💡 ')).toBe(true);
      expect(found[0].elements).toHaveLength(1);
      expect(found[0].elements[0].type).toBe('mrkdwn');
      expect(found[0].elements[0].text).toBe(
        [
          '🚧 막힌 작업 — PR #42 배포',
          '⚖️ 걸린 것 — 사용자 테이블 2만 행',
          '⚠️ *되돌릴 수 없음* — 컬럼을 지우면 백업에서만 되살릴 수 있다',
        ].join('\n'),
      );
    });

    it(`theme ${theme}: no context → the block follows the question`, () => {
      const blocks = blocksOf(
        ChoiceMessageBuilder.buildUserChoiceBlocks({ ...WITH_LINES, context: undefined }, 'C1:t1', theme),
      );
      const found = decisionBlocks(blocks);
      expect(found).toHaveLength(1);
      const idx = blocks.indexOf(found[0]);
      expect(idx).toBe(1);
      expect(String(JSON.stringify(blocks[0]))).toContain('배포 전에 마이그레이션을 돌릴까요?');
    });

    it(`theme ${theme}: adds exactly one block over the same question without fields`, () => {
      const plain = blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(BASE, 'C1:t1', theme));
      const lined = blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(WITH_LINES, 'C1:t1', theme));
      expect(lined.length).toBe(plain.length + 1);
      expect(lined.filter((b) => !isDecisionBlock(b))).toEqual(plain);
    });
  }

  it('each line is optional; only the given ones show, in the same order', () => {
    const only = (extra: Partial<UserChoice> & Record<string, unknown>) =>
      decisionBlocks(blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks({ ...BASE, ...extra } as UserChoice, 'k')))
        .map((b) => b.elements[0].text)
        .join('|');
    expect(only({ stakes: '고객 데이터' })).toBe('⚖️ 걸린 것 — 고객 데이터');
    expect(only({ reversible: false })).toBe('⚠️ *되돌릴 수 없음*');
    expect(only({ reversible: true })).toBe('↩️ 되돌릴 수 있음');
    expect(only({ reversible: true, reversibleWhy: 'git revert 한 번' })).toBe('↩️ 되돌릴 수 있음 — git revert 한 번');
    expect(only({ reversible: true, blockedWork: '릴리스 노트' })).toBe('🚧 막힌 작업 — 릴리스 노트\n↩️ 되돌릴 수 있음');
  });

  it('blank or non-string values render nothing', () => {
    const blocks = blocksOf(
      ChoiceMessageBuilder.buildUserChoiceBlocks(
        {
          ...BASE,
          blockedWork: '   ',
          stakes: 42,
          reversible: 'maybe',
          reversibleWhy: 'lonely',
        } as unknown as UserChoice,
        'k',
      ),
    );
    expect(decisionBlocks(blocks)).toHaveLength(0);
  });
});

describe('S4 — model text is escaped', () => {
  it('a mention or link in a line cannot ping or link', () => {
    const blocks = blocksOf(
      ChoiceMessageBuilder.buildUserChoiceBlocks(
        {
          ...BASE,
          blockedWork: '<!channel> 공지',
          stakes: '<https://evil.example|여기>',
          reversible: false,
          reversibleWhy: 'a & b',
        } as UserChoice,
        'k',
      ),
    );
    const text = decisionBlocks(blocks)[0].elements[0].text as string;
    expect(text).toContain('&lt;!channel&gt; 공지');
    expect(text).toContain('&lt;https://evil.example|여기&gt;');
    expect(text).toContain('a &amp; b');
    expect(text).not.toContain('<!channel>');
  });
});

describe('S5 — multi form', () => {
  const lined: UserChoices = {
    ...GROUP,
    questions: [
      { ...GROUP.questions[0], blockedWork: '릴리스 빌드', reversible: false, reversibleWhy: '태그가 공개된다' },
      { ...GROUP.questions[1], stakes: '변경 기록' },
    ] as UserChoices['questions'],
  };

  it('an unanswered question carries one decision block after its context (or its title)', () => {
    const blocks = blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(lined, 'f', 'k'));
    const found = decisionBlocks(blocks);
    expect(found.map((b) => b.elements[0].text)).toEqual([
      '🚧 막힌 작업 — 릴리스 빌드\n⚠️ *되돌릴 수 없음* — 태그가 공개된다',
      '⚖️ 걸린 것 — 변경 기록',
    ]);
    const first = blocks.indexOf(found[0]);
    expect(blocks[first - 1].elements[0].text).toBe('💡 릴리스 브랜치가 하나 더 있습니다.');
    const second = blocks.indexOf(found[1]);
    expect(blocks[second - 1].text.text).toBe('❓ *Q2. 태그를 붙일까요?*');
  });

  it('an answered question keeps its lines under the answer until the form is sent', () => {
    const blocks = blocksOf(
      ChoiceMessageBuilder.buildMultiChoiceFormBlocks(lined, 'f', 'k', { q1: { choiceId: 'a', label: 'main' } }),
    );
    const found = decisionBlocks(blocks);
    expect(found.map((b) => b.elements[0].text)).toEqual([
      '🚧 막힌 작업 — 릴리스 빌드\n⚠️ *되돌릴 수 없음* — 태그가 공개된다',
      '⚖️ 걸린 것 — 변경 기록',
    ]);
    const first = blocks.indexOf(found[0]);
    expect(blocks[first - 1].elements[0].text).toBe('➜ *main*');
  });

  it('a question without fields adds nothing, answered or not', () => {
    const plain = blocksOf(
      ChoiceMessageBuilder.buildMultiChoiceFormBlocks(GROUP, 'f', 'k', { q1: { choiceId: 'a', label: 'main' } }),
    );
    expect(decisionBlocks(plain)).toHaveLength(0);
  });
});

describe('S6 — 50-block cap', () => {
  it('a 6-question chunk with context, descriptions and every decision field stays ≤ 50 blocks', () => {
    const q = (n: number) => ({
      id: `q${n}`,
      question: `질문 ${n}`,
      context: `맥락 ${n}`,
      recommendedChoiceId: '1',
      blockedWork: `작업 ${n}`,
      stakes: `걸린 것 ${n}`,
      reversible: false,
      reversibleWhy: `이유 ${n}`,
      choices: [
        { id: '1', label: 'A', description: 'a' },
        { id: '2', label: 'B', description: 'b' },
        { id: '3', label: 'C', description: 'c' },
        { id: '4', label: 'D', description: 'd' },
      ],
    });
    const form = {
      type: 'user_choices',
      title: 't',
      description: 'd',
      questions: [1, 2, 3, 4, 5, 6].map(q),
    } as UserChoices;
    const none = blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(form, 'f', 'k'));
    expect(none.length).toBeLessThanOrEqual(50);
    // Every question answered: the submit area (divider + section + actions) joins.
    const all = Object.fromEntries(form.questions.map((x) => [x.id, { choiceId: '1', label: 'A' }]));
    const done = blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(form, 'f', 'k', all));
    expect(done.length).toBeLessThanOrEqual(50);
    // The worst case the builder can produce: five open questions (7 blocks each) + one answered + submit area.
    const five = blocksOf(
      ChoiceMessageBuilder.buildMultiChoiceFormBlocks(form, 'f', 'k', { q6: { choiceId: '1', label: 'A' } }),
    );
    expect(five.length).toBeLessThanOrEqual(50);
    expect(decisionBlocks(none)).toHaveLength(6);
  });
});

describe('S6a — the no-tool path does not cap the options; the builder does', () => {
  it('a fenced group of 6 questions with 5 options, context and every field stays ≤ 50 blocks', () => {
    const q = (n: number) => ({
      question: `질문 ${n}`,
      context: `맥락 ${n}`,
      blockedWork: `작업 ${n}`,
      stakes: `걸린 것 ${n}`,
      reversible: false,
      reversibleWhy: `이유 ${n}`,
      options: [1, 2, 3, 4, 5].map((i) => ({ id: String(i), label: `L${i}`, description: `d${i}` })),
    });
    const reply = `\`\`\`json\n${JSON.stringify({ type: 'user_choice_group', question: 't', context: 'd', choices: [1, 2, 3, 4, 5, 6].map(q) })}\n\`\`\``;
    const { choices } = UserChoiceHandler.extractUserChoice(reply);
    expect(choices?.questions).toHaveLength(6);
    expect(choices?.questions[0].choices).toHaveLength(5);
    const blocks = blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(choices as UserChoices, 'f', 'k'));
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(decisionBlocks(blocks)).toHaveLength(6);
  });
});

describe('S6b — 3000-char text limit', () => {
  it('three lines of the longest values, all escaping characters, stay under 3000 chars', () => {
    const worst = '&'.repeat(400);
    for (const theme of themes) {
      const blocks = blocksOf(
        ChoiceMessageBuilder.buildUserChoiceBlocks(
          { ...BASE, blockedWork: worst, stakes: worst, reversible: false, reversibleWhy: worst } as UserChoice,
          'k',
          theme,
        ),
      );
      const text = decisionBlocks(blocks)[0].elements[0].text as string;
      expect(text.length).toBeLessThanOrEqual(3000);
      // The builder caps what it is handed (renderer-level defense), before escaping.
      expect(text.split('\n')[0]).toBe(`🚧 막힌 작업 — ${'&amp;'.repeat(159)}…`);
    }
  });
});

describe('S7 — the no-tool path (fenced JSON) carries the fields', () => {
  it('a user_choice block keeps the decision fields, normalized', () => {
    const long = 'x'.repeat(250);
    const reply = `먼저 하나만 정해 주세요.\n\n\`\`\`json\n${JSON.stringify({
      type: 'user_choice',
      question: '[small] 지울까요?',
      choices: [
        { id: '1', label: '지운다' },
        { id: '2', label: '보관한다' },
        { id: '3', label: '그대로 둔다' },
      ],
      blockedWork: '디스크\n정리',
      stakes: long,
      reversible: 'no',
      reversibleWhy: '휴지통이 없다',
      unknownKey: 'dropped',
    })}\n\`\`\``;
    const { choice } = UserChoiceHandler.extractUserChoice(reply);
    expect(choice).toMatchObject({
      blockedWork: '디스크 정리',
      reversible: false,
      reversibleWhy: '휴지통이 없다',
    });
    expect((choice as any).stakes).toHaveLength(160);
    expect((choice as any).stakes.endsWith('…')).toBe(true);
    expect((choice as any).unknownKey).toBeUndefined();
  });

  it('a user_choice_group keeps them per question, and a lone why without reversible is dropped', () => {
    const reply = `\`\`\`json\n${JSON.stringify({
      type: 'user_choice_group',
      question: '[small] 두 가지',
      choices: [
        {
          question: 'A?',
          stakes: '돈',
          options: [
            { id: '1', label: 'a' },
            { id: '2', label: 'b' },
            { id: '3', label: 'c' },
          ],
        },
        {
          question: 'B?',
          reversibleWhy: '이유만 있음',
          options: [
            { id: '1', label: 'a' },
            { id: '2', label: 'b' },
            { id: '3', label: 'c' },
          ],
        },
      ],
    })}\n\`\`\``;
    const { choices } = UserChoiceHandler.extractUserChoice(reply);
    expect(choices?.questions[0]).toMatchObject({ id: 'q1', stakes: '돈' });
    expect((choices?.questions[1] as any).reversibleWhy).toBeUndefined();
  });

  it('a group of one becomes a single choice with its fields', () => {
    const reply = `\`\`\`json\n${JSON.stringify({
      type: 'user_choice_group',
      question: '[small] 하나',
      choices: [
        {
          question: 'A?',
          blockedWork: '배포',
          reversible: true,
          options: [
            { id: '1', label: 'a' },
            { id: '2', label: 'b' },
            { id: '3', label: 'c' },
          ],
        },
      ],
    })}\n\`\`\``;
    const { choice } = UserChoiceHandler.extractUserChoice(reply);
    expect(choice).toMatchObject({ type: 'user_choice', blockedWork: '배포', reversible: true });
  });
});

describe('S8 — the answer a Slack button sends is unchanged', () => {
  const values = (blocks: any[]) =>
    blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e: any) => [e.action_id, e.value]));
  for (const theme of themes) {
    it(`theme ${theme}: every button carries the same value with or without the lines`, () => {
      const plain = values(blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(BASE, 'k', theme, 'turn-1')));
      const lined = values(blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(WITH_LINES, 'k', theme, 'turn-1')));
      expect(lined).toEqual(plain);
      expect(JSON.stringify(lined)).not.toMatch(/blockedWork|stakes|reversible/);
    });
  }
  it('multi form: every button carries the same value', () => {
    const lined = {
      ...GROUP,
      questions: GROUP.questions.map((q) => ({ ...q, stakes: '돈', reversible: false })),
    } as UserChoices;
    const plain = values(blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(GROUP, 'f', 'k')));
    expect(values(blocksOf(ChoiceMessageBuilder.buildMultiChoiceFormBlocks(lined, 'f', 'k')))).toEqual(plain);
  });
});

describe('S9 — an English reader gets the labels in English, whatever language the values are in', () => {
  it('translateText turns each label, keeps the model text', async () => {
    const { registerDisplayCatalog, translateText } = await import('@soma/common/i18n');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const catalog = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-text.json');
    registerDisplayCatalog('en', JSON.parse(readFileSync(catalog, 'utf8')));
    const blocks = blocksOf(ChoiceMessageBuilder.buildUserChoiceBlocks(WITH_LINES, 'k'));
    const text = decisionBlocks(blocks)[0].elements[0].text as string;
    expect(translateText(text, 'en')).toBe(
      [
        '🚧 Blocked work — PR #42 배포',
        '⚖️ At stake — 사용자 테이블 2만 행',
        '⚠️ *Cannot be undone* — 컬럼을 지우면 백업에서만 되살릴 수 있다',
      ].join('\n'),
    );
    expect(translateText('↩️ 되돌릴 수 있음', 'en')).toBe('↩️ Can be undone');
    expect(translateText('⚠️ *되돌릴 수 없음*', 'en')).toBe('⚠️ *Cannot be undone*');
  });
});

describe('S4b — a value cannot open a Slack code block across the lines', () => {
  it('a run of backticks in a value is broken, so the irreversible label stays bold and outside any code block', () => {
    const fence = '```';
    const blocks = blocksOf(
      ChoiceMessageBuilder.buildUserChoiceBlocks(
        { ...BASE, blockedWork: `${fence}sh`, reversible: false, reversibleWhy: `drops ${fence}` } as UserChoice,
        'k',
      ),
    );
    const text = decisionBlocks(blocks)[0].elements[0].text as string;
    expect(text).not.toContain(fence);
    expect(text.split('\n')[1].startsWith('⚠️ *되돌릴 수 없음* — drops ')).toBe(true);
    // What the reader sees is the same characters (a zero-width space between the backticks).
    expect(text.replace(/​/g, '')).toBe(`🚧 막힌 작업 — ${fence}sh\n⚠️ *되돌릴 수 없음* — drops ${fence}`);
  });
});
