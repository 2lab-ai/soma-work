/**
 * research-skill run 2026-11-13 (diagram D-probes + report v1): the Excalidraw renderer failed on every run.
 * - The template imported `@excalidraw/excalidraw?bundle` with no version; esm.sh now resolves it to 0.18.1, whose
 *   bundle imports a module that answers 404, so the import throws.
 * - With a pinned build the first module load took 36–44 s; the renderer gave up at 15 s and blamed the network.
 * - The pre-flight only asked whether the esm.sh host answers, so it passed while the module itself could not load.
 * - The bootstrap ran `uv sync` inside the plugin folder (read-only in a bot session) with errors sent to /dev/null.
 * These pin the fixes: one pinned module URL, a load timeout that fits a cold load, a pre-flight on that exact URL,
 * and a virtualenv outside the plugin folder.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf-8');
const PINNED = /https:\/\/esm\.sh\/@excalidraw\/excalidraw@\d+\.\d+\.\d+\?bundle/;

describe('architecture-diagram renderer loads a module that exists, in time', () => {
  it('render_template.html imports one exact Excalidraw version', () => {
    const html = read('references/render_template.html');
    expect(html).toMatch(PINNED);
    expect(html).not.toMatch(/esm\.sh\/@excalidraw\/excalidraw\?bundle/);
  });

  it('render_excalidraw.py waits long enough for a cold module load, and the wait can be raised', () => {
    const py = read('references/render_excalidraw.py');
    expect(py).not.toMatch(/timeout=15000/);
    const m = py.match(/DEFAULT_LOAD_TIMEOUT_MS\s*=\s*(\d[\d_]*)/);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[1].replace(/_/g, ''))).toBeGreaterThanOrEqual(90_000);
    expect(py).toContain('EXCALIDRAW_LOAD_TIMEOUT_MS');
    expect(py).toContain('--load-timeout-ms');
  });

  it('a timeout names the module URL and does not blame the network alone', () => {
    const py = read('references/render_excalidraw.py');
    expect(py).not.toContain('Check network access to https://esm.sh/.');
    expect(py).toMatch(/module_url/);
  });

  it('SKILL.md pre-flight fetches the pinned module URL read from the template, not just the host', () => {
    const md = read('SKILL.md');
    const pre = md.slice(md.indexOf('### 4.'), md.indexOf('### 5.'));
    expect(pre).toContain('render_template.html');
    expect(pre).not.toMatch(/curl -fsSI --max-time 5 https:\/\/esm\.sh\/ /);
  });

  it('bootstrap keeps the virtualenv out of the plugin folder and shows install errors', () => {
    const md = read('SKILL.md');
    const boot = md.slice(md.indexOf('### 3.'), md.indexOf('### 4.'));
    expect(boot).toContain('UV_PROJECT_ENVIRONMENT');
    expect(boot).not.toContain('2>/dev/null');
  });
});
