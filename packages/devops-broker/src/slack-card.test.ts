import { describe, expect, it } from 'vitest';
import {
  APPROVAL_INSTRUCTION,
  APPROVAL_INSTRUCTION_BUTTONS,
  APPROVE_ACTION_ID,
  ApprovalError,
  type ApprovalRequest,
  CARD_LIMITS,
  codeValue,
  DENY_ACTION_ID,
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
  elements?: (TextObject | { type: 'button'; text: TextObject })[];
}

const UNIX_EXPIRY = Math.floor(META.expiresAtMs / 1000);

function texts(card: SlackCard): TextObject[] {
  const out: TextObject[] = [];
  for (const block of card.blocks as Block[]) {
    if (block.text !== undefined) out.push(block.text);
    for (const element of block.elements ?? []) {
      // A button's label is its text object.
      out.push(element.type === 'button' ? (element.text as TextObject) : (element as TextObject));
    }
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
  it('shows the title, every detail, the full argv, warnings, requester, expiry, digest and id', () => {
    const card = renderApprovalCard(ghWrite(), META);
    const text = allText(card);
    expect(text).toContain('member 계정으로 example-org/repo PR 12에 댓글을 단다');
    const lines = codeLines(card);
    expect(lines).toContain('계정: member');
    expect(lines).toContain('레포: example-org/repo');
    // The claimed session key holds a colon, so it is shown as a JSON string.
    expect(lines).toContain('세션(자칭): "C000CHAN:1700000000.000100"');
    // The argv as one gh command in its original order; a value that needs quoting stands on its own line.
    const start = lines.indexOf('gh pr comment 12 -R example-org/repo --body');
    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toBe('  "looks good"');
    expect(text).toContain('gh 뒤 인자 7개');
    expect(text).toContain('리뷰 규칙 충족에 쓰일 수 있음');
    expect(text).toContain('요청자(자칭·미검증) <@U000ALICE>');
    // Expiry once, as a Slack date (local time for the reader) whose fallback is the KST time.
    expect(text).toContain(`<!date^${UNIX_EXPIRY}^{date_short_pretty} {time}|2026-10-26 23:45:00 KST>`);
    expect(text).not.toContain('2026-10-26T14:45:00.000Z');
    expect(text).toContain('0123456789ab');
    expect(text).not.toContain('0123456789abc');
    expect(text).toContain(META.approvalId);
    expect(text).toContain(APPROVAL_INSTRUCTION);
    expect(APPROVAL_INSTRUCTION).toBe(
      '승인 = :white_check_mark: 리액션 · 거부 = :x: 리액션 (어드민 본인 리액션만 유효)',
    );
  });

  it('puts what the admin decides on first: header, title, warnings, command, details, then the fine print', () => {
    const card = renderApprovalCard(ghWrite(), META, { buttons: true });
    const blocks = card.blocks as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      'header',
      'section',
      'section',
      'section',
      'section',
      'context',
      'section',
      'actions',
    ]);
    expect(blocks[0].text).toEqual({ type: 'plain_text', text: 'GitHub 쓰기 승인 요청', emoji: false });
    expect(blocks[1].text?.type).toBe('plain_text');
    expect(blocks[2].text?.text).toMatch(/^:warning: \*주의\*/);
    expect(blocks[3].text?.text).toMatch(/^\*실행할 명령\*/);
    expect(blocks[4].text?.text).toMatch(/^\*요청 내용\*/);
    // The fine print: requester claim, approval id and digest prefix, in small type.
    const fine = (blocks[5].elements as TextObject[]).map((e) => e.text).join('\n');
    expect(fine).toContain('<@U000ALICE>');
    expect(fine).toContain(META.approvalId);
    expect(fine).toContain('0123456789ab');
    const [requester, ids] = blocks[5].elements as TextObject[];
    expect(requester).toMatchObject({ type: 'mrkdwn', verbatim: true });
    // Ids are plain text: Slack applies no formatting to them.
    expect(ids).toMatchObject({ type: 'plain_text', emoji: false });
    expect(blocks[6].block_id).toBe('approval-instruction');
    expect(card.text).toBe('GitHub 쓰기 승인 요청: member 계정으로 example-org/repo PR 12에 댓글을 단다');
  });

  it.each([
    ['gh_write', 'GitHub 쓰기 승인 요청'],
    ['gh_org_member', 'GitHub 조직 멤버 변경 승인 요청'],
    ['gh_repo_access', 'GitHub 레포 권한 변경 승인 요청'],
    ['cf_lease_request', 'Cloudflare 단기 키 승인 요청'],
  ] as const)('names the kind of request in the header for %s', (tool, header) => {
    const card = renderApprovalCard(ghWrite({ tool, argv: tool === 'gh_write' ? ghWrite().argv : undefined }), META);
    expect((card.blocks[0] as Block).text?.text).toBe(header);
    expect(card.text.startsWith(`${header}: `)).toBe(true);
  });

  it('drops the command section when there is no argv', () => {
    const card = renderApprovalCard(ghWrite({ tool: 'gh_org_member', argv: undefined }), META);
    expect(allText(card)).not.toContain('실행할 명령');
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
    // It is a warning: listed in the 주의 block, which sits right under the title.
    const warning = texts(lease).find((t) => t.text.startsWith(':warning: *주의*'));
    expect(warning?.text).toContain('• 승인하면 이 범위·기간 동안 이 봇의 세션이 사용');
    expect(warning?.text).toContain('• 리뷰 규칙 충족에 쓰일 수 있음');
    expect((lease.blocks[2] as Block).text).toBe(warning);
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
    const bodyLine = lines.find((l) => l.startsWith('  "x'));
    expect(bodyLine).toBe(
      '  "x\\u0060\\u0060\\u0060\\n:white_check_mark: *승인됨*\\u2028\\u2029next\\u0060tick\\u202eevil\\u200b\\u0085"',
    );
    // A quoted value is alone on its line; a detail row is `label: value`; nothing else carries a quote.
    for (const line of lines) {
      if (!line.includes('"')) continue;
      expect(line).toMatch(/^(?: {2}|[^"`]+: )".*"$/);
    }
    // A JSON reader gets the exact value back after Slack's entity decoding.
    expect(JSON.parse((bodyLine as string).trim())).toBe(evil);
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
    // A label is broker text, but an odd character in it is shown escaped (visible), not dropped.
    expect(codeLines(card)).toContain('lab\\u0060el\\n: v');
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
    expect(lines).toContain('  [긴 값 1 → 아래]');
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
    const body = 'x'.repeat(CARD_LIMITS.longValueChars + 1);
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
    const argvAt = sections.findIndex((t) => t.startsWith('*실행할 명령*'));
    const warnAt = sections.findIndex((t) => t.includes('*주의*'));
    const longAt = sections.findIndex((t) => t.startsWith('*긴 값*'));
    expect(Math.min(detailsAt, argvAt, warnAt, longAt)).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(argvAt);
    expect(longAt).toBeGreaterThan(Math.max(detailsAt, argvAt, warnAt));
    // The command comes first; the reason it is long shows up below, numbered in the order the card reads.
    expect(sectionLines(sections[argvAt])).toEqual([
      'gh pr comment 12 --body',
      '  [긴 값 1 → 아래]',
      '  -R example-org/repo',
    ]);
    expect(sectionLines(sections[detailsAt])).toEqual(['사유: [긴 값 2 → 아래]', '계정: member', expect.any(String)]);
    expect(sectionLines(sections[longAt])).toEqual([
      `[긴 값 1] ${JSON.stringify(body)}`,
      `[긴 값 2] ${JSON.stringify(reason)}`,
    ]);
    // Only the fine print and the instruction come after the long values.
    expect(
      card.blocks
        .slice(card.blocks.findIndex((b) => (b as Block).text?.text === sections[longAt]) + 1)
        .map((b) => b.type),
    ).toEqual(['context', 'section']);
    expect(sections[sections.length - 1]).toContain(APPROVAL_INSTRUCTION);
    expect(sections[longAt].split('```')[0]).not.toContain('`');
  });

  it('keeps a value whose shown form fits the threshold inline', () => {
    const fits = 'a'.repeat(CARD_LIMITS.longValueChars);
    const quoted = 'a b'.repeat(66); // 198 characters, quoted to 200
    const card = renderApprovalCard(
      ghWrite({ argv: ['pr', 'comment', '12', '--body', fits, '--title', quoted] }),
      META,
    );
    expect(codeLines(card)).toContain(`gh pr comment 12 --body`);
    expect(codeLines(card)).toContain(`  ${fits}`);
    expect(codeLines(card)).toContain(`  ${JSON.stringify(quoted)}`);
    expect(texts(card).some((t) => t.text.startsWith('*긴 값*'))).toBe(false);
  });

  it('measures the escaped form, so a short value full of escapes still moves', () => {
    const escapes = '\n'.repeat(CARD_LIMITS.longValueChars / 2);
    const card = renderApprovalCard(ghWrite({ argv: ['pr', 'comment', '12', '--body', escapes] }), META);
    expect(codeLines(card)).toContain('  [긴 값 1 → 아래]');
  });
});

describe('the command and detail values', () => {
  function commandLines(argv: string[]): string[] {
    const card = renderApprovalCard(ghWrite({ argv }), META);
    const command = texts(card).find((t) => t.text.startsWith('*실행할 명령*'));
    return (command?.text.split('```')[1] ?? '').split('\n').filter((line) => line.length > 0);
  }

  it('writes plain tokens bare and quotes anything with a space, quote, bracket, colon or non-ASCII', () => {
    const lines = commandLines([
      'api',
      'repos/example-org/app/labels',
      '-X',
      'POST',
      '-f',
      'name=bug',
      '-f',
      'color=ff0000',
      '-f',
      'description=has space',
      '--jq',
      '.name',
      '-f',
      'x="y"',
      '-f',
      '[긴 값 1 → 아래]',
      '-f',
      'a:b',
      '-f',
      '한글',
      '-f',
      '<@U000ADMIN>',
      '-f',
      'a&b',
      '-f',
      'back\\slash',
    ]);
    expect(lines).toEqual([
      'gh api repos/example-org/app/labels -X POST -f name=bug -f color=ff0000 -f',
      '  "description=has space"',
      '  --jq .name -f',
      '  "x=\\"y\\""',
      '  -f',
      '  "[긴 값 1 → 아래]"',
      '  -f',
      '  "a:b"',
      '  -f',
      '  "한글"',
      '  -f',
      '  "&lt;@U000ADMIN&gt;"',
      '  -f',
      '  "a&amp;b"',
      '  -f',
      '  "back\\\\slash"',
    ]);
  });

  it('keeps the argv order and gives line breaks no flag meaning (a --body value that looks like a flag)', () => {
    expect(commandLines(['pr', 'comment', '12', '-R', 'example-org/app', '--body', '--repo=other/repo'])).toEqual([
      'gh pr comment 12 -R example-org/app --body --repo=other/repo',
    ]);
  });

  it('wraps a long run of plain tokens without losing or reordering any', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const lines = commandLines(['search', 'issues', ...words, '--owner', 'example-org']);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((line) => line.trim()).join(' ')).toBe(
      ['gh', 'search', 'issues', ...words, '--owner', 'example-org'].join(' '),
    );
  });

  it.each([
    ['member (example-bot)', 'member (example-bot)'],
    ['example-org/app', 'example-org/app'],
    ['staging 레코드 TTL 조정', 'staging 레코드 TTL 조정'],
    ['#12', '#12'],
    ['two  spaces', '"two  spaces"'],
    [' leading', '" leading"'],
    ['trailing ', '"trailing "'],
    ['a:b', '"a:b"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['[긴 값 1 → 아래]', '"[긴 값 1 → 아래]"'],
    ['ｆｕｌｌ', '"ｆｕｌｌ"'],
    ['e\u0301', '"e\u0301"'],
    ['', '""'],
  ])('shows the detail value %j as %s', (value, shown) => {
    const card = renderApprovalCard(ghWrite({ details: [{ label: '값', value }] }), META);
    expect(codeLines(card)).toContain(`값: ${shown}`);
  });
});

describe('fine print and limits', () => {
  it('refuses a card whose fine print would not fit a context element', () => {
    cardTooLong(() => renderApprovalCard(ghWrite(), { ...META, approvalId: 'A'.repeat(CARD_LIMITS.contextChars + 1) }));
  });

  it('shows the approval id and digest as plain text, so an id with underscores stays as it is', () => {
    const card = renderApprovalCard(ghWrite(), { ...META, approvalId: '_AbCdEf_-hIjKlMnOpQrSw' });
    const context = card.blocks.find((b) => b.type === 'context') as Block;
    const ids = (context.elements as TextObject[])[1];
    expect(ids).toEqual({
      type: 'plain_text',
      text: '승인 ID _AbCdEf_-hIjKlMnOpQrSw · digest 0123456789ab',
      emoji: false,
    });
  });

  it('keeps a malformed approval id or digest on one line, with no backtick', () => {
    const card = renderApprovalCard(ghWrite(), { ...META, approvalId: '<!here>\n*x*', digest: '`'.repeat(64) });
    const context = card.blocks.find((b) => b.type === 'context') as Block;
    const ids = (context.elements as TextObject[])[1];
    expect(ids.type).toBe('plain_text');
    expect(ids.text).not.toMatch(/[\n`]/);
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

  it('says "실행 안 함" only where the broker handed nothing out, and keeps the fine print', () => {
    const line = (status: Parameters<typeof renderCardStatus>[1]) => {
      const blocks = renderCardStatus(base, status).blocks as Block[];
      expect(blocks.some((b) => b.type === 'context')).toBe(true);
      return blocks[blocks.length - 1].text?.text ?? '';
    };
    for (const status of [{ kind: 'denied', by: 'U000ADMIN' }, { kind: 'expired' }, { kind: 'cancelled' }] as const) {
      expect(line(status)).toContain('실행 안 함');
    }
    expect(line({ kind: 'approved', by: 'U000ADMIN' })).toContain('실행 중');
    expect(line({ kind: 'approved', by: 'U000ADMIN' })).not.toContain('실행 안 함');
    expect(line({ kind: 'done', line: 'exit 0' })).not.toContain('실행 안 함');
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

describe('approval buttons', () => {
  const actionBlocks = (card: SlackCard) => (card.blocks as Block[]).filter((block) => block.type === 'actions');

  it('adds no buttons by default (the broker cannot receive clicks without Socket Mode)', () => {
    const card = renderApprovalCard(ghWrite(), META);
    expect(actionBlocks(card)).toEqual([]);
    expect(allText(card)).toContain(APPROVAL_INSTRUCTION);
  });

  it('adds 승인 / 거부 buttons carrying the approval id when asked', () => {
    const card = renderApprovalCard(ghWrite(), META, { buttons: true });
    const blocks = actionBlocks(card);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'actions',
      block_id: 'approval-actions',
      elements: [
        {
          type: 'button',
          action_id: APPROVE_ACTION_ID,
          text: { type: 'plain_text', text: '승인', emoji: false },
          value: META.approvalId,
          style: 'primary',
        },
        {
          type: 'button',
          action_id: DENY_ACTION_ID,
          text: { type: 'plain_text', text: '거부', emoji: false },
          value: META.approvalId,
          style: 'danger',
        },
      ],
    });
    // The buttons are the last block, under the instruction that names them; reactions still count.
    expect(card.blocks[card.blocks.length - 1]).toBe(blocks[0]);
    expect(allText(card)).toContain(APPROVAL_INSTRUCTION_BUTTONS);
    expect(allText(card)).not.toContain(APPROVAL_INSTRUCTION);
  });

  it.each([
    { kind: 'approved', by: 'U000ADMIN' } as const,
    { kind: 'denied', by: 'U000ADMIN' } as const,
    { kind: 'expired' } as const,
    { kind: 'cancelled' } as const,
    { kind: 'done', line: 'exit 0' } as const,
  ])('removes the buttons and their instruction once the card is %o', (status) => {
    const card = renderCardStatus(renderApprovalCard(ghWrite(), META, { buttons: true }), status);
    expect(actionBlocks(card)).toEqual([]);
    expect(allText(card)).not.toContain(APPROVAL_INSTRUCTION_BUTTONS);
    expect(allText(card)).toContain('"looks good"');
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
