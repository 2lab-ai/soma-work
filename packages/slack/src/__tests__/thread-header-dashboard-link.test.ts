/**
 * Thread header `dashboardLink` field — the `📋 작업 로그` deep link to the
 * session's dashboard card (spec 10-agent-inbox-board §3.4-1).
 *
 * User request: "대시보드에 유저의 지시와 모델의 응답을 볼수 있게 해주고 해당
 * thread 제일 위에 링크 추가해줘". The header is the thread root for
 * bot-started threads, so the link lives in the header — in every theme, and
 * independent of log verbosity (the builder never reads it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_SURFACES,
  getSurfaceLines,
  normalizeUiSurfacesConfig,
  resetUiSurfacesConfig,
  SURFACE_FIELD_REGISTRY,
  type SurfaceUiConfig,
  setUiSurfacesConfig,
} from '../surface-config';
import { setThreadHeaderProviders, ThreadHeaderBuilder, type ThreadHeaderData } from '../thread-header-builder';

const SESSION_KEY = 'work:C123:1711234567.000100';
const DASHBOARD_URL = 'https://soma.example/dashboard/U123?session=work%3AC123%3A1711234567.000100';
const LINK_TEXT = `📋 <${DASHBOARD_URL}|작업 로그>`;
const THEMES = ['default', 'compact', 'minimal'] as const;

afterEach(() => {
  setThreadHeaderProviders({ getDashboardSessionUrl: () => undefined });
  resetUiSurfacesConfig();
});

function makeData(overrides?: Partial<ThreadHeaderData>): ThreadHeaderData {
  return {
    title: 'Fix login bug',
    workflow: 'default',
    ownerName: 'Kim',
    ownerId: 'U123',
    model: 'claude-opus-4-6-20250414',
    sessionKey: SESSION_KEY,
    ...overrides,
  };
}

function allTexts(blocks: any[]): string[] {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block?.text?.text === 'string') parts.push(block.text.text);
    if (Array.isArray(block?.elements)) {
      for (const el of block.elements) {
        if (typeof el?.text === 'string') parts.push(el.text);
      }
    }
  }
  return parts;
}

describe('ThreadHeaderBuilder — dashboardLink field', () => {
  it.each(THEMES)('renders the 📋 작업 로그 link in the %s theme', (theme) => {
    const provider = vi.fn().mockReturnValue(DASHBOARD_URL);
    setThreadHeaderProviders({ getDashboardSessionUrl: provider });

    const texts = allTexts(ThreadHeaderBuilder.build(makeData({ theme })).blocks || []);

    expect(texts).toContain(LINK_TEXT);
    expect(provider).toHaveBeenCalledWith('U123', SESSION_KEY);
  });

  it.each(THEMES)('keeps the link on the closed %s header', (theme) => {
    setThreadHeaderProviders({ getDashboardSessionUrl: () => DASHBOARD_URL });

    const texts = allTexts(ThreadHeaderBuilder.build(makeData({ theme, closed: true })).blocks || []);

    expect(texts).toContain(LINK_TEXT);
  });

  it.each(THEMES)('omits the link in the %s theme when the provider has no URL', (theme) => {
    setThreadHeaderProviders({ getDashboardSessionUrl: () => undefined });

    const texts = allTexts(ThreadHeaderBuilder.build(makeData({ theme })).blocks || []);

    expect(texts.some((t) => t.includes('작업 로그'))).toBe(false);
  });

  it('omits the link without asking the provider when the session key is unknown', () => {
    const provider = vi.fn().mockReturnValue(DASHBOARD_URL);
    setThreadHeaderProviders({ getDashboardSessionUrl: provider });

    const texts = allTexts(ThreadHeaderBuilder.build(makeData({ sessionKey: undefined })).blocks || []);

    expect(texts.some((t) => t.includes('작업 로그'))).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it('omits the link without asking the provider when the owner is unknown', () => {
    const provider = vi.fn().mockReturnValue(DASHBOARD_URL);
    setThreadHeaderProviders({ getDashboardSessionUrl: provider });

    const texts = allTexts(ThreadHeaderBuilder.build(makeData({ ownerId: undefined })).blocks || []);

    expect(texts.some((t) => t.includes('작업 로그'))).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it('omits the link when the provider throws instead of failing the header', () => {
    setThreadHeaderProviders({
      getDashboardSessionUrl: () => {
        throw new Error('viewer not configured');
      },
    });

    const payload = ThreadHeaderBuilder.build(makeData());

    expect(allTexts(payload.blocks || []).some((t) => t.includes('작업 로그'))).toBe(false);
    expect(allTexts(payload.blocks || [])).toContain('Fix login bug');
  });

  it('fromSession forwards the sessionKey override to the provider', () => {
    const provider = vi.fn().mockReturnValue(DASHBOARD_URL);
    setThreadHeaderProviders({ getDashboardSessionUrl: provider });

    const payload = ThreadHeaderBuilder.fromSession(
      { title: 'Fix login bug', ownerId: 'U123', ownerName: 'Kim' },
      { sessionKey: SESSION_KEY, theme: 'minimal' },
    );

    expect(allTexts(payload.blocks || [])).toContain(LINK_TEXT);
    expect(provider).toHaveBeenCalledWith('U123', SESSION_KEY);
  });

  it('formatDashboardLink is the one mrkdwn spelling of the link', () => {
    expect(ThreadHeaderBuilder.formatDashboardLink(DASHBOARD_URL)).toBe(LINK_TEXT);
  });
});

describe('surface-config — dashboardLink registration', () => {
  it('registers dashboardLink for the thread header only', () => {
    expect(SURFACE_FIELD_REGISTRY.threadheader).toContain('dashboardLink');
    expect(SURFACE_FIELD_REGISTRY.turnend).not.toContain('dashboardLink');
    expect(SURFACE_FIELD_REGISTRY.dashboardheader).not.toContain('dashboardLink');
  });

  it.each(THEMES)('enables dashboardLink in the built-in %s preset', (theme) => {
    const fields = getSurfaceLines('threadheader', theme).flatMap((line) => line.fields);
    const entry = fields.find((f) => f.field === 'dashboardLink');

    expect(entry).toBeDefined();
    expect(entry?.show).toBe(true);
  });

  it.each([
    'dashboardLink',
    'dashboardlink',
    'DASHBOARDLINK',
  ])('normalizes the config spelling "%s" to the canonical dashboardLink id', (spelling) => {
    const { config, warnings } = normalizeUiSurfacesConfig({
      threadheader: { lines: [{ fields: [{ field: spelling }] }] },
    });

    expect(warnings).toEqual([]);
    expect(config.threadheader?.lines?.[0].fields[0].field).toBe('dashboardLink');
  });

  it('renders the link from an operator config that names the field in camelCase', () => {
    setThreadHeaderProviders({ getDashboardSessionUrl: () => DASHBOARD_URL });
    setUiSurfacesConfig({ threadheader: { lines: [{ block: 'context', fields: [{ field: 'dashboardLink' }] }] } });

    expect(allTexts(ThreadHeaderBuilder.build(makeData()).blocks || [])).toEqual([LINK_TEXT]);
  });
});

describe('surface-config — config.json seeded before dashboardLink existed', () => {
  // config-loader seeds DEFAULT_UI_SURFACES into config.json when `ui` is
  // absent, and an operator `ui.threadheader` overrides the built-in presets.
  // A copy seeded before this field existed must not freeze it out.
  function withoutDashboardLink(surface: SurfaceUiConfig): SurfaceUiConfig {
    const strip = (lines: SurfaceUiConfig['lines']) =>
      (lines ?? []).map((line) => ({ ...line, fields: line.fields.filter((f) => f.field !== 'dashboardLink') }));
    return JSON.parse(
      JSON.stringify({
        lines: strip(surface.lines),
        themes: Object.fromEntries(
          Object.entries(surface.themes ?? {}).map(([name, theme]) => [name, { lines: strip(theme?.lines) }]),
        ),
      }),
    );
  }

  it('treats an unedited pre-dashboardLink seed as no override, so the built-in preset applies', () => {
    const seeded = JSON.parse(JSON.stringify(DEFAULT_UI_SURFACES));
    seeded.threadheader = withoutDashboardLink(DEFAULT_UI_SURFACES.threadheader!);

    const { config } = setUiSurfacesConfig(seeded);

    expect(config.threadheader).toBeUndefined();
    expect(config.turnend).toBeDefined();
    for (const theme of THEMES) {
      const fields = getSurfaceLines('threadheader', theme).flatMap((line) => line.fields);
      expect(fields.some((f) => f.field === 'dashboardLink')).toBe(true);
    }
  });

  it('keeps an operator-edited thread header exactly as configured', () => {
    const edited = withoutDashboardLink(DEFAULT_UI_SURFACES.threadheader!);
    edited.lines![0].fields[0].truncate = 80;

    const { config } = setUiSurfacesConfig({ threadheader: edited });

    expect(config.threadheader).toBeDefined();
    const fields = getSurfaceLines('threadheader', 'default').flatMap((line) => line.fields);
    expect(fields.some((f) => f.field === 'dashboardLink')).toBe(false);
    expect(fields[0].truncate).toBe(80);
  });
});
