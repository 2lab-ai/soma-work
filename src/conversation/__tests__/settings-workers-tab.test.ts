/**
 * The settings page 작업 워커 tab, client half: one card per work worker — its name (the nickname, else the node id),
 * the node id beside a nickname, what it is and what runs on it — with a nickname field an admin saves in admin mode.
 * Functions are cut out of the shipped script.
 */

import { describe, expect, it } from 'vitest';
import { renderSettingsPage, SETTINGS_CLIENT_JS, SETTINGS_TABS } from '../settings-page';
import { WORKERS_CLIENT_JS, WORKERS_TAB_HTML } from '../settings-workers-tab';

const ALL_JS = `${WORKERS_CLIENT_JS}\n${SETTINGS_CLIENT_JS}`;

function clientFn(name: string): string {
  const plain = ALL_JS.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : ALL_JS.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = ALL_JS.indexOf('\n}\n', start);
  return ALL_JS.slice(start + 1, end + 2);
}
function load<T>(fns: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `var _wk = null; var _wkBusy = {};\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')}, setWk: function (v) { _wk = v; }, busy: function () { return _wkBusy; } };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

const GiB = 1024 ** 3;
const worker = (over: Record<string, unknown> = {}) => ({
  nodeId: 'studio-build-01',
  nickname: null,
  name: 'studio-build-01',
  self: true,
  platform: 'darwin',
  cpuCount: 16,
  cpuBusyPercent: 42.4,
  totalMemBytes: 64 * GiB,
  availableMemBytes: 24 * GiB,
  sampledAt: 1,
  tasks: 3,
  processes: 41,
  ...over,
});
const ROW = ['wkRow', 'wkPlatform', 'wkBytes', 'wkCpu', 'esc', 'escAttr'];

describe('작업 워커 tab — the page', () => {
  it('is an admin-only tab whose data loads the first time it is shown', () => {
    expect(SETTINGS_TABS.find((t) => t.id === 'workers')).toEqual({
      id: 'workers',
      label: '작업 워커',
      icon: 'tree',
      adminOnly: true,
    });
    const html = renderSettingsPage();
    expect(html).toContain(WORKERS_TAB_HTML);
    // The page grid is a side column then the content: a tab with no side puts its content in the 220px side column
    // (it did, on dev 2026-11-25: the worker card spilled out of its box).
    expect(WORKERS_TAB_HTML.indexOf('<aside class="side"')).toBeGreaterThan(-1);
    expect(WORKERS_TAB_HTML.indexOf('<aside class="side"')).toBeLessThan(WORKERS_TAB_HTML.indexOf('<main>'));
    expect(html).toContain("if (id === 'workers' && !_wkLoaded) loadWorkers();");
  });
});

describe('작업 워커 tab — a worker card', () => {
  const r = load<any>(ROW);

  it('names the worker by its node id until it has a nickname; says what it is and what runs on it', () => {
    r.setWk({ maxNickname: 24 });
    const html = r.wkRow(worker(), true);
    expect(html).toContain('<span class="wk-name">studio-build-01</span>');
    expect(html).not.toContain('class="wk-id"');
    expect(html).toContain('이 soma-work');
    expect(html).toContain('<dt>플랫폼</dt><dd>macOS</dd>');
    expect(html).toContain('<dt>코어</dt><dd>16개 · 사용 중 42%</dd>');
    // Before the second sample there is no CPU figure to give: the cores alone.
    expect(r.wkRow(worker({ cpuBusyPercent: null }), true)).toContain('<dt>코어</dt><dd>16개</dd>');
    expect(html).toContain('<dt>메모리</dt><dd>40GB / 64GB 사용</dd>');
    expect(html).toContain('<dt>지금</dt><dd>작업 3개 · 프로세스 41개</dd>');
    // The field: empty, the node id as its hint, at most the server's length; no reset without a nickname.
    expect(html).toContain('maxlength="24" value="" placeholder="studio-build-01"');
    expect(html).not.toContain('노드 이름으로');
  });

  it('a nickname is the name, the node id beside it, and the field holds it with a way back to the node id', () => {
    const html = r.wkRow(worker({ nickname: 'b01', name: 'b01' }), true);
    expect(html).toContain('<span class="wk-name">b01</span><span class="wk-id">studio-build-01</span>');
    expect(html).toContain('value="b01"');
    expect(html).toContain('>노드 이름으로</button>');
  });

  it('outside admin mode the field and buttons are disabled; markup in a name stays text', () => {
    const html = r.wkRow(worker({ nickname: '<b>x</b>', name: '<b>x</b>' }), false);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect((html.match(/ disabled/g) || []).length).toBe(3);
  });

  it('platforms and sizes in words', () => {
    expect([r.wkPlatform('darwin'), r.wkPlatform('linux'), r.wkPlatform('')]).toEqual(['macOS', 'Linux', '알 수 없음']);
    expect([r.wkBytes(137e9), r.wkBytes(1.5 * GiB)]).toEqual(['128GB', '1.5GB']);
    expect([r.wkCpu(null), r.wkCpu(7.6)]).toEqual(['측정 중', '8%']);
  });
});

describe('작업 워커 tab — renaming', () => {
  function page(answer: { ok: boolean; data?: unknown; error?: string }) {
    const writes: Array<[string, string, unknown]> = [];
    const status: Array<[string, boolean | undefined]> = [];
    const rendered: number[] = [];
    const r = load<any>(['wkRename', 'wkSubmit', 'wkReset'], {
      apiWrite: async (m: string, u: string, p: unknown) => {
        writes.push([m, u, p]);
        return answer;
      },
      renderWorkers: () => rendered.push(1),
      wkStatus: (t: string, e?: boolean) => status.push([t, e]),
    });
    r.setWk({ workers: [worker()] });
    return { r, writes, status, rendered };
  }

  it('saves the trimmed nickname for that worker and says so; an empty field goes back to the node id', async () => {
    const { r, writes, status } = page({ ok: true, data: { worker: worker({ nickname: 'b01', name: 'b01' }) } });
    const form = (value: string) => ({
      getAttribute: () => 'studio-build-01',
      querySelector: () => ({ value }),
    });
    r.wkSubmit({ preventDefault() {} }, form('  b01 '));
    await new Promise((res) => setTimeout(res, 0));
    expect(writes[0]).toEqual(['PUT', '/api/settings/workers/studio-build-01/nickname', { nickname: 'b01' }]);
    expect(status[0][0]).toContain('studio-build-01: 닉네임을 b01(으)로 저장했습니다');
    r.wkSubmit({ preventDefault() {} }, form('   '));
    await new Promise((res) => setTimeout(res, 0));
    expect(writes[1][2]).toEqual({ nickname: null });
  });

  it('one rename at a time per worker; a refusal says why', async () => {
    const { r, writes, status } = page({ ok: false, error: '관리자 모드를 켜야 작업 워커 닉네임을 바꿀 수 있습니다' });
    const first = r.wkRename('studio-build-01', 'a');
    r.wkRename('studio-build-01', 'b'); // while the first is on its way: ignored
    await first;
    expect(writes).toHaveLength(1);
    expect(status[0]).toEqual([
      'studio-build-01 닉네임을 저장하지 못했습니다 — 관리자 모드를 켜야 작업 워커 닉네임을 바꿀 수 있습니다',
      true,
    ]);
    expect(r.busy()).toEqual({});
  });

  it('a request that fails outright frees the field and says so', async () => {
    const status: Array<[string, boolean | undefined]> = [];
    const r = load<any>(['wkRename'], {
      apiWrite: async () => {
        throw new TypeError('Failed to fetch');
      },
      renderWorkers: () => undefined,
      wkStatus: (t: string, e?: boolean) => status.push([t, e]),
    });
    r.setWk({ workers: [worker()] });
    await r.wkRename('studio-build-01', 'b01');
    expect(r.busy()).toEqual({});
    expect(status[0]).toEqual(['studio-build-01 닉네임을 저장하지 못했습니다 — 연결 오류 — 다시 시도하세요', true]);
  });

  it('the side column filters the cards by name or node id', () => {
    const el = { innerHTML: '' };
    const filter = { value: '' };
    const r = load<any>(['renderWorkers', 'wkRow', 'wkBanner', 'wkPlatform', 'wkBytes', 'wkCpu', 'esc', 'escAttr'], {
      document: { getElementById: (id: string) => (id === 'wk-body' ? el : id === 'wk-filter' ? filter : null) },
      adminModeOn: () => true,
    });
    r.setWk({
      maxNickname: 24,
      workers: [worker({ nickname: 'b01', name: 'b01' }), worker({ nodeId: 'rack-02', name: 'rack-02' })],
    });
    filter.value = 'RACK';
    r.renderWorkers();
    expect(el.innerHTML).toContain('rack-02');
    expect(el.innerHTML).not.toContain('>b01<');
    filter.value = 'studio';
    r.renderWorkers();
    expect(el.innerHTML).toContain('>b01<');
    filter.value = 'nothing';
    r.renderWorkers();
    expect(el.innerHTML).toContain('찾는 이름의 작업 워커가 없습니다.');
  });
});
