/**
 * 스레드 태스크 카드 (SSOT 2026-11-02, soma-work .prd/21): the Slack thread header drawn from the owner's card
 * layout. The host hands the owner's lines (getThreadCardLines — by default they follow the dashboard's task card)
 * and the session's numbers and tasks (getThreadCardData); the builder draws the new fields cost · tokens · task ·
 * steps. Without lines (the owner keeps the server's theme) the header is `config.json` `ui.threadheader` as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetUiSurfacesConfig, SURFACE_FIELD_REGISTRY, type SurfaceLineConfig } from '../surface-config';
import { setThreadHeaderProviders, ThreadHeaderBuilder, type ThreadHeaderData } from '../thread-header-builder';

afterEach(() => {
  setThreadHeaderProviders({
    getDashboardSessionUrl: () => undefined,
    getThreadCardLines: () => undefined,
    getThreadCardData: () => undefined,
  });
  resetUiSurfacesConfig();
});

const texts = (blocks: any[]) =>
  blocks.map((b) =>
    b.type === 'header'
      ? `H:${b.text.text}`
      : b.type === 'context'
        ? b.elements.map((e: any) => e.text).join(' | ')
        : b.type,
  );
const CARD: SurfaceLineConfig[] = [
  { block: 'header', fields: [{ field: 'title', show: true }] },
  {
    block: 'context',
    fields: [
      { field: 'task', show: true },
      { field: 'steps', show: true },
      { field: 'cost', show: true },
      { field: 'tokens', show: true },
    ],
  },
];
const data = (over: Partial<ThreadHeaderData> = {}): ThreadHeaderData => ({
  title: '대시보드 화면 편집기',
  ownerId: 'U1',
  ownerName: 'Zhuge',
  model: 'claude-opus-5-5[1m]',
  ...over,
});

describe('thread card fields — cost · tokens · task · steps', () => {
  it('are registry fields of the thread header', () => {
    for (const f of ['cost', 'tokens', 'task', 'steps']) expect(SURFACE_FIELD_REGISTRY.threadheader).toContain(f);
  });

  it('render the session’s numbers and the task in progress; nothing when there is nothing to say', () => {
    const blocks = ThreadHeaderBuilder.build(
      data({
        lines: CARD,
        currentTask: '미리보기 드래그 구현',
        steps: { done: 2, total: 4 },
        costUsd: 6.2,
        totalTokens: 6_440_000,
      }),
    ).blocks!;
    expect(texts(blocks)).toEqual(['H:대시보드 화면 편집기', '▶ 미리보기 드래그 구현 | 작업 2/4 | $6.20 | 6.4M 토큰']);
    const empty = ThreadHeaderBuilder.build(data({ lines: CARD })).blocks!;
    expect(texts(empty)).toEqual(['H:대시보드 화면 편집기']);
    // A cost under a cent never reads $0.00.
    const cents = ThreadHeaderBuilder.build(data({ lines: CARD, costUsd: 0.004 })).blocks!;
    expect(texts(cents)[1]).toBe('<$0.01');
  });
});

describe('the owner’s thread card (providers)', () => {
  it('the owner’s lines win over the server’s theme; the session’s card data comes from the host', () => {
    const seen: string[] = [];
    setThreadHeaderProviders({
      getThreadCardLines: (ownerId) => {
        seen.push(ownerId);
        return CARD;
      },
      getThreadCardData: (session: any) => ({ currentTask: session.marker, steps: { done: 1, total: 3 } }),
    });
    const payload = ThreadHeaderBuilder.fromSession({ title: '세션', ownerId: 'U9', marker: '작업 A' } as any);
    expect(seen).toEqual(['U9']);
    expect(texts(payload.blocks!)).toEqual(['H:세션', '▶ 작업 A | 작업 1/3']);
  });

  it('without the owner’s lines (the server’s theme) the header is ui.threadheader as before', () => {
    setThreadHeaderProviders({ getThreadCardLines: () => undefined });
    const blocks = ThreadHeaderBuilder.build(data({ workflow: 'zwork' })).blocks!;
    expect(texts(blocks)[0]).toBe('H:대시보드 화면 편집기');
    expect(texts(blocks)[1]).toContain('`zwork`');
  });

  it('a long task name is cut to the context element’s room', () => {
    const blocks = ThreadHeaderBuilder.build(data({ lines: CARD, currentTask: 'x'.repeat(300) })).blocks!;
    expect(blocks[1].elements[0].text.length).toBeLessThanOrEqual(122);
  });
});
