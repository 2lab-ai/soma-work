import { describe, expect, it } from 'vitest';
import {
  buildCanceledPollMessage,
  buildClosedPollMessage,
  buildOpenPollMessage,
  buildResultNotices,
  formatKst,
  MAX_BLOCKS_PER_MESSAGE,
  MAX_SECTION_CHARS,
  POLL_ACTION_CANCEL,
  POLL_ACTION_CLOSE,
  POLL_ACTION_VOTE_PREFIX,
} from '../poll-blocks';
import type { PollRecord } from '../poll-types';

// 2026-10-02 12:50 KST == 03:50 UTC
const CLOSES_AT = Date.UTC(2026, 9, 2, 3, 50, 0);

function poll(overrides: Partial<PollRecord> = {}): PollRecord {
  return {
    id: 'poll_1',
    channel: 'C1',
    threadTs: '100.1',
    messageTs: '100.2',
    creatorId: 'UCREATOR',
    title: '점심 팀 편성',
    options: ['김치찌개', '된장찌개', '제육볶음'],
    votes: {},
    voteActionTs: {},
    closesAt: CLOSES_AT,
    status: 'open',
    createdAt: 1,
    ...overrides,
  };
}

const allText = (blocks: any[]) => JSON.stringify(blocks);

describe('formatKst', () => {
  it('renders KST regardless of host timezone', () => {
    expect(formatKst(CLOSES_AT)).toBe('10/02 12:50 KST');
  });
});

describe('buildOpenPollMessage', () => {
  it('has one uniquely-identified button per option labelled "n. label · count", in option order', () => {
    const msg = buildOpenPollMessage(poll({ votes: { UA: 1, UB: 1, UC: 0 } }));
    const buttons = msg.blocks.flatMap((b: any) => (b.type === 'actions' ? b.elements : []));
    const voteButtons = buttons.filter((e: any) => e.action_id.startsWith(POLL_ACTION_VOTE_PREFIX));
    expect(voteButtons.map((e: any) => e.action_id)).toEqual([
      `${POLL_ACTION_VOTE_PREFIX}0`,
      `${POLL_ACTION_VOTE_PREFIX}1`,
      `${POLL_ACTION_VOTE_PREFIX}2`,
    ]);
    expect(voteButtons.map((e: any) => e.text.text)).toEqual(['1. 김치찌개 · 1', '2. 된장찌개 · 2', '3. 제육볶음 · 0']);
    expect(voteButtons.every((e: any) => e.value === 'poll_1')).toBe(true);
    expect(voteButtons.every((e: any) => e.text.text.length <= 75)).toBe(true);
  });

  it('shows counts and total but never voter ids while open', () => {
    const msg = buildOpenPollMessage(poll({ votes: { UAAA: 1, UBBB: 0 } }));
    const json = allText(msg.blocks) + msg.text;
    expect(json).not.toContain('UAAA');
    expect(json).not.toContain('UBBB');
    expect(json).toContain('2명');
    expect(json).toContain('10/02 12:50 KST');
  });

  it('carries owner-only close/cancel buttons and the creator mention, and a fallback text', () => {
    const msg = buildOpenPollMessage(poll());
    const ids = msg.blocks.flatMap((b: any) => (b.type === 'actions' ? b.elements.map((e: any) => e.action_id) : []));
    expect(ids).toContain(POLL_ACTION_CLOSE);
    expect(ids).toContain(POLL_ACTION_CANCEL);
    expect(allText(msg.blocks)).toContain('<@UCREATOR>');
    expect(msg.text.length).toBeGreaterThan(0);
  });

  it('escapes user-supplied title/options so they cannot become mentions or links', () => {
    const msg = buildOpenPollMessage(poll({ title: '<!channel> 점심', options: ['<@UEVIL>', 'ok'] }));
    const json = allText(msg.blocks);
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('&lt;!channel&gt;');
  });
});

describe('buildClosedPollMessage', () => {
  it('lists every option in original order with count and voter mentions, "-" for empty, no ranking, no buttons', () => {
    const msg = buildClosedPollMessage(poll({ status: 'closed', votes: { UA: 1, UB: 1, UC: 0 } }));
    const blocks = msg.blocks;
    expect(blocks.some((b: any) => b.type === 'actions')).toBe(false);
    const sections = blocks.filter((b: any) => b.type === 'section').map((b: any) => b.text.text);
    const optionSections = sections.filter((t: string) => /^\*\d+\./.test(t));
    expect(optionSections[0]).toContain('1. 김치찌개');
    expect(optionSections[0]).toContain('<@UC>');
    expect(optionSections[1]).toContain('2. 된장찌개');
    expect(optionSections[1]).toContain('<@UA>');
    expect(optionSections[1]).toContain('<@UB>');
    expect(optionSections[2]).toContain('3. 제육볶음');
    expect(optionSections[2]).toContain('-');
    const json = allText(blocks);
    expect(json).not.toMatch(/1위|순위/);
    expect(json).toContain('총 3명');
    expect(msg.text.length).toBeGreaterThan(0);
  });

  it('huge roster: card stays within Slack limits and card+notices together never drop a voter', () => {
    const votes: Record<string, number> = {};
    for (let i = 0; i < 3000; i++) votes[`U${String(i).padStart(9, '0')}`] = i % 20;
    const options = Array.from({ length: 20 }, (_, i) => `메뉴${i + 1}`);
    const p = poll({ status: 'closed', options, votes });
    const card = buildClosedPollMessage(p);
    expect(card.blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
    for (const b of card.blocks) {
      if (b.type === 'section') expect(b.text.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    }
    const notices = buildResultNotices(p);
    for (const n of notices) expect(n.text.length).toBeLessThanOrEqual(40_000);
    const noticeText = notices.map((n) => n.text).join('\n');
    for (const u of Object.keys(votes)) expect(noticeText).toContain(`<@${u}>`);
    // option order preserved in the notice roster
    expect(noticeText.indexOf('1. 메뉴1 ')).toBeLessThan(noticeText.indexOf('20. 메뉴20 '));
  });

  it('splits a single long option section instead of exceeding 2900 chars', () => {
    const votes: Record<string, number> = {};
    for (let i = 0; i < 400; i++) votes[`U${String(i).padStart(9, '0')}`] = 0;
    const card = buildClosedPollMessage(poll({ status: 'closed', votes }));
    const sections = card.blocks.filter((b: any) => b.type === 'section');
    for (const b of sections) expect(b.text.text.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    const json = allText(card.blocks);
    for (const u of Object.keys(votes)) expect(json).toContain(`<@${u}>`);
  });

  it('is deterministic (same input → identical output) so delivery retries resume correctly', () => {
    const p = poll({ status: 'closed', votes: { UB: 0, UA: 0 } });
    expect(buildClosedPollMessage(p)).toEqual(buildClosedPollMessage(p));
    expect(buildResultNotices(p)).toEqual(buildResultNotices(p));
  });
});

describe('buildCanceledPollMessage / buildResultNotices', () => {
  it('canceled card reveals no voter ids and has no buttons', () => {
    const msg = buildCanceledPollMessage(poll({ status: 'canceled', votes: { UA: 0 } }));
    expect(allText(msg.blocks)).not.toContain('UA');
    expect(msg.blocks.some((b: any) => b.type === 'actions')).toBe(false);
  });

  it('notice text carries the per-option roster with mentions (edited cards do not notify)', () => {
    const notices = buildResultNotices(poll({ status: 'closed', votes: { UA: 0, UB: 2 } }));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('1. 김치찌개');
    expect(notices[0].text).toContain('<@UA>');
    expect(notices[0].text).toContain('3. 제육볶음');
    expect(notices[0].text).toContain('<@UB>');
  });

  it('notice for a poll with no voters says so and mentions nobody', () => {
    const notices = buildResultNotices(poll({ status: 'closed', votes: {} }));
    expect(notices[0].text).not.toContain('<@');
    expect(notices[0].text).toContain('투표한 사람이 없습니다');
  });
});
