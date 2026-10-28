import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';
import { getVerbosityFlags } from '../output-flags';

/**
 * T2 — the status area, presented the way Apple lays out a Live Activity
 * (2026-10-27, trinity-reviewed). The FACTS are unchanged; only how they are
 * shown moves:
 *
 *   - the status is ONE full-width `section.text` — never a 2-column `fields`
 *     grid that gave it half the width and wrapped "마지막 활 / 동 5분 전";
 *   - it sits directly under the first header block (title first, state
 *     second, metadata after), via {@link ActionPanelBuilder.compose};
 *   - colour circles 🟢🟡⚪⚫ mean session state and nothing else, and every
 *     badge is bold; PR state is a word behind the 🔀 kind glyph;
 *   - the log verbosity is a setting, shown as a plain code chip;
 *   - no dividers: the controls row ends the panel.
 */

const NOW = Date.UTC(2026, 9, 27, 3, 0, 0);
const MIN = 60_000;

function build(params: Partial<Parameters<typeof ActionPanelBuilder.build>[0]> = {}) {
  return ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params });
}

function sections(blocks: any[]): any[] {
  return blocks.filter((b) => b.type === 'section');
}

function railText(blocks: any[]): string {
  const [rail] = sections(blocks);
  return String(rail?.text?.text ?? '');
}

const SESSION_CIRCLES = /🟢|🟡|⚪|⚫/g;

describe('ActionPanelBuilder — T2 status rail', () => {
  it('renders the screenshot session (idle, PR merged) as one full-width rail, facts unchanged', () => {
    const { blocks } = build({
      workflow: 'pr-review',
      disabled: false,
      agentPhase: '사용자 액션 대기',
      lastProgressAt: NOW - 5 * MIN,
      turnSummary: '⏱ 0:09',
      latestResponseLink: 'https://slack.example/p1',
      logVerbosity: getVerbosityFlags('minimal'),
      prStatus: { state: 'merged', mergeable: false, draft: false, merged: true },
    });

    const [rail] = sections(blocks);
    expect(rail.fields).toBeUndefined();
    expect(rail.text.type).toBe('mrkdwn');
    expect(railText(blocks)).toBe(
      [
        '⚪ *사용 가능* · 사용자 액션 대기 · 마지막 활동 5분 전',
        '⏱ 0:09 · 🔀 Merged · <https://slack.example/p1|💬 최신 응답> · `minimal`',
      ].join('\n'),
    );
  });

  it('never uses a fields grid, whatever the state or PR', () => {
    const pr = { state: 'open', mergeable: true, draft: false, merged: false, approved: true };
    for (const state of [
      { activityState: 'working' as const },
      { activityState: 'idle' as const, disabled: false },
      { waitingForChoice: true },
      { closed: true },
    ]) {
      const { blocks } = build({ ...state, prStatus: pr, turnSummary: '⏱ 1:00 · 🛠 3' });
      expect(blocks.some((b: any) => Array.isArray(b.fields))).toBe(false);
    }
  });

  it('bolds every session badge and uses circles only on the badge', () => {
    const cases: Array<[Partial<Parameters<typeof ActionPanelBuilder.build>[0]>, string]> = [
      [{ disabled: false }, '⚪ *사용 가능*'],
      [{ activityState: 'working' }, '🟢 *작업 중*'],
      [{ hasActiveRequest: true }, '🟢 *요청 처리 중*'],
      [{ waitingForChoice: true }, '🟡 *입력 대기*'],
      [{ activityState: 'waiting' }, '⚪ *대기 중*'],
      [{ disabled: true }, '⚪ *대기*'],
      [{ closed: true }, '⚫ *종료됨*'],
    ];
    for (const [params, badge] of cases) {
      const text = railText(
        build({
          ...params,
          turnSummary: '⏱ 2:00 · 🛠 4',
          logVerbosity: getVerbosityFlags('detail'),
          prStatus: { state: 'closed', mergeable: false, draft: false, merged: false },
        }).blocks,
      );
      expect(text.startsWith(badge)).toBe(true);
      expect(text.match(SESSION_CIRCLES)).toHaveLength(1);
      expect(text).not.toContain('🔴');
    }
  });

  it('shows every PR state as a word behind 🔀, with no colour dot', () => {
    const cases: Array<[any, string]> = [
      [{ state: 'merged', merged: true, mergeable: false, draft: false }, '🔀 Merged'],
      [{ state: 'open', draft: true, merged: false, mergeable: false }, '🔀 Draft'],
      [{ state: 'closed', merged: false, mergeable: false, draft: false }, '🔀 Closed'],
      [{ state: 'open', approved: true, mergeable: true, merged: false, draft: false }, '🔀 Approved · Merge 가능'],
      [{ state: 'open', approved: true, mergeable: false, merged: false, draft: false }, '🔀 Approved'],
      [{ state: 'open', mergeable: true, merged: false, draft: false }, '🔀 Merge 가능'],
      [{ state: 'open', mergeable: false, merged: false, draft: false }, '🔀 ⚠️ Merge 불가'],
    ];
    for (const [prStatus, chip] of cases) {
      const text = railText(build({ disabled: false, prStatus }).blocks);
      expect(text).toContain(chip);
      expect(text).not.toMatch(/🟣|🔴|🟢 Merge|_Draft_|\*PR\*/);
    }
  });

  it('shows the log verbosity as a code chip, not an emoji', () => {
    for (const name of ['minimal', 'compact', 'detail', 'verbose'] as const) {
      const text = railText(build({ disabled: false, logVerbosity: getVerbosityFlags(name) }).blocks);
      expect(text).toContain(`\`${name}\``);
      expect(text).not.toMatch(/🔇|📎|📋|📢/);
    }
  });

  it('keeps the question prompt inside the rail, with no divider anywhere', () => {
    const { blocks } = build({
      waitingForChoice: true,
      lastProgressAt: NOW - MIN,
      choiceMessageLink: 'https://slack.example/q',
      turnSummary: '⏱ 1:30 · 🛠 4',
    });

    expect(sections(blocks)).toHaveLength(1);
    expect(railText(blocks).split('\n')).toEqual([
      '🟡 *입력 대기* · 마지막 활동 1분 전',
      '⏱ 1:30 · 🛠 4',
      '❓ 질문에 답변해 주세요 — <https://slack.example/q|질문 보기>',
    ]);
    expect(blocks.some((b: any) => b.type === 'divider')).toBe(false);
  });

  it('ends the live panel with the controls row and nothing in between', () => {
    const { blocks } = build({ activityState: 'working', turnSummary: '⏱ 4:02 · 🛠 17' });

    expect(blocks.map((b: any) => b.type)).toEqual(['section', 'actions']);
  });
});

describe('ActionPanelBuilder — T2 closed rail', () => {
  it('states 종료됨 once, in the rail, with the same facts the live rail carried', () => {
    const { blocks } = build({
      closed: true,
      turnSummary: '⏱ 4:02 · 🛠 17',
      latestResponseLink: 'https://slack.example/p9',
      prStatus: { state: 'merged', merged: true, mergeable: false, draft: false },
    });

    expect(blocks.map((b: any) => b.type)).toEqual(['section']);
    const [line1, line2] = railText(blocks).split('\n');
    expect(line1).toMatch(/^⚫ \*종료됨\* · \d{2}-\d{2} \d{2}:\d{2} 종료$/);
    expect(line2).toBe('⏱ 4:02 · 🛠 17 · 🔀 Merged · <https://slack.example/p9|💬 최신 응답>');
    expect(JSON.stringify(blocks).match(/종료됨/g)).toHaveLength(1);
  });

  it('keeps the turn summary verbatim instead of re-parsing it', () => {
    const odd = '⏱ 1h 02m · 🛠 3 (+2 sub)';
    const text = railText(build({ closed: true, turnSummary: odd }).blocks);

    expect(text.split('\n')[1]).toBe(odd);
  });

  it('uses the injected clock for the close timestamp', () => {
    const text = railText(build({ closed: true }).blocks);
    const d = new Date(NOW);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(text).toContain(
      `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 종료`,
    );
  });
});

describe('ActionPanelBuilder.compose — T2 insertion rule', () => {
  const title = { type: 'header', text: { type: 'plain_text', text: 'PR #664 Review' } };
  const meta = { type: 'context', elements: [{ type: 'mrkdwn', text: '@Z' }] };
  const links = { type: 'context', elements: [{ type: 'mrkdwn', text: '📋 작업 로그' }] };

  it('puts the rail right after the first header block, then the rest, then the controls', () => {
    const panel = build({ disabled: false }).blocks;
    const out = ActionPanelBuilder.compose([title, meta, links], panel);

    expect(out).toEqual([title, panel[0], meta, links, ...panel.slice(1)]);
  });

  it('skips a leading divider when finding the first header block', () => {
    const divider = { type: 'divider' };
    const panel = build({ disabled: false }).blocks;
    const out = ActionPanelBuilder.compose([divider, title, meta], panel);

    expect(out).toEqual([divider, title, panel[0], meta, ...panel.slice(1)]);
  });

  it('puts the rail first when the header renders nothing', () => {
    const panel = build({ disabled: false }).blocks;

    expect(ActionPanelBuilder.compose([], panel)).toEqual(panel);
  });

  it('never splits or reorders a mixed first line', () => {
    const minimal = {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'Title' },
        { type: 'mrkdwn', text: '`opus`' },
      ],
    };
    const panel = build({ closed: true }).blocks;

    expect(ActionPanelBuilder.compose([minimal], panel)).toEqual([minimal, panel[0]]);
  });
});
