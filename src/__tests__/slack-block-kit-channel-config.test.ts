/**
 * SlackBlockKitChannel × ui.turnend surface config.
 *
 * Part 1 — parity: with NO operator config, the config-driven renderer must
 * produce byte-identical blocks to the historical hardcoded per-theme
 * builders (default / compact / minimal × WorkflowComplete / Exception).
 * These literals were captured from the pre-config implementation.
 *
 * Part 2 — config overrides: `ui.turnend` lines from config.json
 * (via `setUiSurfacesConfig`) must reshape the card: hide fields, restyle
 * bars, reorder lines, change separators, and override per-theme.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('default'),
  },
}));

import { resetUiSurfacesConfig, setUiSurfacesConfig } from '@soma/slack/surface-config';
import { SlackBlockKitChannel } from '../notification-channels/slack-block-kit-channel';
import type { TurnCompletionEvent } from '../turn-notifier';
import { resetSlackWorkspaceUrl, setSlackWorkspaceUrl } from '../turn-notifier';
import { userSettingsStore } from '../user-settings-store';

const PERMALINK = 'https://example.slack.com/archives/C456/p1700000000000111';
const THREAD_LINK = ` · <${PERMALINK}|🧵 스레드 열기>`;

const STARTED_AT = new Date('2026-03-26T00:14:00.000+09:00');
// Computed with the exact formatClock() options so the parity literal is
// timezone-independent across dev machines / CI.
const CLOCK = STARTED_AT.toLocaleTimeString('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const EX_MESSAGE = ['Rate limited · resets 10:50pm', 'API Error: 529 overloaded', 'Claude Code process aborted'].join(
  '\n',
);
const EX_FENCE = `\`\`\`\n${EX_MESSAGE}\n\`\`\``;

function makeRichCompleteEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'WorkflowComplete',
    userId: 'U123',
    channel: 'C456',
    threadTs: '1700000000.000111',
    durationMs: 1048000, // 17:28
    sessionTitle: 'PR #77 리뷰',
    persona: 'default',
    model: 'opus-4.6',
    effort: 'high',
    startedAt: STARTED_AT,
    contextUsagePercent: 84.0,
    contextUsageDelta: -5.6,
    contextUsageTokens: 160300,
    contextWindowSize: 1000000,
    fiveHourUsage: 42,
    fiveHourDelta: 20,
    sevenDayUsage: 55,
    sevenDayDelta: 2,
    toolStats: {
      Bash: { count: 59, totalDurationMs: 767400 },
      WebFetch: { count: 7, totalDurationMs: 118200 },
      mcp__send_file__send_document: { count: 3, totalDurationMs: 44400 },
      WebSearch: { count: 2, totalDurationMs: 42500 },
      Task: { count: 2, totalDurationMs: 17200 },
      Read: { count: 4, totalDurationMs: 1000 },
    },
    ...overrides,
  };
}

function makeExceptionEvent(overrides: Partial<TurnCompletionEvent> = {}): TurnCompletionEvent {
  return {
    category: 'Exception',
    userId: 'U123',
    channel: 'C456',
    threadTs: '1700000000.000111',
    durationMs: 5000, // 0:05
    sessionTitle: 'Stale Title',
    message: EX_MESSAGE,
    model: 'opus-4.6',
    ...overrides,
  };
}

function createMockSlackApi() {
  return { postMessage: vi.fn().mockResolvedValue({ ts: '1700000001.000222' }) };
}

function getBlocks(api: { postMessage: any }): any[] {
  return api.postMessage.mock.calls[0][2].attachments[0].blocks;
}

function setTheme(theme: string): void {
  (userSettingsStore.getUserSessionTheme as any).mockReturnValue(theme);
}

function section(text: string): any {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function context(text: string): any {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

beforeEach(() => {
  setSlackWorkspaceUrl('https://example.slack.com/');
  setTheme('default');
  resetUiSurfacesConfig();
});

afterEach(() => {
  resetUiSurfacesConfig();
  resetSlackWorkspaceUrl();
});

// ---------------------------------------------------------------------------
// Part 1 — Parity with the historical hardcoded builders (no operator config)
// ---------------------------------------------------------------------------

describe('SlackBlockKitChannel — parity with pre-config hardcoded rendering', () => {
  it('default theme × WorkflowComplete: exact block structure', async () => {
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(getBlocks(api)).toEqual([
      section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`),
      context(`\`default\` | \`opus-4.6 | high\` | ${CLOCK}`),
      context('Ctx ▓▓▓▓░ 160.3k/1M (84.0% used) -5.6 | Dur 17:28 | 5h ▓▓▓░░░ 42% +20 | 7d ▓▓▓▓░░░░ 55% +2'),
      context(
        ':wrench: Bash×59: 767.4s | WebFetch×7: 118.2s | send_file:send_document×3: 44.4s | WebSearch×2: 42.5s | Task×2: 17.2s | +4 more',
      ),
    ]);
  });

  it('compact theme × WorkflowComplete: exact block structure', async () => {
    setTheme('compact');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(getBlocks(api)).toEqual([
      section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`),
      context('`opus-4.6 | high` · Ctx 84.0% used · 17:28 · 🔧 6 tools×77'),
    ]);
  });

  it('minimal theme × WorkflowComplete: exact block structure', async () => {
    setTheme('minimal');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(getBlocks(api)).toEqual([context('🟢 작업 완료 · opus-4.6 | high · 84.0% used · 17:28')]);
  });

  it('default theme × Exception: header suffix, fenced body, ident and usage rows', async () => {
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent());

    expect(getBlocks(api)).toEqual([
      section(`🔴 *오류 발생* — Rate limited · resets 10:50pm${THREAD_LINK}`),
      section(EX_FENCE),
      context('`opus-4.6`'),
      context('Dur 0:05'),
    ]);
  });

  it('compact theme × Exception: exact block structure', async () => {
    setTheme('compact');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent());

    expect(getBlocks(api)).toEqual([
      section(`🔴 *오류 발생* — Rate limited · resets 10:50pm${THREAD_LINK}`),
      section(EX_FENCE),
      context('`opus-4.6` · 0:05'),
    ]);
  });

  it('minimal theme × Exception: plain status with error suffix, body last', async () => {
    setTheme('minimal');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent());

    expect(getBlocks(api)).toEqual([
      context('🔴 오류 발생 — Rate limited · resets 10:50pm · opus-4.6 · 0:05'),
      section(EX_FENCE),
    ]);
  });

  it('minimal theme × Stalled: NO header error suffix (Exception-only parity)', async () => {
    setTheme('minimal');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent({ category: 'Stalled' }));

    expect(getBlocks(api)).toEqual([context('⚫ 응답 없음 — 코드 버그 의심 · opus-4.6 · 0:05'), section(EX_FENCE)]);
  });

  it('default theme: exception body truncated at 2900 chars with marker', async () => {
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent({ message: 'X'.repeat(6000) }));

    const body = getBlocks(api)[1].text.text as string;
    expect(body).toBe(`\`\`\`\n${'X'.repeat(2900)}\n…(truncated)\n\`\`\``);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — ui.turnend operator config drives the block composition
// ---------------------------------------------------------------------------

describe('SlackBlockKitChannel — ui.turnend config overrides', () => {
  it('custom lines hiding toolstats → no wrench line', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [
          {
            block: 'section',
            fields: [{ field: 'status' }, { field: 'title' }, { field: 'threadlink' }],
          },
          {
            block: 'context',
            separator: ' | ',
            fields: [{ field: 'contextwindow', label: 'Ctx', bar: { width: 5 }, decimals: 1 }],
          },
          { block: 'context', fields: [{ field: 'toolstats', show: false, prefixEmoji: ':wrench:' }] },
        ],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    const blocks = getBlocks(api);
    expect(JSON.stringify(blocks)).not.toContain(':wrench:');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`));
  });

  it('custom bar width for contextwindow is reflected', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [
          { block: 'context', fields: [{ field: 'contextwindow', label: 'Ctx', bar: { width: 10 }, decimals: 1 }] },
        ],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(1);
    // 84% of a 10-segment bar → 8 filled, 2 empty.
    expect(blocks[0].elements[0].text).toContain('Ctx ▓▓▓▓▓▓▓▓░░ 160.3k/1M (84.0% used) -5.6');
  });

  it('reordered lines are reflected in block order', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [
          { block: 'context', fields: [{ field: 'toolstats', max: 5, prefixEmoji: ':wrench:' }] },
          { block: 'section', fields: [{ field: 'status' }] },
        ],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('context');
    expect(blocks[0].elements[0].text.startsWith(':wrench: Bash×59')).toBe(true);
    expect(blocks[1]).toEqual(section('🟢 *작업 완료*'));
  });

  it("custom separator ' · ' is honored on a context line", async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [
          {
            block: 'context',
            separator: ' · ',
            fields: [
              { field: 'persona', style: { code: true } },
              { field: 'model', style: { code: true }, format: 'with-effort' },
            ],
          },
        ],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(getBlocks(api)).toEqual([context('`default` · `opus-4.6 | high`')]);
  });

  it('theme override via ui.turnend.themes.compact applies only to compact theme', async () => {
    setUiSurfacesConfig({
      turnend: {
        themes: {
          compact: {
            lines: [
              {
                block: 'context',
                separator: ' · ',
                fields: [{ field: 'status', format: 'plain' }, { field: 'duration' }],
              },
            ],
          },
        },
      },
    });

    setTheme('compact');
    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());
    expect(getBlocks(api)).toEqual([context('🟢 작업 완료 · 17:28')]);

    // default theme untouched — still the built-in default composition.
    setTheme('default');
    const api2 = createMockSlackApi();
    await new SlackBlockKitChannel(api2).send(makeRichCompleteEvent());
    expect(getBlocks(api2)[0]).toEqual(section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`));
    expect(getBlocks(api2)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Part 3 — Hostile numeric config must never crash or lose the turn-end card
// ---------------------------------------------------------------------------

describe('SlackBlockKitChannel — hostile config safety (clamps + fallback)', () => {
  it('decimals: 101 (pre-fix RangeError in toFixed) is clamped and the card still posts', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [{ block: 'context', fields: [{ field: 'contextwindow', label: 'Ctx', decimals: 101 }] }],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(1);
    // Clamped to 10 decimals — renders instead of throwing.
    expect(blocks[0].elements[0].text).toContain('(84.0000000000% used)');
  });

  it('bar.width: 10000 is clamped to 40 segments (no repeat() throw, no flooded line)', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [{ block: 'context', fields: [{ field: 'contextwindow', label: 'Ctx', bar: { width: 10000 } }] }],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const text: string = getBlocks(api)[0].elements[0].text;
    const barMatch = text.match(/[▓░]+/);
    expect(barMatch).not.toBeNull();
    expect(barMatch![0]).toHaveLength(40);
  });

  it('errorbody with truncate: 3000 config still yields section text ≤ 3000 chars including fence', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [{ block: 'section', fields: [{ field: 'errorbody', truncate: 3000 }] }],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeExceptionEvent({ message: 'x'.repeat(5000) }));

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(1);
    const text: string = blocks[0].text.text;
    expect(text.startsWith('```')).toBe(true);
    expect(text).toContain('…(truncated)');
    // Slack section.text hard limit — includes the code-fence overhead.
    expect(text.length).toBeLessThanOrEqual(3000);
  });

  it('hostile 4000-char labels on turnend.status render a section text capped at 3000 chars', async () => {
    // Each label is normalized down to 200 chars, but many capped labels
    // joined on one section line can still exceed Slack's 3000-char
    // text-object limit — the renderer must hard-cap the emitted text.
    setUiSurfacesConfig({
      turnend: {
        lines: [
          {
            block: 'section',
            separator: ' ',
            fields: Array.from({ length: 20 }, () => ({ field: 'status', label: 'A'.repeat(4000) })),
          },
        ],
      },
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(1);
    const text: string = blocks[0].text.text;
    // Normalization capped each label at 200 (no 201-char 'A' run exists) …
    expect(text).toContain('A'.repeat(200));
    expect(text).not.toContain('A'.repeat(201));
    // … and the final text object respects the Slack hard limit.
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text.endsWith('…')).toBe(true);
  });

  it('retries ONCE with default blocks when postMessage rejects config-derived blocks (card not lost)', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [{ block: 'section', fields: [{ field: 'status' }, { field: 'title' }, { field: 'threadlink' }] }],
      },
    });

    const api = createMockSlackApi();
    api.postMessage.mockRejectedValueOnce(
      Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } }),
    );
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(2);
    // Second attempt: blocks built from DEFAULT_UI_SURFACES.turnend lines —
    // the exact default-theme parity shape, same attachment postOptions shape.
    const retryOptions = api.postMessage.mock.calls[1][2];
    expect(retryOptions.threadTs).toBe('1700000000.000111');
    const retryBlocks = retryOptions.attachments[0].blocks;
    expect(retryBlocks).toHaveLength(4);
    expect(retryBlocks[0]).toEqual(section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`));
  });

  it('does NOT retry when no custom turnend config is set (existing warn path unchanged)', async () => {
    const api = createMockSlackApi();
    api.postMessage.mockRejectedValueOnce(
      Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } }),
    );
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on rate_limited / non-invalid_blocks errors even with custom config (429 backoff guardrail)', async () => {
    setUiSurfacesConfig({
      turnend: {
        lines: [{ block: 'section', fields: [{ field: 'status' }, { field: 'title' }] }],
      },
    });

    const api = createMockSlackApi();
    api.postMessage.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { data: { error: 'rate_limited' } }),
    );
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    // An immediate second post would violate Retry-After — must stay 1.
    expect(api.postMessage).toHaveBeenCalledTimes(1);
  });

  it('turn-end surface guarantee: a render throw falls back to default-shaped blocks (card never lost)', async () => {
    // Force a throw inside the block-building path (theme resolution) —
    // pre-fix this happened BEFORE the try{} in send(), so the throw
    // escaped error handling and the terminal card was silently lost.
    (userSettingsStore.getUserSessionTheme as any).mockImplementation(() => {
      throw new Error('boom: theme store corrupted');
    });

    const api = createMockSlackApi();
    await new SlackBlockKitChannel(api).send(makeRichCompleteEvent());

    expect(api.postMessage).toHaveBeenCalledTimes(1);
    // Fallback renders DEFAULT_UI_SURFACES.turnend default lines — the exact
    // default-theme parity shape.
    const blocks = getBlocks(api);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual(section(`🟢 *작업 완료* — PR #77 리뷰${THREAD_LINK}`));
  });
});
