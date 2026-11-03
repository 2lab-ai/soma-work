import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #857 — soma-work's harness-aware skills live in their own plugin, never in zworkflow.
 *
 * SSOT_2 (Z, 2026-11-03): "zworkflow:es는 그대로 두고 local:auto-es? 같이 es를 호출하고 지금 여기서 지시한
 * 내용을 포함한 하네스 mcp 내부 호출을 포함한 내용과 관계있는 스킬쪽에 추가해주고 그걸 턴 종료 es대신에 호출하도록
 * 해줘야함 / zworkflow 플러그인은 외부에서도 soma-work와 관계없는 일반적인 그냥 클로드코드에서도 설치해서 쓰는
 * 스킬이고 soma-work안의 local 플러그인이 soma-work 하네스를 어웨어하고 있는 스킬들임"
 *
 *  - T7: `src/local-harness` is a Claude Code plugin named `local` — bundled with soma-work, loaded by default,
 *        and absent from the marketplace (external installs get zworkflow only).
 *  - T8: zworkflow carries no harness MCP procedure (no session task card calls) — es and using-ssot included.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('T7 — the harness plugin', () => {
  it('src/local-harness is a plugin named "local" with a version', () => {
    const manifest = JSON.parse(read('src', 'local-harness', '.claude-plugin', 'plugin.json'));
    expect(manifest.name).toBe('local');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is never published: the marketplace lists zworkflow only', () => {
    const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
    const sources = market.plugins.map((p: { source: string }) => p.source);
    const names = market.plugins.map((p: { name: string }) => p.name);
    expect(names).not.toContain('local');
    expect(sources.some((s: string) => s.includes('local-harness'))).toBe(false);
  });

  it('is a bundled default plugin of soma-work', async () => {
    const { BUNDLED_PLUGINS } = await import('../bundled');
    const { DEFAULT_PLUGINS } = await import('../defaults');
    expect(BUNDLED_PLUGINS.local).toBeTruthy();
    expect(BUNDLED_PLUGINS.local.endsWith(path.join('local-harness'))).toBe(true);
    expect(BUNDLED_PLUGINS.zworkflow.endsWith(`${path.sep}local`)).toBe(true);
    expect(DEFAULT_PLUGINS).toContain('local@soma-work');
  });

  // trinity R1 (fable P2): the no-PluginManager fallback guaranteed zworkflow only — every bundled plugin is guaranteed.
  it('withBundledPlugins prepends every bundled plugin the resolved list lacks, once', async () => {
    const { BUNDLED_PLUGINS, withBundledPlugins } = await import('../bundled');
    const all = Object.values(BUNDLED_PLUGINS);
    expect(withBundledPlugins([]).map((p) => p.path)).toEqual(all);
    const other = { type: 'local' as const, path: '/plugins/stv' };
    const zwf = { type: 'local' as const, path: BUNDLED_PLUGINS.zworkflow };
    const out = withBundledPlugins([zwf, other, other]).map((p) => p.path);
    expect(out).toEqual([BUNDLED_PLUGINS.local, BUNDLED_PLUGINS.zworkflow, '/plugins/stv']);
  });

  it('the session plugin list goes through withBundledPlugins', () => {
    expect(read('src', 'claude-handler.ts')).toMatch(/withBundledPlugins\(/);
  });

  it('the build copies it next to dist/local', () => {
    const build = JSON.parse(read('package.json')).scripts.build as string;
    expect(build).toContain('cp -r src/local-harness dist/');
  });

  it('its skills never shadow a zworkflow skill (one name, one owner)', () => {
    const list = (dir: string) =>
      fs
        .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, dir, d.name, 'SKILL.md')))
        .map((d) => d.name);
    const harness = list('src/local-harness/skills');
    const zworkflow = new Set(list('src/local/skills'));
    expect(harness).toContain('auto-es');
    for (const name of harness) expect(zworkflow.has(name), name).toBe(false);
  });
});

describe('T8 — zworkflow stays harness-free', () => {
  it('no zworkflow skill teaches a session task card call (GET_SESSION / UPDATE_SESSION)', () => {
    // The plugin root's maintainer notes state the boundary by naming the calls; nothing the plugin ships may.
    const MAINTAINER_NOTES = new Set(['CLAUDE.md', 'README.md', 'README.ko.md'].map((f) => path.join('src/local', f)));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name !== '__tests__') walk(rel);
        } else if (
          d.name.endsWith('.md') &&
          !MAINTAINER_NOTES.has(rel) &&
          /\b(GET_SESSION|UPDATE_SESSION)\b/.test(read(rel))
        ) {
          offenders.push(rel);
        }
      }
    };
    walk('src/local');
    expect(offenders).toEqual([]);
  });

  it('es is the generic one again: no task card, no NEEDS YOU, no host-only rules', () => {
    const files = [
      'SKILL.md',
      'reference/templates/brief.md',
      'reference/templates/issue.md',
      'reference/templates/epic.md',
    ];
    for (const f of files) {
      const md = read('src', 'local', 'skills', 'es', f);
      expect(md, f).not.toMatch(/task card|NEEDS YOU|Card sync|executiveSummary/);
    }
  });

  it('using-ssot Hook 4 points to the harness card check instead of carrying it', () => {
    const ssot = read('src', 'local', 'skills', 'using-ssot', 'SKILL.md');
    const hook4 = ssot.slice(ssot.indexOf('### Hook 4'), ssot.indexOf('## Output format'));
    expect(hook4).toMatch(/Card check/);
    expect(hook4).toContain('`local:auto-es` §Card check');
    expect(hook4).not.toMatch(/payload\.session|set_active|resourceType/);
  });
});
