import { describe, expect, it } from 'vitest';
import { extractNextActions, nextActionsOfTurn } from '../next-actions';

/**
 * Next actions as buttons (SSOT 2026-11-11, Z): "이렇게 대화 완료(대기)처리된후에 다음 행동을 3개씩 주는데 이걸
 * 버튼으로 표현해줘. 카드 펼쳤을때랑 디테일에 버튼으로 보여줘."
 *
 * The Executive Summary ends with Next Actions: up to 3 (epic: 5) steps, each a fenced block (es templates,
 * summary-service MODE_TEMPLATES). The server reads them out of an answer so the card and the detail card can draw
 * them as buttons.
 */

const FENCE = '```';

// The answer in the screenshot (a model-run auto-es, Korean).
const SCREENSHOT = [
  '## 위험',
  '- 🔶 dev/prod에는 아직 반영되지 않았습니다.',
  '',
  '## 다음 행동',
  'dev에 배포해서 실제 대시보드에서 확인합니다(권장):',
  '',
  FENCE,
  '$user:dev',
  FENCE,
  '',
  '확인 후 prod에 배포합니다:',
  '',
  FENCE,
  '$user:prod',
  FENCE,
  '',
  '후속 이슈를 진행합니다:',
  '',
  FENCE,
  '1193 진행',
  FENCE,
  '',
  'Card check: 7/7 on the card',
].join('\n');

describe('extractNextActions', () => {
  it('reads the screenshot answer: three actions, the label above each block, (권장) as recommended', () => {
    expect(extractNextActions(SCREENSHOT)).toEqual([
      { label: 'dev에 배포해서 실제 대시보드에서 확인합니다', command: '$user:dev', recommended: true },
      { label: '확인 후 prod에 배포합니다', command: '$user:prod' },
      { label: '후속 이슈를 진행합니다', command: '1193 진행' },
    ]);
  });

  it('reads a numbered English section with indented fences and a language tag', () => {
    const md = [
      '### 4. Next Actions',
      '1. **Deploy to dev** (recommended):',
      `   ${FENCE}bash`,
      '   $user:dev',
      `   ${FENCE}`,
      '2. Open the follow-up issue:',
      `   ${FENCE}`,
      '   1193 진행',
      `   ${FENCE}`,
    ].join('\n');
    expect(extractNextActions(md)).toEqual([
      { label: 'Deploy to dev', command: '$user:dev', recommended: true },
      { label: 'Open the follow-up issue', command: '1193 진행' },
    ]);
  });

  it('takes a bold line as the heading too', () => {
    const md = ['**Next Actions**', FENCE, 'gh pr merge 830 --squash', FENCE].join('\n');
    expect(extractNextActions(md)).toEqual([{ label: '', command: 'gh pr merge 830 --squash' }]);
  });

  it('stops at the next heading: the ⚠️ follow-up section after it is not a next action', () => {
    const md = [
      '## Next Actions',
      'Merge it:',
      FENCE,
      '$user:dev',
      FENCE,
      '## ⚠️ User follow-up required',
      'Steps:',
      FENCE,
      'gh pr merge 830 --squash',
      FENCE,
    ].join('\n');
    expect(extractNextActions(md)).toEqual([{ label: 'Merge it', command: '$user:dev' }]);
  });

  it('a bold heading section ends at the next bold heading', () => {
    const md = ['**다음 행동**', FENCE, 'a', FENCE, '**⚠️ User follow-up required**', FENCE, 'b', FENCE].join('\n');
    expect(extractNextActions(md)).toEqual([{ label: '', command: 'a' }]);
  });

  it('ignores blocks outside the section and a heading inside a code block', () => {
    const md = ['## Summary', FENCE, '## Next Actions', 'not a heading', FENCE, FENCE, 'npm test', FENCE].join('\n');
    expect(extractNextActions(md)).toEqual([]);
  });

  it('nothing without the section, and nothing for empty input', () => {
    expect(extractNextActions('just an answer\n```\nnpm test\n```')).toEqual([]);
    expect(extractNextActions('')).toEqual([]);
    expect(extractNextActions(undefined)).toEqual([]);
  });

  it('the last section wins', () => {
    const md = ['## Next Actions', FENCE, 'old', FENCE, '## Status', 'x', '## 다음 단계', FENCE, 'new', FENCE].join(
      '\n',
    );
    expect(extractNextActions(md)).toEqual([{ label: '', command: 'new' }]);
  });

  it('keeps at most five, skips an empty block and one too long to be a step', () => {
    const blocks = ['1', '', '2', 'x'.repeat(2001), '3', '4', '5', '6'];
    const md = ['## Next Actions', ...blocks.flatMap((b) => [FENCE, b, FENCE])].join('\n');
    expect(extractNextActions(md).map((a) => a.command)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('a multi-line block is kept whole, dedented; a label is cut to 120 characters', () => {
    const md = [
      '## Next Actions',
      `- ${'긴 설명 '.repeat(40)}:`,
      `  ${FENCE}`,
      '  cd x',
      '  npm test',
      `  ${FENCE}`,
    ].join('\n');
    const [a] = extractNextActions(md);
    expect(a.command).toBe('cd x\nnpm test');
    expect(Array.from(a.label).length).toBeLessThanOrEqual(120);
    expect(a.label.endsWith('…')).toBe(true);
  });

  it('inline code and links in a label read as their text', () => {
    const md = ['## Next Actions', '- Run `local:zcheck` on [PR #12](https://x/pull/12):', FENCE, 'zcheck', FENCE].join(
      '\n',
    );
    expect(extractNextActions(md)).toEqual([{ label: 'Run local:zcheck on PR #12', command: 'zcheck' }]);
  });
});

describe('trinity R1 — the follow-up section, labels, unclosed blocks', () => {
  const FOLLOW = ['Steps:', FENCE, 'gh pr merge 830 --squash', FENCE, FENCE, 'gh pr view 830 --json state', FENCE];

  it('the template shape: `### N. Next Actions` then a bold ⚠️ follow-up title — the user’s own commands stay out', () => {
    const md = [
      '### 6. Next Actions',
      'Deploy:',
      FENCE,
      '$user:dev',
      FENCE,
      '**⚠️ User follow-up required**',
      ...FOLLOW,
    ];
    expect(extractNextActions(md.join('\n'))).toEqual([{ label: 'Deploy', command: '$user:dev' }]);
  });

  it('a deeper ATX follow-up title, an emoji-first plain title and a Korean one end it too', () => {
    for (const title of [
      '### ⚠️ User follow-up required',
      '⚠️ User follow-up required',
      'User follow-up required:',
      '## ⚠️ 후속 조치 필요',
    ]) {
      const md = ['## 다음 행동', FENCE, 'a', FENCE, title, ...FOLLOW].join('\n');
      expect(extractNextActions(md)).toEqual([{ label: '', command: 'a' }]);
    }
  });

  it('a bold step label right above its block is a label, not the end of a bold-titled section', () => {
    const md = [
      '**다음 행동**',
      '**1. 머지 (권장)**',
      FENCE,
      'gh pr merge 1',
      FENCE,
      '**2. 보류**',
      FENCE,
      'hold',
      FENCE,
    ];
    expect(extractNextActions(md.join('\n'))).toEqual([
      { label: '1. 머지', command: 'gh pr merge 1', recommended: true },
      { label: '2. 보류', command: 'hold' },
    ]);
  });

  it('Slack-style *title* and an emoji before the step number read as the title', () => {
    expect(extractNextActions(['*다음 행동*', FENCE, 'a', FENCE].join('\n'))).toEqual([{ label: '', command: 'a' }]);
    expect(extractNextActions(['### 🚀 4. Next Actions (3)', FENCE, 'b', FENCE].join('\n'))).toEqual([
      { label: '', command: 'b' },
    ]);
  });

  it('a block whose closing fence never comes is not a step (a cut-off answer)', () => {
    const md = ['### Next Actions', 'ok:', FENCE, 'a', FENCE, 'cut:', FENCE, 'cmd', '', '### After', 'text'].join('\n');
    expect(extractNextActions(md)).toEqual([{ label: 'ok', command: 'a' }]);
  });
});

describe('trinity R1 — never slow (P1: a heading regex stalled the server)', () => {
  const ms = (f: () => void) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it.each([
    ['a heading with a long run of spaces', `# a${' '.repeat(20000)}x\n## Next Actions\n${FENCE}\na\n${FENCE}`],
    ['a long bold line', `**${'x'.repeat(20000)}\n## Next Actions\n${FENCE}\na\n${FENCE}`],
    ['a label of 40k brackets', `## Next Actions\n${'['.repeat(40000)}\n${FENCE}\na\n${FENCE}`],
    ['a label of 40k backticks and spaces', `## Next Actions\n${'` '.repeat(20000)}(\n${FENCE}\na\n${FENCE}`],
    ['a long rule-like line', `## Next Actions\n${'- '.repeat(20000)}x\n${FENCE}\na\n${FENCE}`],
    ['a long recommended-like run', `## Next Actions\n${' '.repeat(20000)}(권장x\n${FENCE}\na\n${FENCE}`],
  ])('%s: under 50 ms', (_name, md) => {
    extractNextActions(md);
    expect(ms(() => extractNextActions(md))).toBeLessThan(50);
  });

  it('a turn is read once: the same turn object answers from memory', () => {
    const turn = { rawContent: `## Next Actions\n${FENCE}\na\n${FENCE}` };
    const first = nextActionsOfTurn(turn);
    expect(first).toEqual([{ label: '', command: 'a' }]);
    expect(nextActionsOfTurn(turn)).toBe(first);
    // its text changed (it never does for a recorded answer, but say so): read again
    turn.rawContent = `## Next Actions\n${FENCE}\nb\n${FENCE}`;
    expect(nextActionsOfTurn(turn)).toEqual([{ label: '', command: 'b' }]);
    expect(nextActionsOfTurn({ rawContent: 'none' })).toBeUndefined();
  });
});

describe('trinity R2 — non-blocking hardening (fable P2 · P3)', () => {
  it('any ⚠️ title ends the section, reworded or numbered — the contract reserves the mark', () => {
    for (const title of ['**⚠️ 사용자 조치 필요**', '**⚠️ User follow-up required (1)**', '#### ⚠️ 직접 하실 일']) {
      const md = ['### 다음 행동', FENCE, 'a', FENCE, title, '실행:', FENCE, 'gh pr merge 830', FENCE].join('\n');
      expect(extractNextActions(md)).toEqual([{ label: '', command: 'a' }]);
    }
  });

  it('a `*` bullet that ends in bold is a step label, not a title', () => {
    const md = ['**Next Actions**', '* note **x**', '* do **a**', FENCE, 'a', FENCE].join('\n');
    expect(extractNextActions(md)).toEqual([{ label: 'do a', command: 'a' }]);
  });
});
