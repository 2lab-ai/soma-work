/**
 * 보낸 지시 (SSOT 2026-11-27) — the server half: which user turns are a person's instructions, their numbered pages
 * and their one-line words. Which turns count is the page's `sysTurnInfo` rule (dashboard.ts): the parity suite runs
 * the shipped client function over the same turns, so the count on the button and the chat it jumps into cannot drift.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBackgroundWaitPrompt } from '@soma/slack/pipeline/background-wait';
import { describe, expect, it } from 'vitest';
import { buildGoalContinuationPrompt } from '../../prompt/session-goal-block';
import { GOAL_CONTINUATION_TEXT_PREFIX } from '../../slack/goal-continuation';
import type { SessionGoal } from '../../types';
import {
  INSTRUCTION_PAGE_MAX,
  INSTRUCTION_PREVIEW_MAX,
  instructionPage,
  instructionPreview,
  isHostTurn,
  isInstructionTurn,
  parseInstructionQuery,
} from '../instruction-history';
import type { ConversationTurn } from '../types';

const ROOT = join(__dirname, '..', '..', '..');
const DASHBOARD_TS = readFileSync(join(ROOT, 'src/conversation/dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function cutFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(start + 1, TEMPLATE.indexOf('\n}\n', start) + 2));
}
function cutVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
const client = new Function(
  [
    ...['SYS_RESTART_HEADS', 'SYS_RESUME_CONTEXT', 'SYS_RETRY_MARK'].map(cutVar),
    ...[
      'decodeSlackEntities',
      'sysOneLine',
      'sysBetween',
      'sysResumeContext',
      'sysTurnInfo',
      'estimateTokens',
      'splitInvokedSkills',
    ].map(cutFn),
    'return { sysTurnInfo, splitInvokedSkills };',
  ].join('\n'),
)() as {
  sysTurnInfo(t: unknown): unknown;
  splitInvokedSkills(raw: string): { text: string; skills: { name: string }[] };
};

let seq = 0;
const user = (rawContent: string, extra: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id: `u${++seq}`,
  role: 'user',
  timestamp: 1000 + seq,
  userName: 'Z',
  rawContent,
  ...extra,
});
const answer = (): ConversationTurn => ({ id: `a${++seq}`, role: 'assistant', timestamp: 1000 + seq, rawContent: '' });
const SYSTEM = { origin: { by: 'system' as const } };
const PERSON = { origin: { by: 'user' as const } };

const RESTART_PROMPT = readFileSync(join(ROOT, 'src/prompt/restart.prompt'), 'utf-8').trimEnd();
const goalPrompt = (n: number, max: number) =>
  `${GOAL_CONTINUATION_TEXT_PREFIX} ${buildGoalContinuationPrompt({
    continuationCount: n,
    maxContinuations: max,
    lastEvalReason: '테스트 남음',
  } as unknown as SessionGoal)}`;

// Every kind of user turn the chat knows — the producers' own wording where a producer exists.
const FIXTURES: Array<[string, ConversationTurn]> = [
  ['a person, origin recorded', user('로그인 버그 고쳐줘', PERSON)],
  ['a person, before origins were kept', user('PR 올려줘')],
  ['a person whose words start like a command', user('/compactify the list', PERSON)],
  ['a person typing /compact without the recorder mark', user('/compact', PERSON)],
  ['/compact marked by the recorder (soma-work)', user('/compact', { ...SYSTEM, compact: { estimateMs: 1 } })],
  ['/compact marked by the recorder (a person)', user('/compact 인증 위주', { ...PERSON, compact: { estimateMs: 1 } })],
  ['bare /compact from before origins', user('/compact')],
  ['restart resume', user(RESTART_PROMPT, SYSTEM)],
  ['restart resume without origin', user(RESTART_PROMPT)],
  ['restart resume (Korean head)', user('서비스가 재시작되어 이전 작업이 중단되었다.\n이어서', SYSTEM)],
  ['restart resume (bracket head)', user('[재시작 후 자동 재개] 하던 일', SYSTEM)],
  ['goal continuation', user(goalPrompt(2, 5), SYSTEM)],
  ['goal continuation without origin', user(goalPrompt(3, 5))],
  [
    'background-work resume',
    user(buildBackgroundWaitPrompt({ count: 2, labels: ['local_bash', 'local_agent'] } as never, 1, 6), SYSTEM),
  ],
  ['cron fire', user('[cron:daily-report] 오늘 리포트', SYSTEM)],
  ['cron fire without origin', user('[cron:daily-report] 오늘 리포트')],
  ['renew save', user('Follow this exact sequence:\n1. Use skill="local:save" …', PERSON)],
  ['renew load', user("Use 'local:load' skill with this saved context:\n<user-instruction>계속</user-instruction>")],
  ['another host turn', user('host follow-up', SYSTEM)],
  ['a person quoting a cron head', user('[cron:x] 이건 내가 쓴 거', PERSON)],
  ['Slack-escaped person words', user('&lt;b&gt; 태그 &amp; 기호', PERSON)],
];

describe('which user turns are a person’s instructions — the page’s sysTurnInfo, turn for turn', () => {
  it.each(FIXTURES)('%s', (_name, t) => {
    expect(isHostTurn(t)).toBe(client.sysTurnInfo(t) !== null);
  });

  it('the fixtures cover both sides (a parity over host turns only would prove nothing)', () => {
    const host = FIXTURES.filter(([, t]) => isHostTurn(t)).length;
    expect(host).toBeGreaterThan(8);
    expect(FIXTURES.length - host).toBeGreaterThan(4);
  });

  it('an answer is never an instruction; a turn a rollback dropped is not one any more', () => {
    expect(isInstructionTurn(answer())).toBe(false);
    expect(isInstructionTurn(user('지시', PERSON))).toBe(true);
    expect(isInstructionTurn(user('지시', { ...PERSON, rewoundAt: 5 }))).toBe(false);
    expect(isInstructionTurn(user('[cron:x] y', SYSTEM))).toBe(false);
  });
});

describe('instructionPreview — the words 대화 shows, on one line', () => {
  it('takes every closed skill block out and names its skills, as the chat’s badges (same rule as splitInvokedSkills)', () => {
    const raw =
      '<invoked_skills>\n<local:z>\nbody\n</local:z>\n<local:es>\nx\n</local:es>\n</invoked_skills>\n로그인 버그 고쳐줘';
    expect(instructionPreview(raw)).toEqual({ text: '로그인 버그 고쳐줘', skills: ['local:z', 'local:es'] });
    expect(client.splitInvokedSkills(raw).text.trim()).toBe('로그인 버그 고쳐줘');
    expect(client.splitInvokedSkills(raw).skills.map((s) => s.name)).toEqual(['local:z', 'local:es']);
  });

  it('a literal mention of the tag stays words; an unclosed block is words; a closed block with no skill is words', () => {
    expect(instructionPreview('the <invoked_skills> tag').text).toBe('the <invoked_skills> tag');
    expect(instructionPreview('a </invoked_skills> stray').text).toBe('a </invoked_skills> stray');
    const empty = 'see <invoked_skills>no tags here</invoked_skills> please';
    expect(instructionPreview(empty)).toEqual({ text: empty, skills: [] });
    expect(client.splitInvokedSkills(empty).text).toBe(empty);
  });

  it('decodes Slack entities, folds blanks and line ends, cuts long words with an ellipsis', () => {
    expect(instructionPreview('  a &lt;b&gt;\n\n  c &amp; d  ').text).toBe('a <b> c & d');
    const long = '가'.repeat(INSTRUCTION_PREVIEW_MAX + 50);
    const cut = instructionPreview(long).text;
    expect(Array.from(cut)).toHaveLength(INSTRUCTION_PREVIEW_MAX);
    expect(cut.endsWith('…')).toBe(true);
    // A surrogate pair is never split.
    expect(instructionPreview('😀'.repeat(300), 10).text).toBe(`${'😀'.repeat(9)}…`);
  });
});

describe('instructionPage — numbered from the first instruction, a page at a time', () => {
  seq = 0;
  const turns: ConversationTurn[] = [];
  for (let i = 1; i <= 7; i++) {
    turns.push(
      user(`지시 ${i}`, i === 2 ? { ...PERSON, attachments: [{ id: 'f' } as any, { id: 'g' } as any] } : PERSON),
    );
    turns.push(answer());
    if (i === 3) turns.push(user('[cron:x] y', SYSTEM));
  }

  it('asc: #1 is the first; nextOffset walks the pages; the last page says so', () => {
    const p1 = instructionPage(turns, { offset: 0, limit: 3, order: 'asc' });
    expect(p1.total).toBe(7);
    expect(p1.items.map((r) => [r.n, r.text])).toEqual([
      [1, '지시 1'],
      [2, '지시 2'],
      [3, '지시 3'],
    ]);
    expect(p1.items[1].files).toBe(2);
    expect(p1.nextOffset).toBe(3);
    const p3 = instructionPage(turns, { offset: 6, limit: 3, order: 'asc' });
    expect(p3.items.map((r) => r.n)).toEqual([7]);
    expect(p3.nextOffset).toBeNull();
  });

  it('desc: the newest first, the numbers unchanged', () => {
    const p = instructionPage(turns, { offset: 0, limit: 3, order: 'desc' });
    expect(p.items.map((r) => r.n)).toEqual([7, 6, 5]);
    expect(p.items[0].text).toBe('지시 7');
    expect(instructionPage(turns, { offset: 6, limit: 3, order: 'desc' }).items.map((r) => r.n)).toEqual([1]);
  });

  it('limit 0 is the count alone; an offset past the end is an empty last page', () => {
    expect(instructionPage(turns, { offset: 0, limit: 0, order: 'asc' })).toEqual({
      total: 7,
      offset: 0,
      nextOffset: 0,
      order: 'asc',
      items: [],
    });
    expect(instructionPage(turns, { offset: 99, limit: 5, order: 'asc' })).toMatchObject({
      offset: 7,
      nextOffset: null,
      items: [],
    });
  });

  it('the row carries the turn id 대화 uses, the time and who sent it', () => {
    const [row] = instructionPage(turns, { offset: 0, limit: 1, order: 'asc' }).items;
    expect(row).toEqual({ id: turns[0].id, n: 1, at: turns[0].timestamp, userName: 'Z', text: '지시 1' });
  });
});

describe('parseInstructionQuery — the query made safe', () => {
  it('defaults, bounds and junk', () => {
    expect(parseInstructionQuery({})).toEqual({ offset: 0, limit: 30, order: 'asc' });
    expect(parseInstructionQuery({ offset: '-4', limit: '9999', order: 'desc' })).toEqual({
      offset: 0,
      limit: INSTRUCTION_PAGE_MAX,
      order: 'desc',
    });
    expect(parseInstructionQuery({ offset: 'x', limit: 'y', order: 'sideways' })).toEqual({
      offset: 0,
      limit: 30,
      order: 'asc',
    });
    expect(parseInstructionQuery({ limit: '0' }).limit).toBe(0);
  });
});
