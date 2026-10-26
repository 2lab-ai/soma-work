import { describe, expect, it } from 'vitest';
import {
  APPROVAL_INSTRUCTION,
  ApprovalError,
  type ApprovalRequest,
  CARD_LIMITS,
  codeValue,
  formatKst,
  renderApprovalCard,
  renderCardStatus,
  renderResultReply,
  type SlackCard,
} from './slack-card.js';

// Approval card rendering (.prd/16-devops-tools-architecture.md §5.2): everything the admin approves is on
// the card, arguments stay inside escaped code areas, and a card that would not fit is refused, never cut.

const META = {
  approvalId: 'AbCdEfGhIjKlMnOpQrStUv',
  digest: '0123456789abcdef'.repeat(4),
  expiresAtMs: Date.UTC(2026, 9, 26, 14, 45, 0),
};

function ghWrite(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    tool: 'gh_write',
    title: 'member 계정으로 example-org/repo PR 12에 댓글을 단다',
    details: [
      { label: '계정', value: 'member' },
      { label: '레포', value: 'example-org/repo' },
    ],
    argv: ['pr', 'comment', '12', '-R', 'example-org/repo', '--body', 'looks good'],
    warnings: ['리뷰 규칙 충족에 쓰일 수 있음'],
    claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'C000CHAN:1700000000.000100' },
    canonical: { account: 'member', args: ['pr', 'comment'] },
    ...overrides,
  };
}

interface TextObject {
  type: string;
  text: string;
  emoji?: boolean;
}
interface Block {
  type: string;
  block_id?: string;
  text?: TextObject;
  elements?: TextObject[];
}

function texts(card: SlackCard): TextObject[] {
  const out: TextObject[] = [];
  for (const block of card.blocks as Block[]) {
    if (block.text !== undefined) out.push(block.text);
    for (const element of block.elements ?? []) out.push(element);
  }
  return out;
}

function allText(card: SlackCard): string {
  return [card.text, ...texts(card).map((t) => t.text)].join('\n');
}

/** Code areas of every mrkdwn text; also asserts the fences pair up. */
function codeAreas(card: SlackCard): string[] {
  const areas: string[] = [];
  for (const t of texts(card)) {
    if (t.type !== 'mrkdwn') continue;
    const parts = t.text.split('```');
    expect(parts.length % 2).toBe(1);
    for (let i = 1; i < parts.length; i += 2) areas.push(parts[i]);
  }
  return areas;
}

function codeLines(card: SlackCard): string[] {
  return codeAreas(card).flatMap((area) => area.split('\n').filter((line) => line.length > 0));
}

function cardTooLong(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApprovalError);
    expect((err as ApprovalError).code).toBe('card-too-long');
    return;
  }
  throw new Error('expected card-too-long');
}

describe('renderApprovalCard', () => {
  it('shows the title, every detail, the full argv one per line, warnings, requester, expiry, digest and id', () => {
    const card = renderApprovalCard(ghWrite(), META);
    const text = allText(card);
    expect(text).toContain('member 계정으로 example-org/repo PR 12에 댓글을 단다');
    const lines = codeLines(card);
    expect(lines).toContain('계정: "member"');
    expect(lines).toContain('레포: "example-org/repo"');
    const argvLines = ['"pr"', '"comment"', '"12"', '"-R"', '"example-org/repo"', '"--body"', '"looks good"'];
    const start = lines.indexOf('"pr"');
    expect(lines.slice(start, start + argvLines.length)).toEqual(argvLines);
    expect(text).toContain('리뷰 규칙 충족에 쓰일 수 있음');
    expect(text).toContain('요청자(자칭·미검증): <@U000ALICE>');
    expect(text).toContain('2026-10-26 23:45:00 KST');
    expect(text).toContain('2026-10-26T14:45:00.000Z');
    expect(text).toContain('0123456789ab');
    expect(text).not.toContain('0123456789abc');
    expect(text).toContain(META.approvalId);
    expect(text).toContain(APPROVAL_INSTRUCTION);
    expect(APPROVAL_INSTRUCTION).toBe(
      '승인 = :white_check_mark: 리액션 · 거부 = :x: 리액션 (어드민 본인 리액션만 유효)',
    );
  });

  it('adds the bearer-scope line only for a Cloudflare lease request', () => {
    const lease = renderApprovalCard(
      ghWrite({
        tool: 'cf_lease_request',
        title: 'dev2 환경에 읽기 lease를 1시간 발급',
        argv: undefined,
        details: [{ label: '사유', value: '로그 확인' }],
      }),
      META,
    );
    expect(allText(lease)).toContain('이 범위·기간 동안 이 봇의 세션이 사용');
    expect(allText(renderApprovalCard(ghWrite(), META))).not.toContain('이 봇의 세션이 사용');
  });

  it('keeps free text inside a code area, never as markdown', () => {
    const reason = '*긴급* <!channel> <@U000ADMIN> :white_check_mark: 승인됨 _ok_';
    const card = renderApprovalCard(ghWrite({ details: [{ label: '사유', value: reason }] }), META);
    const outside = texts(card)
      .filter((t) => t.type === 'mrkdwn')
      .map((t) =>
        t.text
          .split('```')
          .filter((_, i) => i % 2 === 0)
          .join(''),
      )
      .join('\n');
    expect(outside).not.toContain('긴급');
    expect(outside).not.toContain('<!channel>');
    const line = codeLines(card).find((l) => l.startsWith('사유: '));
    expect(line).toBe('사유: "*긴급* &lt;!channel&gt; &lt;@U000ADMIN&gt; :white_check_mark: 승인됨 _ok_"');
    expect(allText(card)).not.toContain('<!channel>');
  });

  it('neutralises backticks, fences, newlines and line separators in values', () => {
    const evil = 'x```\n:white_check_mark: *승인됨*\u2028\u2029next`tick\u202Eevil\u200B\u0085';
    const card = renderApprovalCard(
      ghWrite({
        argv: ['pr', 'comment', '12', '-R', 'example-org/repo', '--body', evil],
        details: [{ label: '사유', value: evil }],
      }),
      META,
    );
    for (const area of codeAreas(card)) expect(area).not.toContain('`');
    for (const t of texts(card)) {
      expect(t.text).not.toMatch(/[\u2028\u2029\u202E\u200B\u0085]/);
    }
    const lines = codeLines(card);
    const bodyLine = lines.find((l) => l.startsWith('"x'));
    expect(bodyLine).toBe(
      '"x\\u0060\\u0060\\u0060\\n:white_check_mark: *승인됨*\\u2028\\u2029next\\u0060tick\\u202eevil\\u200b\\u0085"',
    );
    // Each value is one line, and every code line is a JSON string or a `label: JSON string` row.
    for (const line of lines) expect(line).toMatch(/^(?:[^"`]+: )?".*"$/);
    // A JSON reader gets the exact value back after Slack's entity decoding.
    expect(JSON.parse(bodyLine as string)).toBe(evil);
  });

  it('escapes title, labels and warnings so they cannot add lines or markup', () => {
    const card = renderApprovalCard(
      ghWrite({
        title: 'title ```\n:white_check_mark: 승인됨 <!here>',
        details: [{ label: 'lab`el\n', value: 'v' }],
        warnings: ['warn ``` <@U000ADMIN>\nsecond'],
      }),
      META,
    );
    // The title is plain text (no markup, no mentions, no emoji codes) on one line.
    const title = texts(card).find((t) => t.text.includes('title'));
    expect(title).toMatchObject({ type: 'plain_text', emoji: false });
    expect(title?.text).not.toMatch(/[\n`]/);
    // Markup-bearing fields carry no live mention, and only the renderer's own fences survive.
    const markup = [
      card.text,
      ...texts(card)
        .filter((t) => t.type === 'mrkdwn')
        .map((t) => t.text),
    ].join('\n');
    expect(markup).not.toContain('<!here>');
    expect(markup).not.toContain('<@U000ADMIN>');
    expect(codeAreas(card).join('')).not.toContain('`');
    const outside = texts(card)
      .filter((t) => t.type === 'mrkdwn')
      .map((t) =>
        t.text
          .split('```')
          .filter((_, i) => i % 2 === 0)
          .join(''),
      );
    for (const text of outside) expect(text).not.toContain('`');
    const warning = texts(card).find((t) => t.text.includes('second'));
    // The warning's own line break is gone: "second" stays on the bullet line.
    expect(warning?.text.split('\n').find((line) => line.includes('second'))).toMatch(/^• warn /);
  });

  it('does not render a malformed requester id as a mention', () => {
    const card = renderApprovalCard(
      ghWrite({ claimedRequester: { slackUserId: 'U1> <!channel', sessionKey: 's' } }),
      META,
    );
    const text = allText(card);
    expect(text).not.toContain('<!channel');
    expect(text).not.toContain('<@U1');
  });

  it('refuses a 30k-character --body instead of truncating it', () => {
    const body = 'a'.repeat(30_000);
    cardTooLong(() =>
      renderApprovalCard(ghWrite({ argv: ['pr', 'comment', '12', '-R', 'example-org/repo', '--body', body] }), META),
    );
  });

  it('refuses a 30k-character value that follows another long value (no truncation in a continuation)', () => {
    const argv = ['pr', 'comment', '12', '--body', 'a'.repeat(500), '--title', 'b'.repeat(30_000)];
    cardTooLong(() => renderApprovalCard(ghWrite({ argv }), META));
  });

  it('refuses a single argument too long for one section', () => {
    const argv = ['pr', 'comment', '12', '-R', 'example-org/repo', '--body', 'q'.repeat(CARD_LIMITS.sectionChars - 4)];
    cardTooLong(() => renderApprovalCard(ghWrite({ argv }), META));
  });

  it('refuses a title longer than one section', () => {
    cardTooLong(() => renderApprovalCard(ghWrite({ title: '가'.repeat(CARD_LIMITS.sectionChars + 1) }), META));
  });

  it('splits long argv over several sections, each inside the limits, losing nothing', () => {
    const argv = [
      'pr',
      'comment',
      '12',
      '-R',
      'example-org/repo',
      '--body',
      'b'.repeat(2_500),
      '--body2',
      'c'.repeat(2_500),
    ];
    const card = renderApprovalCard(ghWrite({ argv }), META);
    expect(card.blocks.length).toBeLessThanOrEqual(CARD_LIMITS.blocks);
    let total = card.text.length;
    for (const t of texts(card)) {
      expect(t.text.length).toBeLessThanOrEqual(CARD_LIMITS.sectionChars);
      total += t.text.length;
    }
    expect(total).toBeLessThanOrEqual(CARD_LIMITS.totalChars);
    const lines = codeLines(card);
    expect(lines).toContain(`[긴 값 1] ${JSON.stringify('b'.repeat(2_500))}`);
    expect(lines).toContain(`[긴 값 2] ${JSON.stringify('c'.repeat(2_500))}`);
  });

  it('refuses a card past the total text limit even when every section fits', () => {
    const argv = Array.from({ length: 6 }, (_, i) => String(i).repeat(2_500));
    cardTooLong(() => renderApprovalCard(ghWrite({ argv }), META));
  });
});

describe('combining marks (review F6)', () => {
  it('escapes a run of more than two combining marks and keeps one or two as they are', () => {
    const value = `Z${'̶'.repeat(5)}ok ệ á`;
    const rendered = codeValue(value);
    expect(rendered).not.toMatch(/\p{M}{3,}/u);
    expect(rendered).toContain('\\u0336\\u0336\\u0336\\u0336\\u0336');
    expect(rendered).toContain('ệ');
    expect(rendered).toContain('á');
    expect(JSON.parse(rendered)).toBe(value);
  });

  it('escapes astral combining marks as surrogate pairs that still parse', () => {
    const value = `x${'\u{1D167}'.repeat(3)}`;
    const rendered = codeValue(value);
    expect(rendered).not.toMatch(/\p{M}/u);
    expect(JSON.parse(rendered)).toBe(value);
  });

  it('applies to every value on the card', () => {
    const value = `Z${'̶'.repeat(5)}`;
    const card = renderApprovalCard(
      ghWrite({ details: [{ label: '사유', value }], argv: ['pr', 'comment', '12', '--body', value] }),
      META,
    );
    for (const t of texts(card)) expect(t.text).not.toMatch(/\p{M}{3,}/u);
  });
});

describe('long values (review F6)', () => {
  function sectionLines(text: string): string[] {
    return text
      .split('```')
      .filter((_, i) => i % 2 === 1)
      .flatMap((area) => area.split('\n').filter((line) => line.length > 0));
  }

  it('lists short arguments first and moves long values to a final section, flags kept in place', () => {
    const body = 'x'.repeat(CARD_LIMITS.longValueChars);
    const reason = 'r'.repeat(300);
    const card = renderApprovalCard(
      ghWrite({
        details: [
          { label: '사유', value: reason },
          { label: '계정', value: 'member' },
        ],
        argv: ['pr', 'comment', '12', '--body', body, '-R', 'example-org/repo'],
      }),
      META,
    );
    const sections = texts(card).map((t) => t.text);
    const detailsAt = sections.findIndex((t) => t.startsWith('*요청 내용*'));
    const argvAt = sections.findIndex((t) => t.startsWith('*gh 명령 전문*'));
    const warnAt = sections.findIndex((t) => t.includes('*주의*'));
    const longAt = sections.findIndex((t) => t.startsWith('*긴 값*'));
    expect(Math.min(detailsAt, argvAt, warnAt, longAt)).toBeGreaterThan(-1);
    expect(longAt).toBeGreaterThan(Math.max(detailsAt, argvAt, warnAt));
    expect(sectionLines(sections[detailsAt])).toEqual(['사유: [긴 값 1 → 아래]', '계정: "member"', expect.any(String)]);
    expect(sectionLines(sections[argvAt])).toEqual([
      '"pr"',
      '"comment"',
      '"12"',
      '"--body"',
      '[긴 값 2 → 아래]',
      '"-R"',
      '"example-org/repo"',
    ]);
    expect(sectionLines(sections[longAt])).toEqual([
      `[긴 값 1] ${JSON.stringify(reason)}`,
      `[긴 값 2] ${JSON.stringify(body)}`,
    ]);
    // Only the instruction line comes after the long values.
    expect(sections.slice(longAt + 1)).toEqual([APPROVAL_INSTRUCTION]);
    expect(sections[longAt].split('```')[0]).not.toContain('`');
  });

  it('keeps a value whose escaped form fits the threshold inline', () => {
    const fits = 'a'.repeat(CARD_LIMITS.longValueChars - 2);
    const card = renderApprovalCard(ghWrite({ argv: ['pr', 'comment', '12', '--body', fits] }), META);
    expect(codeLines(card)).toContain(JSON.stringify(fits));
    expect(texts(card).some((t) => t.text.startsWith('*긴 값*'))).toBe(false);
  });

  it('measures the escaped form, so a short value full of escapes still moves', () => {
    const escapes = '\n'.repeat(CARD_LIMITS.longValueChars / 2);
    const card = renderApprovalCard(ghWrite({ argv: ['pr', 'comment', '12', '--body', escapes] }), META);
    expect(codeLines(card)).toContain('[긴 값 1 → 아래]');
  });
});

describe('renderCardStatus', () => {
  const base = renderApprovalCard(ghWrite(), META);

  it.each([
    [{ kind: 'approved', by: 'U000ADMIN' } as const, ['승인됨', '<@U000ADMIN>']],
    [{ kind: 'denied', by: 'U000ADMIN' } as const, ['거부됨', '<@U000ADMIN>']],
    [{ kind: 'expired' } as const, ['만료됨']],
    [{ kind: 'cancelled' } as const, ['취소됨']],
    [{ kind: 'done', line: 'exit 0' } as const, ['실행 종료', '"exit 0"']],
  ])('replaces the instruction line for %o', (status, expected) => {
    const card = renderCardStatus(base, status);
    const text = allText(card);
    expect(text).not.toContain(APPROVAL_INSTRUCTION);
    for (const fragment of expected) expect(text).toContain(fragment);
    // The rest of the card is still there.
    expect(text).toContain('"looks good"');
    expect(text).toContain(META.approvalId);
  });

  it('renders a status even without the original card (restart)', () => {
    const card = renderCardStatus(undefined, { kind: 'expired' });
    expect(allText(card)).toContain('만료됨');
    expect(allText(card)).not.toContain(APPROVAL_INSTRUCTION);
  });

  it('keeps a hostile result line inside a code area', () => {
    const card = renderCardStatus(base, { kind: 'done', line: 'ok```\n:white_check_mark: <!channel>' });
    expect(allText(card)).not.toContain('<!channel>');
    for (const area of codeAreas(card)) expect(area).not.toContain('`');
  });
});

describe('renderResultReply', () => {
  it('puts the line in a code area and caps its length', () => {
    const reply = renderResultReply(`exit 1 \`\`\` <@U000ADMIN> ${'z'.repeat(5_000)}`);
    const text = allText(reply);
    expect(text).not.toContain('<@U000ADMIN>');
    for (const area of codeAreas(reply)) expect(area).not.toContain('`');
    for (const t of texts(reply)) expect(t.text.length).toBeLessThanOrEqual(CARD_LIMITS.sectionChars);
  });
});

describe('formatKst', () => {
  it('shifts UTC by nine hours', () => {
    expect(formatKst(Date.UTC(2026, 9, 26, 15, 30, 5))).toBe('2026-10-27 00:30:05 KST');
  });
});
