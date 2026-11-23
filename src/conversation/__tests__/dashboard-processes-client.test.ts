/**
 * The 프로세스 tab and the card's CPU · 메모리 chip — executed from the shipped client code (cut out of
 * renderDashboardPage()'s template literal, as dashboard-detail-zones-client.test.ts does).
 *
 *   P1  the card's foot: 'proc' draws CPU · memory of the session's tree; nothing while no process lives
 *   P2  the tab bar: 프로세스 right of 세부 with the process count; disabled while none lives
 *   P3  the tab: node line, totals, one row per process in tree order; pause · resume only for a manager
 *   P4  the page: the tab's panel exists and its content shows only while the tab is open
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PRESETS, DETAIL_TABS, resolveLayouts } from '../../view-layout';
import { viewerScope } from '../__fixtures__/viewer-scope';
import { VIEW_LAYOUT_CLIENT_JS } from '../view-layout-client';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const one = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!one) throw new Error(`client var ${name} not found`);
  return cook(one[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  ({ fns, inject } = viewerScope(fns, inject));
  const all: Record<string, unknown> = { VIEW_BUILTINS: BUILTIN_PRESETS, ...inject };
  const names = Object.keys(all);
  const body = `${VIEW_LAYOUT_CLIENT_JS}\n${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, procChipOf: procChipOf, faceFootMetrics: faceFootMetrics };`;
  return new Function(...names, body)(...names.map((n) => all[n])) as T;
}
const PAGE = cook(TEMPLATE.slice(TEMPLATE.indexOf('<body'), TEMPLATE.indexOf('<script>', TEMPLATE.indexOf('<body'))));
const CSS = cook(
  TEMPLATE.slice(TEMPLATE.indexOf('<style>'), TEMPLATE.indexOf('</style>', TEMPLATE.indexOf('<style>'))),
);

const usage = (over: Record<string, unknown> = {}) => ({
  nodeId: 'n1',
  cpuCount: 12,
  rootAlive: true,
  processCount: 6,
  stoppedCount: 0,
  cpuPercent: 42.4,
  rssBytes: 1.23e9,
  ...over,
});

type Chip = { text: string; title: string; label?: string; tone?: string } | null;

describe('P1 — the card’s CPU · 메모리 chip', () => {
  const env = () => load<{ procChipOf: (u: unknown) => Chip; faceFootMetrics: (...a: unknown[]) => Chip[] }>([], []);

  it('reads CPU (100% = one core) and memory of the whole tree; its title says what it counts', () => {
    const chip = env().procChipOf(usage()) as NonNullable<Chip>;
    expect(chip.text).toBe('CPU 42% · 1.2GB');
    expect(chip.title).toContain('Claude Code와 그 아래 프로세스 6개');
    expect(chip.title).toContain('100% = 코어 1개, 이 노드 코어 12개');
    expect(chip.tone).toBeUndefined();
  });

  it('leads with the paused count in the wait tone; says when only leftovers remain', () => {
    const chip = env().procChipOf(
      usage({ stoppedCount: 2, rootAlive: false, cpuPercent: 0.25, rssBytes: 340e6 }),
    ) as NonNullable<Chip>;
    expect(chip.text).toBe('일시중지 2 · CPU 0.3% · 340MB');
    expect(chip.tone).toBe('wait');
    expect(chip.title).toContain('Claude Code는 끝났고 남은 프로세스 6개');
  });

  it('draws nothing while no process of the session lives', () => {
    expect(env().procChipOf(undefined)).toBeNull();
    expect(env().procChipOf(usage({ processCount: 0 }))).toBeNull();
  });

  it('every built-in face shows it at the foot, and the foot draws it from the card', () => {
    for (const id of ['1', '2', '3'] as const) {
      for (const mode of ['minimal', 'advanced'] as const) {
        const foot = resolveLayouts(undefined, mode, id).card.foot;
        expect(foot.find((c) => c.id === 'proc')?.on, `${id}/${mode}`).toBe(true);
      }
    }
    const out = env().faceFootMetrics({ procUsage: usage() }, '', [{ id: 'proc', on: true }], '', false);
    expect(out.map((m) => m?.text)).toEqual(['CPU 42% · 1.2GB']);
  });

  it('cardOf hands the session’s usage to the face', () => {
    const src = clientFn('cardOf');
    expect(src).toContain('if (s.procUsage) card.procUsage = s.procUsage;');
  });
});

describe('P2 — the tab bar: 프로세스 right of 세부', () => {
  type Tab = { id: string; label: string; count: string; title: string; empty: boolean };
  const env = () =>
    load<{ panelMidTabsOf: (s: unknown, tabs: string[], c: unknown) => Tab[] }>(
      ['toNum', 'panelMidTabsOf'],
      ['MID_TAB_LABEL'],
    );

  it('is in the catalog right after 세부 and on in both modes', () => {
    expect(DETAIL_TABS.indexOf('procs')).toBe(DETAIL_TABS.indexOf('info') + 1);
    for (const mode of ['minimal', 'advanced'] as const) {
      const tabs = resolveLayouts(undefined, mode, '1').detail.tabs;
      expect(tabs.find((t) => t.id === 'procs')?.on).toBe(true);
      const ids = tabs.map((t) => t.id);
      expect(ids.indexOf('procs')).toBeGreaterThan(ids.indexOf('info'));
    }
  });

  it('counts the live processes; a session with none has the tab disabled', () => {
    const [live] = env().panelMidTabsOf({ procUsage: usage() }, ['procs'], {});
    expect(live).toMatchObject({ id: 'procs', label: '프로세스', count: '6', empty: false });
    expect(live.title).toBe('프로세스 6개 · CPU 42% · 메모리 1.2GB');
    const [none] = env().panelMidTabsOf({}, ['procs'], {});
    expect(none).toMatchObject({ count: '', empty: true, title: '살아 있는 프로세스 없음' });
  });
});

describe('P3 — the tab’s content', () => {
  const env = () =>
    load<{
      panelProcsHtml: (st: unknown, canControl: boolean) => string;
      procsFailText: (s: number, c?: string) => string;
    }>(['toNum', 'esc', 'escAttr', 'panelProcsHtml', 'procsFailText'], ['PROC_STATE_LABEL']);
  const body = {
    node: { nodeId: 'n1', cpuCount: 12, cpuBusyPercent: 23, totalMemBytes: 64e9, availableMemBytes: 40e9 },
    session: {
      processCount: 3,
      stoppedCount: 1,
      cpuPercent: 55,
      rssBytes: 1.5e9,
      rootAlive: true,
      processes: [
        {
          pid: 200,
          depth: 0,
          role: 'root',
          state: 'running',
          cpuPercent: 50,
          rssBytes: 1e9,
          name: 'claude',
          command: 'claude --model …',
          startToken: 'Mon Nov 23 10:00:00 2026',
        },
        {
          pid: 300,
          depth: 1,
          role: 'child',
          state: 'stopped',
          cpuPercent: 0,
          rssBytes: 4e6,
          name: 'bash',
          command: 'bash -c npm test',
          startToken: 'Mon Nov 23 10:01:00 2026',
        },
        {
          pid: 400,
          depth: 2,
          role: 'orphan',
          state: 'zombie',
          cpuPercent: 5,
          rssBytes: 0,
          name: 'node <x>',
          command: '<script>',
          startToken: 'Mon Nov 23 10:02:00 2026',
        },
      ],
    },
  };

  it('a manager gets 일시중지 on a running process and 재개 on a paused one, each with the pid and its start time', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, true);
    expect(html).toContain('노드 <b>n1</b>');
    expect(html).toContain('코어 12개');
    expect(html).toContain('여유 메모리 40GB / 64GB');
    expect(html).toContain('프로세스 3개');
    expect(html).toContain('일시중지 1개');
    expect(html).toContain('data-proc-op="pause" data-pid="200" data-start="Mon Nov 23 10:00:00 2026"');
    expect(html).toContain('data-proc-op="resume" data-pid="300" data-start="Mon Nov 23 10:01:00 2026"');
    // The Claude Code process itself: its button warns the whole task stops.
    expect(html).toContain('이 작업 전체가 멈춰요');
    // A zombie has nothing to pause.
    expect(html).not.toContain('data-pid="400"');
    // Tree order and indentation by depth.
    expect(html.indexOf('>claude<')).toBeLessThan(html.indexOf('>bash<'));
    expect(html).toContain('padding-left:30px');
  });

  it('a reader sees the same table with no buttons', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, false);
    expect(html).toContain('>bash<');
    expect(html).not.toContain('data-proc-op');
  });

  it('escapes what a process names itself', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: {} }, true);
    expect(html).not.toContain('<script>');
    expect(html).toContain('node &lt;x&gt;');
  });

  it('a busy row’s button is disabled', () => {
    const html = env().panelProcsHtml({ status: 200, body, busy: { 300: true } }, true);
    expect(html).toMatch(/data-pid="300"[^>]*disabled/);
  });

  it('says why there is no table: loading, none alive, another instance, the monitor off, a failed read', () => {
    const e = env();
    expect(e.panelProcsHtml({ status: 0, body: null }, true)).toContain('읽는 중');
    expect(e.panelProcsHtml({ status: 200, body: { node: body.node, session: null } }, true)).toContain(
      '지금 이 작업의 프로세스는 없어요',
    );
    expect(e.panelProcsHtml({ status: 409 }, true)).toContain('다른 soma-work 인스턴스');
    expect(e.panelProcsHtml({ status: 503 }, true)).toContain('프로세스 모니터가 꺼져 있어요');
    expect(e.panelProcsHtml({ status: -1 }, true)).toContain('연결 오류');
  });

  it('a refused pause reads in the reader’s words', () => {
    const e = env();
    expect(e.procsFailText(409, 'stale')).toContain('프로세스가 바뀌었어요');
    expect(e.procsFailText(404, 'not-found')).toContain('이미 끝났어요');
    expect(e.procsFailText(403)).toContain('작업 소유자나 관리자 모드');
  });
});

describe('P4 — the page', () => {
  it('has the tab’s panel after 세부, shown only while 프로세스 is open', () => {
    expect(PAGE.indexOf('id="panel-procs"')).toBeGreaterThan(PAGE.indexOf('id="panel-info"'));
    expect(CSS).toContain('.slide-panel:not([data-midtab="procs"]) #panel-procs,');
  });

  it('opening the tab paints it; the poll stops itself once the tab or the card closes', () => {
    expect(clientFn('selectPanelMid')).toContain("else if (_panelMid === 'procs') renderPanelProcs();");
    const render = clientFn('renderPanelProcs');
    expect(render).toContain("if (_panelMid !== 'procs' || !panelSessionKey) {");
    expect(render).toContain('clearInterval(_procs.timer);');
  });
});
