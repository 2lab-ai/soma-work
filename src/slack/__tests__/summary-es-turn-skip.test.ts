import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { esWroteCardThisTurn } from '../summary-service';

/**
 * #846 item 8 — a turn whose model-run es (`local:auto-es`) already wrote the card does not fork a host summary.
 *
 * The card ignores that fork (`displayOnThread` keeps an es-written card), yet it cost a fork and put a second,
 * different TL;DR on the Slack thread head. The marker is `executiveSummary.source === 'es'`; the next input clears
 * it (`clearDisplay`), so the next turn's summary runs as usual.
 */

describe('esWroteCardThisTurn', () => {
  it('is true only for a TL;DR the model-run es wrote', () => {
    expect(esWroteCardThisTurn({ executiveSummary: { tldr: ['a'], at: 1, source: 'es' } })).toBe(true);
    expect(esWroteCardThisTurn({ executiveSummary: { tldr: ['a'], at: 1 } })).toBe(false);
    expect(esWroteCardThisTurn({ executiveSummary: undefined })).toBe(false);
    expect(esWroteCardThisTurn({})).toBe(false);
  });
});

describe('turn end — the host summary timer', () => {
  const src = readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'packages', 'slack', 'src', 'pipeline', 'stream-executor.ts'),
    'utf8',
  );
  const start = src.indexOf('this.deps.summaryTimer.start(');
  const guard = src.slice(Math.max(0, start - 600), start);

  it('does not start when the es of this turn wrote the card', () => {
    expect(start).toBeGreaterThan(0);
    expect(guard).toMatch(/!esWroteCardThisTurn\(session\)/);
  });

  it('the next input still clears the marker before its turn ends', () => {
    const clear = src.indexOf('this.deps.summaryService.clearDisplay(session as any)');
    expect(clear).toBeGreaterThan(0);
    const summary = readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'packages', 'slack', 'src', 'summary-service.ts'),
      'utf8',
    );
    const body = summary.slice(summary.indexOf('clearDisplay(session: SummarySessionInfo): void {'));
    expect(body.slice(0, 400)).toContain('session.executiveSummary = undefined;');
  });
});
