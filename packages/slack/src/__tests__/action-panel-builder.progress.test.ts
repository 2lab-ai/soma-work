import { describe, expect, it } from 'vitest';
import { ActionPanelBuilder } from '../action-panel-builder';

/**
 * U9 — the header must separate three things the old status line collapsed
 * into one badge (`.prd/slack-agent-ui/loop.md:47`, A19):
 *
 *   1. WHICH STEP the agent is on            (phase: approval wait / tool / generic)
 *   2. WHEN IT LAST ACTUALLY PROGRESSED      (`lastProgressAt` — a real work event)
 *   3. WHETHER IT IS STILL ALIVE             (`lastSignalAt` — heartbeat/liveness)
 *
 * (2) and (3) are deliberately NOT the same clock: a heartbeat proves the
 * process breathes, not that the work moved. The builder therefore never
 * derives a progress time from a liveness stamp, and when it has no real
 * progress event it says so instead of printing a fabricated "0초 전".
 *
 * `now` is injected so these assertions are exact rather than time-flaky; the
 * builder stays pure.
 */

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

function build(params: Parameters<typeof ActionPanelBuilder.build>[0]) {
  return ActionPanelBuilder.build({ sessionKey: 'C1:1700.000000', now: NOW, ...params });
}

/** Every mrkdwn/plain string in the payload, flattened. */
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (typeof record.text === 'string') out.push(record.text);
    for (const value of Object.values(record)) texts(value, out);
  }
  return out;
}

function joined(params: Parameters<typeof ActionPanelBuilder.build>[0]): string {
  return texts(build(params).blocks).join('\n');
}

describe('ActionPanelBuilder — U9 phase + real progress + liveness', () => {
  it('shows the step and the age of the LAST REAL progress event', () => {
    const out = joined({
      agentPhase: '코드 수정 중',
      activityState: 'working',
      lastProgressAt: NOW - 42 * SECOND,
    });

    expect(out).toContain('코드 수정 중');
    expect(out).toContain('마지막 활동 42초 전');
  });

  it('says the progress is unknown rather than inventing a timestamp', () => {
    const out = joined({ agentPhase: '코드 수정 중', activityState: 'working' });

    expect(out).toContain('실제 활동 기록 없음');
    expect(out).not.toContain('마지막 활동');
    expect(out).not.toMatch(/마지막 활동 0초 전/);
  });

  it('does NOT promote a generic lifecycle stamp into a progress time', () => {
    // statusUpdatedAt is written on every setStatus call (lifecycle/heartbeat).
    // It must never be read as "the work moved".
    const out = joined({
      agentPhase: '대기',
      activityState: 'working',
      statusUpdatedAt: NOW - 3 * SECOND,
      lastSignalAt: NOW - 3 * SECOND,
    });

    expect(out).toContain('실제 활동 기록 없음');
    expect(out).not.toContain('마지막 활동 3초 전');
  });

  it('reports liveness separately when the agent is breathing but not progressing', () => {
    const out = joined({
      agentPhase: '분석 중',
      activityState: 'working',
      lastProgressAt: NOW - 12 * MINUTE,
      lastSignalAt: NOW - 5 * SECOND,
    });

    expect(out).toContain('마지막 활동 12분 전');
    // The liveness signal is its own statement, not folded into the progress age.
    expect(out).toContain('응답 신호 5초 전');
  });

  it('omits the liveness line when the signal adds nothing over fresh progress', () => {
    const out = joined({
      agentPhase: '분석 중',
      activityState: 'working',
      lastProgressAt: NOW - 4 * SECOND,
      lastSignalAt: NOW - 3 * SECOND,
    });

    expect(out).toContain('마지막 활동 4초 전');
    expect(out).not.toContain('응답 신호');
  });

  // Review round 1: liveness was suppressed whenever progress was unknown —
  // exactly the state where "is it alive?" is the only question left.
  it('still reports a real liveness signal when progress is unknown', () => {
    const out = joined({
      agentPhase: '분석 중',
      activityState: 'working',
      lastSignalAt: NOW - 7 * SECOND,
    });

    expect(out).toContain('실제 활동 기록 없음');
    expect(out).toContain('응답 신호 7초 전');
  });

  it('says nothing about liveness when there is no signal either', () => {
    const out = joined({ agentPhase: '분석 중', activityState: 'working' });

    expect(out).toContain('실제 활동 기록 없음');
    expect(out).not.toContain('응답 신호');
  });

  it('gives approval-wait priority over any tool or generic phase', () => {
    const out = joined({
      waitingForChoice: true,
      activeTool: 'Bash',
      agentPhase: '코드 수정 중',
      lastProgressAt: NOW - 8 * SECOND,
    });

    expect(out).toContain('입력 대기');
    // The approval wait is what the user must act on — the tool must not
    // outrank it in the header.
    expect(out.indexOf('입력 대기')).toBeLessThan(out.indexOf('마지막 활동 8초 전'));
    expect(out).not.toContain('코드 수정 중');
  });

  it('renders a running tool as its own phase, distinct from a generic phase', () => {
    const out = joined({
      activeTool: 'Bash',
      agentPhase: '코드 수정 중',
      activityState: 'working',
      lastProgressAt: NOW - SECOND,
    });

    expect(out).toContain('Bash');
    expect(out).toContain('마지막 활동 1초 전');
  });

  it('never predicts — no ETA, no remaining-time, no progress percentage', () => {
    const out = joined({
      agentPhase: '분석 중',
      activityState: 'working',
      lastProgressAt: NOW - 90 * SECOND,
      lastSignalAt: NOW - SECOND,
    });

    expect(out).not.toMatch(/ETA|예상|남음|완료 예정/);
  });

  it('uses the injected clock, not the wall clock', () => {
    const blocks = ActionPanelBuilder.build({
      sessionKey: 'C1:1700.000000',
      now: NOW + 10 * MINUTE,
      agentPhase: '분석 중',
      activityState: 'working',
      lastProgressAt: NOW,
    }).blocks;

    expect(texts(blocks).join('\n')).toContain('마지막 활동 10분 전');
  });

  it('treats a future-dated progress stamp as "now" instead of a negative age', () => {
    const out = joined({ agentPhase: '분석 중', activityState: 'working', lastProgressAt: NOW + 5 * SECOND });

    expect(out).toContain('마지막 활동 0초 전');
    expect(out).not.toContain('-');
  });

  it('keeps the closed panel free of a live progress line', () => {
    const out = joined({ closed: true, agentPhase: '분석 중', lastProgressAt: NOW - SECOND });

    expect(out).toContain('종료됨');
    expect(out).not.toContain('마지막 활동');
    expect(out).not.toContain('실제 활동 기록 없음');
  });
});
