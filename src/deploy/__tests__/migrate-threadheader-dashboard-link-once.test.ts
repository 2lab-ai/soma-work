/**
 * 2026-10-16 one-time additive config.json rewrite: `dashboardLink` (📋 작업 로그)
 * goes into every `ui.threadheader` lines array that never mentions it.
 *
 * User request: "해당 thread 제일 위에 링크 추가해줘". The header comes from
 * config.json's own `ui.threadheader` on every host that booted before the
 * field existed, so without this rewrite those hosts never show the link.
 *
 * Fixtures are LITERAL (never derived from DEFAULT_UI_SURFACES):
 *   - fixtures/config-default-e992de7c.json — `git show e992de7c:config.default.json`,
 *     the seed config-loader wrote before the field existed;
 *   - fixtures/threadheader-fable-dev-2026-10-16.json — the fable dev host's
 *     edited `ui.threadheader` (status moved into the identity line, no
 *     link-history line), keys as captured.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  migrateThreadHeaderDashboardLinkOnce,
  THREADHEADER_DASHBOARD_LINK_ONCE_MARKER,
} from '../migrate-threadheader-dashboard-link-once';

// Fault injection: make the config.json write throw on demand.
const fault = vi.hoisted(() => ({ failConfigWrite: false }));
vi.mock('@soma/common/atomic-write', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@soma/common/atomic-write')>();
  return {
    ...orig,
    atomicWriteFile: (target: string, data: string | Buffer, opts?: Parameters<typeof orig.atomicWriteFile>[2]) => {
      if (fault.failConfigWrite && target.endsWith('config.json')) throw new Error('injected write failure');
      return orig.atomicWriteFile(target, data, opts);
    },
  };
});

// Dist modules load their siblings through Node's own require: ThreadHeaderBuilder
// reads `./surface-config` natively, a different instance from the one vitest
// inlines for an `import` here (production has one). Configure and render through
// the native instances, or the header silently falls back to the built-in default.
const nativeRequire = createRequire(__filename);
const { getSurfaceLines, resetUiSurfacesConfig, setUiSurfacesConfig } = nativeRequire(
  '@soma/slack/surface-config',
) as typeof import('@soma/slack/surface-config');
const { setThreadHeaderProviders, ThreadHeaderBuilder } = nativeRequire(
  '@soma/slack/thread-header-builder',
) as typeof import('@soma/slack/thread-header-builder');

afterEach(() => {
  fault.failConfigWrite = false;
  resetUiSurfacesConfig();
  setThreadHeaderProviders({ getDashboardSessionUrl: () => undefined });
});

const FIXTURES = path.join(__dirname, 'fixtures');
const SEED_E992DE7C = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'config-default-e992de7c.json'), 'utf8'));
const FABLE_DEV_THREADHEADER = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'threadheader-fable-dev-2026-10-16.json'), 'utf8'),
);
const LINK = { field: 'dashboardLink', show: true };
const NOW = () => new Date('2026-10-16T03:00:00.000Z');

function makeHost(config: unknown): { configFile: string; dataDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'threadheader-dashboard-link-'));
  const configFile = path.join(root, 'config.json');
  if (config !== undefined) fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { configFile, dataDir: path.join(root, 'data') };
}

function run(host: { configFile: string; dataDir: string }) {
  return migrateThreadHeaderDashboardLinkOnce({ ...host, now: NOW });
}

function readConfig(configFile: string): any {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

function fieldNames(line: any): string[] {
  return line.fields.map((f: any) => f.field);
}

function renderedTexts(ui: unknown, theme: 'default' | 'compact' | 'minimal'): string[] {
  setUiSurfacesConfig(ui);
  setThreadHeaderProviders({ getDashboardSessionUrl: () => 'https://soma.example/dashboard/U1?session=k' });
  const blocks =
    ThreadHeaderBuilder.build({ title: 'T', ownerId: 'U1', sessionKey: 'work:C1:1.0', theme }).blocks || [];
  return blocks.flatMap((block: any) => (block.elements ?? []).map((el: any) => el.text));
}

describe('migrateThreadHeaderDashboardLinkOnce', () => {
  it('(a) e992de7c seed: adds the link before linkhistory (base) and before links (compact, minimal)', () => {
    const host = makeHost({ mcpServers: {}, ui: SEED_E992DE7C.ui });
    // Negative control: the seeded header renders no link before the migration.
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      expect(renderedTexts(SEED_E992DE7C.ui, theme).some((t) => t.includes('작업 로그'))).toBe(false);
    }

    const result = run(host);

    expect(result).toMatchObject({ outcome: 'migrated', arraysChanged: 3 });
    const header = readConfig(host.configFile).ui.threadheader;
    expect(fieldNames(header.lines[2])).toEqual(['dashboardLink', 'linkhistory']);
    expect(header.lines[2].fields[0]).toEqual(LINK);
    expect(header.lines).toHaveLength(4);
    expect(fieldNames(header.themes.compact.lines[1])).toEqual([
      'workflow',
      'model',
      'contextwindow',
      'dashboardLink',
      'links',
      'status',
    ]);
    expect(fieldNames(header.themes.minimal.lines[0])).toEqual([
      'title',
      'model',
      'contextwindow',
      'dashboardLink',
      'links',
      'status',
    ]);
    // Only the thread header changed.
    const after = readConfig(host.configFile);
    expect(after.ui.turnend).toEqual(SEED_E992DE7C.ui.turnend);
    expect(after.ui.dashboardheader).toEqual(SEED_E992DE7C.ui.dashboardheader);
    // …and the operator's header now renders the link in every theme.
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      expect(renderedTexts(after.ui, theme)).toContain('📋 <https://soma.example/dashboard/U1?session=k|작업 로그>');
    }
  });

  it('(b) fable dev edited header: base gets a link line right after the title, both themes before links', () => {
    const host = makeHost({ ui: { threadheader: FABLE_DEV_THREADHEADER } });
    // Negative control: the live header renders no link before the migration.
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      expect(renderedTexts({ threadheader: FABLE_DEV_THREADHEADER }, theme).some((t) => t.includes('작업 로그'))).toBe(
        false,
      );
    }

    const result = run(host);

    expect(result).toMatchObject({ outcome: 'migrated', arraysChanged: 3 });
    const header = readConfig(host.configFile).ui.threadheader;
    // No links/linkhistory anywhere in the base → new context line after the header line.
    expect(header.lines).toHaveLength(3);
    expect(header.lines[0].block).toBe('header');
    expect(header.lines[1]).toEqual({ block: 'context', fields: [LINK] });
    expect(header.lines[2]).toEqual(FABLE_DEV_THREADHEADER.lines[1]);
    expect(fieldNames(header.themes.compact.lines[1])).toEqual([
      'workflow',
      'model',
      'contextwindow',
      'dashboardLink',
      'links',
      'status',
    ]);
    expect(fieldNames(header.themes.minimal.lines[0])).toEqual([
      'title',
      'model',
      'contextwindow',
      'dashboardLink',
      'links',
      'status',
    ]);
    for (const theme of ['default', 'compact', 'minimal'] as const) {
      expect(renderedTexts(readConfig(host.configFile).ui, theme)).toContain(
        '📋 <https://soma.example/dashboard/U1?session=k|작업 로그>',
      );
    }
  });

  it('(c) never touches an array that mentions dashboardLink (show:false included)', () => {
    const optedOut = [
      { block: 'header', fields: [{ field: 'title', show: true }] },
      {
        block: 'context',
        fields: [
          { field: 'dashboardLink', show: false },
          { field: 'linkhistory', show: true },
        ],
      },
    ];
    const missing = [
      {
        block: 'context',
        fields: [
          { field: 'title', show: true },
          { field: 'links', show: true },
        ],
      },
    ];
    const host = makeHost({ ui: { threadheader: { lines: optedOut, themes: { minimal: { lines: missing } } } } });

    const result = run(host);

    expect(result).toMatchObject({ outcome: 'migrated', arraysChanged: 1 });
    const header = readConfig(host.configFile).ui.threadheader;
    expect(header.lines).toEqual(optedOut);
    expect(fieldNames(header.themes.minimal.lines[0])).toEqual(['title', 'dashboardLink', 'links']);
  });

  it('(c) leaves every array alone when all of them already mention the field', () => {
    const lines = [{ block: 'context', fields: [{ field: 'DashboardLink', show: false }] }];
    const host = makeHost({ ui: { threadheader: { lines } } });
    const before = fs.readFileSync(host.configFile, 'utf8');

    expect(run(host)).toMatchObject({ outcome: 'already-present', arraysChanged: 0 });
    expect(fs.readFileSync(host.configFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER))).toBe(true);
  });

  it('(d) marker present: an operator who removed the link after the migration keeps it removed', () => {
    const host = makeHost({ ui: SEED_E992DE7C.ui });
    expect(run(host).outcome).toBe('migrated');

    // Operator removes the link from every array again.
    const edited = readConfig(host.configFile);
    edited.ui.threadheader.lines[2].fields.shift();
    edited.ui.threadheader.themes.compact.lines[1].fields.splice(3, 1);
    edited.ui.threadheader.themes.minimal.lines[0].fields.splice(3, 1);
    fs.writeFileSync(host.configFile, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(host.configFile, 'utf8');

    expect(run(host)).toMatchObject({ outcome: 'marker-present', arraysChanged: 0 });
    expect(fs.readFileSync(host.configFile, 'utf8')).toBe(before);
    expect(JSON.stringify(readConfig(host.configFile).ui.threadheader)).not.toContain('dashboardLink');
  });

  it('(d) marker present: a header without the link is untouched (corrupt marker counts)', () => {
    const host = makeHost({ ui: SEED_E992DE7C.ui });
    fs.mkdirSync(host.dataDir, { recursive: true });
    fs.writeFileSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER), 'not json', 'utf8');
    const before = fs.readFileSync(host.configFile, 'utf8');

    expect(run(host).outcome).toBe('marker-present');
    expect(fs.readFileSync(host.configFile, 'utf8')).toBe(before);
  });

  it('(e) keeps ${VAR} placeholders and every other key verbatim, in order', () => {
    const config = {
      mcpServers: { jira: { command: 'npx', env: { JIRA_TOKEN: '${JIRA_TOKEN}' } } },
      'claude.env': { ANTHROPIC_BASE_URL: '${LLMUX_URL}' },
      ui: { threadheader: FABLE_DEV_THREADHEADER, turnend: SEED_E992DE7C.ui.turnend },
      plugin: { marketplace: [] },
    };
    const host = makeHost(config);

    expect(run(host).outcome).toBe('migrated');
    const raw = fs.readFileSync(host.configFile, 'utf8');
    expect(raw).toContain('"JIRA_TOKEN": "${JIRA_TOKEN}"');
    expect(raw).toContain('"ANTHROPIC_BASE_URL": "${LLMUX_URL}"');
    const after = JSON.parse(raw);
    expect(Object.keys(after)).toEqual(['mcpServers', 'claude.env', 'ui', 'plugin']);
    expect(after.mcpServers).toEqual(config.mcpServers);
    expect(after.plugin).toEqual(config.plugin);
    expect(after.ui.turnend).toEqual(config.ui.turnend);
    expect(raw.endsWith('}\n')).toBe(true);
    expect(fs.statSync(host.configFile).mode & 0o777).toBe(0o600);
  });

  it('(f) no `ui` key: nothing written and no marker — the loader seeds the current default', () => {
    const host = makeHost({ mcpServers: {} });
    const before = fs.readFileSync(host.configFile, 'utf8');

    expect(run(host)).toMatchObject({ outcome: 'no-ui', arraysChanged: 0 });
    expect(fs.readFileSync(host.configFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER))).toBe(false);
  });

  it('(f) no config.json at all: no-ui, no marker', () => {
    const host = makeHost(undefined);

    expect(run(host).outcome).toBe('no-ui');
    expect(fs.existsSync(host.configFile)).toBe(false);
    expect(fs.existsSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER))).toBe(false);
  });

  it('skips an empty lines array — it falls back to the built-in default, which has the link', () => {
    const host = makeHost({ ui: { threadheader: { lines: [], themes: { minimal: { lines: [] } } } } });

    expect(run(host)).toMatchObject({ outcome: 'already-present', arraysChanged: 0 });
    expect(readConfig(host.configFile).ui.threadheader).toEqual({ lines: [], themes: { minimal: { lines: [] } } });
  });

  it('prepends a link line when there is neither a links field nor a header/section line', () => {
    const host = makeHost({
      ui: { threadheader: { lines: [[{ field: 'title' }], { fields: [{ field: 'model' }] }] } },
    });

    expect(run(host).outcome).toBe('migrated');
    expect(readConfig(host.configFile).ui.threadheader.lines[0]).toEqual({ block: 'context', fields: [LINK] });
  });

  it('a failed config write leaves no marker, so the next boot retries', () => {
    const host = makeHost({ ui: SEED_E992DE7C.ui });
    const before = fs.readFileSync(host.configFile, 'utf8');
    fault.failConfigWrite = true;

    expect(() => run(host)).toThrow('injected write failure');
    expect(fs.readFileSync(host.configFile, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER))).toBe(false);

    fault.failConfigWrite = false;
    expect(run(host).outcome).toBe('migrated');
  });

  it('unreadable config.json throws before anything is written', () => {
    const host = makeHost(undefined);
    fs.writeFileSync(host.configFile, '{ not json', 'utf8');

    expect(() => run(host)).toThrow();
    expect(fs.existsSync(path.join(host.dataDir, THREADHEADER_DASHBOARD_LINK_ONCE_MARKER))).toBe(false);
  });

  it('the e992de7c fixture is the literal pre-dashboardLink seed', () => {
    expect(JSON.stringify(SEED_E992DE7C)).not.toContain('dashboardLink');
    expect(Object.keys(SEED_E992DE7C.ui)).toEqual(['threadheader', 'turnend', 'dashboardheader']);
    expect(getSurfaceLines('threadheader', 'minimal').some((l) => fieldNames(l).includes('dashboardLink'))).toBe(true);
  });
});
