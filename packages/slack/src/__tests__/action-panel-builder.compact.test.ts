import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';
import { getVerbosityFlags } from '../output-flags';

/**
 * Panel height — the status area is ONE block, not two (2026-09-17 user
 * feedback on the live panel: "좀더 컴팩트하게 보여줘").
 *
 * The badge, the step/progress line and the turn timers are three facts that
 * used to cost a section plus a context block, with a full-width gap between
 * them. They are merged into one section of two short lines:
 *
 *   🟢 *작업 중* · 결과 반영 중 · 마지막 활동 0초 전
 *   ⏱ 4:02 · 🛠 17 · 🔇 minimal
 *
 * Merged, not deleted: U9/A19 keeps every fact addressable (the progress age is
 * still a measured age, never invented), so these assertions are about LAYOUT.
 * The semantics are pinned by `action-panel-builder.progress.test.ts`.
 */

const NOW = 1_700_000_000_000;

function build(params: Partial<Parameters<typeof ActionPanelBuilder.build>[0]> = {}) {
  return ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params });
}

/** The one section that carries the status badge. */
function statusSection(blocks: any[]): any {
  return blocks.find(
    (block) =>
      block.type === 'section' && /🟢|🟡|⚪|⚫/.test(String(block?.text?.text ?? block?.fields?.[0]?.text ?? '')),
  );
}

function statusLines(blocks: any[]): string[] {
  const section = statusSection(blocks);
  const text = String(section?.text?.text ?? section?.fields?.[0]?.text ?? '');
  return text.split('\n');
}

describe('ActionPanelBuilder — compact status area', () => {
  const live = {
    activityState: 'working' as const,
    agentPhase: '결과 반영 중',
    lastProgressAt: NOW,
    turnSummary: '⏱ 4:02 · 🛠 17',
    logVerbosity: getVerbosityFlags('minimal'),
  };

  it('renders badge + progress + timers as ONE section of two lines', () => {
    const lines = statusLines(build(live).blocks);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('작업 중');
    expect(lines[0]).toContain('결과 반영 중');
    expect(lines[0]).toContain('마지막 활동 0초 전');
    expect(lines[1]).toBe('⏱ 4:02 · 🛠 17 · 🔇 minimal');
  });

  it('spends exactly ONE block on the status area, with no separate metrics context', () => {
    const blocks = build(live).blocks;
    const beforeControls = blocks.slice(
      0,
      blocks.findIndex((block: any) => block.type === 'divider' || block.type === 'actions'),
    );

    expect(beforeControls).toHaveLength(1);
    expect(beforeControls[0].type).toBe('section');
    expect(blocks.some((block: any) => block.type === 'context')).toBe(false);
  });

  it('drops the second line entirely when there are no timers to show', () => {
    const lines = statusLines(build({ activityState: 'working', agentPhase: '분석 중', lastProgressAt: NOW }).blocks);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('분석 중');
  });

  it('keeps the PR chip in its own column while the status column carries both lines', () => {
    const blocks = build({
      ...live,
      prStatus: { state: 'open', mergeable: true, draft: false, merged: false, approved: true },
    }).blocks;
    const section = statusSection(blocks);

    expect(section.fields).toHaveLength(2);
    expect(String(section.fields[0].text).split('\n')).toHaveLength(2);
    expect(section.fields[1].text).toContain('*PR*');
  });

  it('still shows the latest-response link (it just moved into the timers line)', () => {
    const lines = statusLines(build({ ...live, latestResponseLink: 'https://slack.example/p' }).blocks);

    expect(lines[1]).toContain('https://slack.example/p');
    expect(lines[1]).toContain('최신 응답');
  });

  it('leaves the closed panel layout alone', () => {
    const blocks = build({ closed: true, turnSummary: '⏱ 3:20 · 🛠 12' }).blocks;

    expect(String(statusSection(blocks)?.text?.text ?? statusSection(blocks)?.fields?.[0]?.text)).toContain('종료됨');
    expect(blocks.some((block: any) => block.type === 'context')).toBe(true);
  });
});
