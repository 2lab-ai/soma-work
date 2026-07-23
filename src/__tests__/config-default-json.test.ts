/**
 * Parity lock for `config.default.json` (repo root).
 *
 * The file is a GENERATED copy of `DEFAULT_UI_SURFACES` from
 * `@soma/slack/surface-config` — operators inspect it and copy sections into
 * `config.json` to customize. If the defaults change in code, regenerate:
 *
 *   node -e "const m=require('./packages/slack/dist/surface-config.js'); \
 *     console.log(JSON.stringify({ui:m.DEFAULT_UI_SURFACES},null,2))" > config.default.json
 *
 * See docs/ui-surfaces.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_UI_SURFACES, SURFACE_FIELD_REGISTRY } from '@soma/slack/surface-config';
import { describe, expect, it } from 'vitest';

const CONFIG_DEFAULT_PATH = path.resolve(__dirname, '../../config.default.json');

function collectLineGroups(surfaceConfig: {
  lines?: { fields: { field: string }[] }[];
  themes?: Record<string, { lines: { fields: { field: string }[] }[] }>;
}): { fields: { field: string }[] }[] {
  const groups = [...(surfaceConfig.lines ?? [])];
  for (const theme of Object.values(surfaceConfig.themes ?? {})) {
    groups.push(...(theme.lines ?? []));
  }
  return groups;
}

describe('config.default.json', () => {
  it('exists at the repo root', () => {
    expect(fs.existsSync(CONFIG_DEFAULT_PATH)).toBe(true);
  });

  it('ui section deep-equals DEFAULT_UI_SURFACES (regenerate on drift)', () => {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_DEFAULT_PATH, 'utf-8'));
    expect(parsed).toEqual({ ui: DEFAULT_UI_SURFACES });
  });

  it('every surface key is a valid SurfaceName and every field is registered', () => {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_DEFAULT_PATH, 'utf-8'));
    const knownSurfaces = Object.keys(SURFACE_FIELD_REGISTRY);

    for (const [surface, surfaceConfig] of Object.entries(parsed.ui)) {
      expect(knownSurfaces).toContain(surface);
      const registry = SURFACE_FIELD_REGISTRY[surface as keyof typeof SURFACE_FIELD_REGISTRY];
      for (const line of collectLineGroups(surfaceConfig as Parameters<typeof collectLineGroups>[0])) {
        for (const field of line.fields) {
          expect(registry).toContain(field.field);
        }
      }
    }
  });
});
