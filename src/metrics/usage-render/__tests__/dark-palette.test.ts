import { describe, expect, it } from 'vitest';
import { DARK_PALETTE, HEATMAP_SCALE, luminance } from '../dark-palette';

describe('DARK_PALETTE', () => {
  it('has all 8 required tokens', () => {
    const keys = Object.keys(DARK_PALETTE).sort();
    expect(keys).toEqual(['accent', 'accentBg', 'accentSoft', 'bg', 'grid', 'surface', 'text', 'textMuted']);
  });

  it.each(Object.entries(DARK_PALETTE))('%s is valid 6-digit hex', (_key, hex) => {
    expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

describe('HEATMAP_SCALE', () => {
  it('has exactly 5 steps', () => {
    expect(HEATMAP_SCALE).toHaveLength(5);
  });

  it.each(HEATMAP_SCALE.map((c, i) => [i, c]))('step %i is valid hex', (_i, hex) => {
    expect(hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('luminance strictly monotonically increases', () => {
    const ys = HEATMAP_SCALE.map(luminance);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    }
  });

  it('has pinned luminance values (catches regression from e.g. #2A2A2A)', () => {
    const ys = HEATMAP_SCALE.map(luminance);
    expect(ys[0]).toBeGreaterThanOrEqual(30.0);
    expect(ys[0]).toBeLessThanOrEqual(32.0); // ≈ 31.0 for #1F1F1F
    expect(ys[4]).toBeGreaterThanOrEqual(145.0);
    expect(ys[4]).toBeLessThanOrEqual(148.0); // ≈ 146.3 for #CD7F5C (Y = 0.299·205 + 0.587·127 + 0.114·92)
  });

  it('rejects regression to #2A2A2A at step 0 (luminance would decrease)', () => {
    // sanity: #2A2A2A luminance ≈ 42, #3A231C ≈ 41 — if someone swaps back, assertion fires
    expect(luminance('#2A2A2A')).toBeGreaterThan(luminance('#3A231C'));
    expect(luminance(HEATMAP_SCALE[0])).toBeLessThan(luminance(HEATMAP_SCALE[1]));
  });
});

describe('luminance', () => {
  it('white is 255', () => expect(luminance('#FFFFFF')).toBeCloseTo(255, 0));
  it('black is 0', () => expect(luminance('#000000')).toBeCloseTo(0, 0));
  it('accepts lowercase', () => expect(luminance('#ff0000')).toBeCloseTo(76.245, 1));
});
