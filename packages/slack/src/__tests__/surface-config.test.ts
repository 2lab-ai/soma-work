/**
 * UI Surface Config — generic, config.json-driven composition of Slack
 * surfaces (thread header / turn-end card / dashboard card header).
 *
 * SSOT: user request "thread header 서피스 출력 설정 config.json에서" +
 * "같은 방식으로 턴 종료 서피스들" + "실제로 제네릭하게" + "ui.dashboardheader".
 * RED tests for ssot-tasks T1.2, T3.2, T5.2, T6.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_SURFACES,
  getSurfaceLines,
  MAX_TEXT_OBJECT_CHARS,
  normalizeUiSurfacesConfig,
  resetUiSurfacesConfig,
  SURFACE_FIELD_REGISTRY,
  setUiSurfacesConfig,
} from '../surface-config';
import { ThreadHeaderBuilder } from '../thread-header-builder';

afterEach(() => {
  resetUiSurfacesConfig();
});

describe('DEFAULT_UI_SURFACES', () => {
  it('defines all three surfaces', () => {
    expect(DEFAULT_UI_SURFACES.threadheader).toBeDefined();
    expect(DEFAULT_UI_SURFACES.turnend).toBeDefined();
    expect(DEFAULT_UI_SURFACES.dashboardheader).toBeDefined();
  });

  it('every default field is present in its surface registry', () => {
    for (const surface of ['threadheader', 'turnend', 'dashboardheader'] as const) {
      const cfg = DEFAULT_UI_SURFACES[surface]!;
      const allLines = [...(cfg.lines ?? []), ...Object.values(cfg.themes ?? {}).flatMap((t) => t.lines ?? [])];
      for (const line of allLines) {
        for (const f of line.fields) {
          expect(SURFACE_FIELD_REGISTRY[surface], `field "${f.field}" missing from ${surface} registry`).toContain(
            f.field,
          );
        }
      }
    }
  });

  it('threadheader default lines start with a header block containing the title field', () => {
    const lines = DEFAULT_UI_SURFACES.threadheader!.lines!;
    expect(lines[0].block).toBe('header');
    expect(lines[0].fields[0].field).toBe('title');
  });
});

describe('normalizeUiSurfacesConfig', () => {
  it('keeps known surfaces and drops unknown surface keys with a warning', () => {
    const { config, warnings } = normalizeUiSurfacesConfig({
      threadheader: { lines: [{ fields: [{ field: 'title' }] }] },
      bogus_surface: { lines: [] },
    });
    expect(config.threadheader).toBeDefined();
    expect((config as Record<string, unknown>).bogus_surface).toBeUndefined();
    expect(warnings.some((w) => w.includes('bogus_surface'))).toBe(true);
  });

  it('skips unknown fields with a warning but keeps known fields', () => {
    const { config, warnings } = normalizeUiSurfacesConfig({
      threadheader: {
        lines: [{ fields: [{ field: 'title' }, { field: 'verbosity' }, { field: 'excutive_summary' }] }],
      },
    });
    const fields = config.threadheader!.lines![0].fields;
    expect(fields.map((f) => f.field)).toEqual(['title']);
    expect(warnings.some((w) => w.includes('verbosity'))).toBe(true);
    expect(warnings.some((w) => w.includes('excutive_summary'))).toBe(true);
  });

  it('maps the "name" alias to owner with format "name"', () => {
    const { config } = normalizeUiSurfacesConfig({
      threadheader: { lines: [{ fields: [{ field: 'name', show: true }] }] },
    });
    const f = config.threadheader!.lines![0].fields[0];
    expect(f.field).toBe('owner');
    expect(f.format).toBe('name');
  });

  it('preserves show:false so renderers can hide fields', () => {
    const { config } = normalizeUiSurfacesConfig({
      threadheader: { lines: [{ fields: [{ field: 'model', show: false }] }] },
    });
    expect(config.threadheader!.lines![0].fields[0].show).toBe(false);
  });

  it('tolerates structurally broken input without throwing (falls back to empty)', () => {
    for (const bad of [null, 42, 'nope', { threadheader: { lines: 'not-an-array' } }, { turnend: 7 }]) {
      const { config } = normalizeUiSurfacesConfig(bad);
      expect(config.threadheader?.lines ?? undefined).toBeUndefined();
    }
  });

  it('drops lines whose fields entry is missing or empty after filtering', () => {
    const { config } = normalizeUiSurfacesConfig({
      threadheader: { lines: [{ fields: [{ field: 'nonexistent_field' }] }, { fields: [{ field: 'title' }] }] },
    });
    expect(config.threadheader!.lines!.length).toBe(1);
    expect(config.threadheader!.lines![0].fields[0].field).toBe('title');
  });

  it('preserves per-field detail options (style, truncate, bar, decimals, max, separator, prefixEmoji)', () => {
    const { config } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [
          {
            block: 'context',
            separator: ' · ',
            fields: [
              {
                field: 'contextwindow',
                bar: { width: 8, filledChar: '█', emptyChar: '·' },
                decimals: 0,
              },
              { field: 'toolstats', max: 3, prefixEmoji: ':hammer:' },
              { field: 'model', style: { code: true, bold: true }, truncate: 20 },
            ],
          },
        ],
      },
    });
    const line = config.turnend!.lines![0];
    expect(line.separator).toBe(' · ');
    expect(line.fields[0].bar).toEqual({ width: 8, filledChar: '█', emptyChar: '·' });
    expect(line.fields[0].decimals).toBe(0);
    expect(line.fields[1].max).toBe(3);
    expect(line.fields[1].prefixEmoji).toBe(':hammer:');
    expect(line.fields[2].style).toEqual({ code: true, bold: true });
    expect(line.fields[2].truncate).toBe(20);
  });

  it('clamps unbounded numeric options (decimals/bar.width/truncate/max) to safe renderer bounds', () => {
    // Unbounded values crash rendering: `toFixed(101)` throws RangeError,
    // giant `''.repeat` throws, truncate > 3000 exceeds Slack's section.text
    // hard limit. Normalization must clamp so renderers can trust the config.
    const { config } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [
          {
            fields: [
              { field: 'contextwindow', decimals: 101, bar: { width: 10000 } },
              { field: 'errorbody', truncate: 999999 },
              { field: 'toolstats', max: 5000 },
            ],
          },
        ],
      },
    });
    const fields = config.turnend!.lines![0].fields;
    expect(fields[0].decimals).toBe(10);
    expect(fields[0].bar).toEqual({ width: 40 });
    expect(fields[1].truncate).toBe(3000);
    expect(fields[2].max).toBe(100);
  });

  it('caps a hostile 4000-char label on turnend.status at 200 chars (truncate, not reject)', () => {
    // Unbounded config strings flow into Slack text objects and blow the
    // 3000-char limit — the API then rejects the turn-end card AFTER
    // postMessage, losing the terminal card entirely.
    const { config } = normalizeUiSurfacesConfig({
      turnend: { lines: [{ block: 'section', fields: [{ field: 'status', label: 'A'.repeat(4000) }] }] },
    });
    const field = config.turnend!.lines![0].fields[0];
    expect(field.field).toBe('status');
    expect(field.label).toBe('A'.repeat(200));
  });

  it('caps a line separator longer than 50 chars at 50', () => {
    const { config } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [{ separator: ' | '.repeat(100), fields: [{ field: 'status' }, { field: 'model' }] }],
      },
    });
    expect(config.turnend!.lines![0].separator).toBe(' | '.repeat(100).slice(0, 50));
    expect(config.turnend!.lines![0].separator!.length).toBe(50);
  });

  it('caps prefixEmoji/format/color and bar chars to their string bounds', () => {
    const { config } = normalizeUiSurfacesConfig({
      turnend: {
        lines: [
          {
            fields: [
              {
                field: 'contextwindow',
                prefixEmoji: ':x:'.repeat(100),
                format: 'p'.repeat(400),
                color: '#'.repeat(400),
                bar: { filledChar: '▓'.repeat(50), emptyChar: '░'.repeat(50) },
              },
            ],
          },
        ],
      },
    });
    const field = config.turnend!.lines![0].fields[0];
    expect(field.prefixEmoji!.length).toBe(100);
    expect(field.format!.length).toBe(50);
    expect(field.color!.length).toBe(50);
    expect(field.bar!.filledChar!.length).toBe(8);
    expect(field.bar!.emptyChar!.length).toBe(8);
  });

  it('clamped decimals render without throwing (toFixed stays in range)', () => {
    const { config } = normalizeUiSurfacesConfig({
      turnend: { lines: [{ fields: [{ field: 'contextwindow', decimals: 101 }] }] },
    });
    const decimals = config.turnend!.lines![0].fields[0].decimals!;
    expect(() => (84.0).toFixed(decimals)).not.toThrow();
    expect((84.0).toFixed(decimals)).toBe('84.0000000000');
  });
});

describe('setUiSurfacesConfig / getSurfaceLines resolution', () => {
  it('returns built-in defaults when no config was set', () => {
    const lines = getSurfaceLines('threadheader', 'default');
    expect(lines).toEqual(DEFAULT_UI_SURFACES.threadheader!.lines);
  });

  it('user lines apply to ALL themes unless a theme override exists', () => {
    setUiSurfacesConfig({
      threadheader: { lines: [{ block: 'context', fields: [{ field: 'title' }] }] },
    });
    expect(getSurfaceLines('threadheader', 'default')[0].fields[0].field).toBe('title');
    // codex D3: compact/minimal follow the configured lines too
    expect(getSurfaceLines('threadheader', 'compact')[0].fields[0].field).toBe('title');
    expect(getSurfaceLines('threadheader', 'minimal')[0].fields[0].field).toBe('title');
  });

  it('theme-specific override wins over surface-level lines', () => {
    setUiSurfacesConfig({
      threadheader: {
        lines: [{ block: 'context', fields: [{ field: 'title' }] }],
        themes: { compact: { lines: [{ block: 'context', fields: [{ field: 'model' }] }] } },
      },
    });
    expect(getSurfaceLines('threadheader', 'default')[0].fields[0].field).toBe('title');
    expect(getSurfaceLines('threadheader', 'compact')[0].fields[0].field).toBe('model');
  });

  it('falls back to built-in theme presets for surfaces the user did not configure', () => {
    setUiSurfacesConfig({ turnend: { lines: [{ fields: [{ field: 'status' }] }] } });
    expect(getSurfaceLines('threadheader', 'default')).toEqual(DEFAULT_UI_SURFACES.threadheader!.lines);
  });

  it('reset restores defaults', () => {
    setUiSurfacesConfig({ threadheader: { lines: [{ fields: [{ field: 'title' }] }] } });
    resetUiSurfacesConfig();
    expect(getSurfaceLines('threadheader', 'default')).toEqual(DEFAULT_UI_SURFACES.threadheader!.lines);
  });
});

describe('ThreadHeaderBuilder × hostile config — Slack text-object hard cap', () => {
  it('caps emitted section and context text at 3000 chars despite 4000-char config labels', () => {
    const hostileLabel = 'L'.repeat(4000); // normalized to 200, but many joined fields can still overflow
    setUiSurfacesConfig({
      threadheader: {
        lines: [
          // Section line: 20 × (200-char label + value) joined → way past 3000.
          { block: 'section', fields: Array.from({ length: 20 }, () => ({ field: 'workflow', label: hostileLabel })) },
          // Context line: one element whose value (title) is itself hostile-long.
          { block: 'context', fields: [{ field: 'title', label: hostileLabel }] },
        ],
      },
    });

    const payload = ThreadHeaderBuilder.build({ title: 'T'.repeat(4000), workflow: 'z' });
    const blocks = payload.blocks!;

    const sectionText: string = blocks[0].text.text;
    expect(blocks[0].type).toBe('section');
    expect(sectionText.length).toBeLessThanOrEqual(MAX_TEXT_OBJECT_CHARS);
    expect(sectionText.endsWith('…')).toBe(true);

    const contextText: string = blocks[1].elements[0].text;
    expect(blocks[1].type).toBe('context');
    expect(contextText.length).toBeLessThanOrEqual(MAX_TEXT_OBJECT_CHARS);
    expect(contextText.endsWith('…')).toBe(true);

    // Every emitted text object stays within the Slack hard limit.
    for (const block of blocks) {
      if (typeof block?.text?.text === 'string') {
        expect(block.text.text.length).toBeLessThanOrEqual(MAX_TEXT_OBJECT_CHARS);
      }
      for (const el of block?.elements ?? []) {
        expect(el.text.length).toBeLessThanOrEqual(MAX_TEXT_OBJECT_CHARS);
      }
    }
  });
});
