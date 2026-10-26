/**
 * affectUI Agent Queue → LLM 가용량 · CRON 레인 (#444, .prd/affectui/re-agent-queue.md D1–D20).
 *
 * Executes the shipped client code cut out of renderDashboardPage()'s template (harness of
 * dashboard-cron-capacity-client.test.ts). Capacity input is the real buildCapacityView output.
 *
 *   D1   two sections, one grammar — static live region, lane holders
 *   D2   pill · D3 live countdown · D4 one polite announcement per load
 *   D5   tokens · D6 motion · D7 container queries
 *   D8   provider head pill · D9 20% line · D10 account marks · D11 account card
 *   D12  roving focus · D13 all-blocked shading · D14 folded chip marker
 *   D15  lane head pills · D16 four tiles · D17 next-fire queue · D18 live tile countdown
 *   D19  24h run chart · D20 the drawer stays the pinned card
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCapacityView, CAPACITY_LOW_PCT } from '../capacity-view';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function assertUnique(name: string) {
  const re = new RegExp(`^(?:async function|function|var|let|const) ${name}\\b`, 'gm');
  const n = (TEMPLATE.match(re) ?? []).length;
  if (n > 1) throw new Error(`client ${name} is declared ${n} times`);
}
function clientFn(name: string): string {
  assertUnique(name);
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  assertUnique(name);
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

// ── capacity fixture (synthetic, the harness's fixtures-agent-queue.ts shape) ──
const NOW_S = 1_800_000_000;
const NOW = NOW_S * 1000;
const H = 3600;
const D = 86400;
const w = (utilization: number, inSecs: number) => ({ utilization, resets_at: NOW_S + inSecs, resets_in_secs: inSecs });
const a = (over: Record<string, unknown>) => ({
  type: 'oauth',
  status: 'ok',
  order: 1,
  blocked: null,
  five_hour: null,
  seven_day: null,
  ...over,
});
const TIERS = {
  'claude:ai1': 'claude-max-20x',
  'claude:ai2': 'claude-max-20x',
  'claude:ai3': 'claude-max-5x',
  'claude:ai6': 'claude-max-20x',
  'claude:ai7': 'claude-max-20x',
  'claude:ai8': 'claude-max-20x',
  'claude:ai9': 'claude-max-20x',
  'claude:aa': 'claude-max-20x',
  'claude:ab': 'claude-max-20x',
};
const view = (accounts: Record<string, unknown>[]) =>
  buildCapacityView({ current: null, accounts } as never, TIERS as never, NOW) as any;
const ai1 = a({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.35, 2 * H + 600), seven_day: w(0.42, 3 * D) });
const ai2 = a({ name: 'claude:ai2@c', group: 'claude', five_hour: w(0.9, 40 * 60), seven_day: w(0.61, 2 * D + 5 * H) });
const ai3 = a({
  name: 'claude:ai3@c',
  group: 'claude',
  blocked: '5h 100.0% > 99%',
  five_hour: w(1, 80 * 60),
  seven_day: w(0.7, 4 * D),
});
const ai4 = a({
  name: 'claude:ai4@c',
  group: 'claude',
  status: 'cooldown',
  blocked: 'cooldown',
  cooldown_until: NOW_S + 25 * 60,
  five_hour: w(0.2, 3 * H),
  seven_day: w(0.3, 5 * D),
});
const ai6 = a({ name: 'claude:ai6@c', group: 'claude', blocked: 'paused', five_hour: w(0, H), seven_day: w(0, D) });
const codex = [
  a({ name: 'codex:ai5@c', group: 'codex', type: 'codex', seven_day: w(0.5, 3 * D + 2 * H) }),
  a({ name: 'codex:ai1@c', group: 'codex', type: 'codex', seven_day: w(0.95, 20 * H) }),
  a({ name: 'codex:ai2@c', group: 'codex', type: 'codex', blocked: '7d 100.0% > 99%', seven_day: w(1, D + 5 * H) }),
  a({ name: 'codex:ai9@c', group: 'codex', type: 'codex', seven_day: w(0, D) }),
];
const MAIN = view([ai1, ai2, ai3, ai4, ai6, ...codex]);
const CLAUDE = MAIN.groups.find((g: any) => g.group === 'claude');
const CODEX = MAIN.groups.find((g: any) => g.group === 'codex');
// every Claude account blocked: ai3 (5h ceiling, back at +80m) and ai7 (weekly ceiling)
const ai7 = a({
  name: 'claude:ai7@c',
  group: 'claude',
  blocked: '7d 100.0% > 99%',
  five_hour: w(0, H),
  seven_day: w(1, 2 * D),
});
const EMPTY = view([ai3, ai7]).groups[0];
// a usable but low pool: 10% left now
const LOW = view([a({ name: 'claude:ai8@c', group: 'claude', five_hour: w(0.9, H), seven_day: w(0.1, 2 * D) })])
  .groups[0];
// unblocked and no 5h reading · weekly spent without a block · no weekly reading at all
const ODD = view([
  a({ name: 'claude:ai9@c', group: 'claude', seven_day: w(0.2, 2 * D) }),
  a({ name: 'claude:aa@c', group: 'claude', five_hour: w(0.1, H), seven_day: w(1, 2 * D) }),
  a({ name: 'claude:ab@c', group: 'claude' }),
  a({ name: 'claude:ai1@c', group: 'claude', five_hour: w(0.2, H), seven_day: w(0.2, 2 * D) }),
]).groups[0];
const UNKNOWN = view([a({ name: 'codex:ai9@c', group: 'codex', type: 'codex', seven_day: w(0, D) })]).groups[0];

const AQ_VARS = ['CAP_TIERS', 'CAP_CAUSE', 'CAP_WORD', 'CAP_5H', 'CAP_7D', 'CAP_LOW_PCT', '_aqOpen', '_aqFocusKey'];
const AQ_FNS = [
  'esc',
  'escAttr',
  'pad2',
  'capCountdown',
  'capClockLabel',
  'capFmt1',
  'capGain',
  'capPct',
  'capCount',
  'capNextLine',
  'capDur',
  'capNextEvent',
  'capNextShort',
  'capBarRow',
  'capAssumed',
  'capDisclosure',
  'capAx',
  'capTimeline',
  'capAdvance',
  'aqLeft',
  'aqLeftSfx',
  'aqTime',
  'aqPill',
  'aqPlain',
  'capUnitState',
  'capReason',
  'capTierLabel',
  'capMs',
  'capPaused',
  'capFirstReturn',
  'capEmptyAt',
  'capProvPill',
  'capProvHead',
  'capUnitKey',
  'capMark',
  'capAccountCard',
  'capWorkers',
  'capChipLim',
  'capAnnounceDiff',
  'renderCapacitySummary',
  'renderCapacityGroup',
  'renderCapacity',
];
type Cap = Record<string, (...args: any[]) => any>;
/** Loaded on first use, so a missing function fails its own tests (RED per decision), not the file. */
function lazyFns(fns: string[], vars: string[]): Cap {
  let loaded: Cap | null = null;
  return new Proxy({} as Cap, {
    get: (_t, k: string) => {
      if (!loaded) loaded = load<Cap>(fns, vars);
      return loaded[k];
    },
  });
}
function once<T>(f: () => T): () => T {
  let v: { x: T } | null = null;
  return () => {
    if (!v) v = { x: f() };
    return v.x;
  };
}
const cap = lazyFns(AQ_FNS, AQ_VARS);
// Cutting ~40 functions out of the 15k-line template is slow on a loaded machine: pay it once,
// outside any single test's 5 s budget (each function is still looked up by name, so a missing
// one fails here and every test that needs it).
beforeAll(() => {
  try {
    void cap.aqLeft;
    void cron.aqLeft;
  } catch {
    // reported by the tests themselves
  }
}, 120_000);
/** A live countdown; its suffix (" 후 복귀") lives inside it so the tick can say "곧 복귀". */
const timeAt = (ms: number, text: string, sfx = '') =>
  `<time class="aq-left" role="timer" datetime="${new Date(ms).toISOString()}" data-aq-at="${ms}"${sfx ? ` data-aq-sfx="${sfx}"` : ''}>${text}${sfx}</time>`;
/** A local "HH:MM" (the chart labels each rolling hour by its start). */
const hhmm = (ms: number) => {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

describe('D1 — two sections, one grammar', () => {
  it('the live region is static, polite and outside both re-rendered sections', () => {
    const live = '<div class="aq-sr" id="aq-live" aria-live="polite" aria-atomic="true"></div>';
    expect(TEMPLATE).toContain(live);
    const at = TEMPLATE.indexOf(live);
    expect(at).toBeGreaterThan(TEMPLATE.indexOf('<aside class="cron-drawer"'));
    const capAt = TEMPLATE.indexOf('<section class="capacity" id="capacity"');
    expect(at < capAt || at > TEMPLATE.indexOf('</section>', capAt)).toBe(true);
  });
  it('the CRON lane holds the tiles, the queue column and the chart; the groups keep their id', () => {
    const lane = TEMPLATE.slice(
      TEMPLATE.indexOf('<div class="cron-lane" id="cron-lane"'),
      TEMPLATE.indexOf('<div class="kanban" id="kanban"'),
    );
    expect(lane).toContain('<div class="aq-lane-top" id="cron-lane-top"></div>');
    expect(lane).toContain(
      '<div class="aq-queue" id="cron-queue" role="group" aria-label="다음 실행 순서" data-aq-rove="cron-queue"></div>',
    );
    expect(lane).toContain('<div class="cron-groups" id="cron-groups"></div>');
    expect(lane).toContain('<div class="aq-chart" id="cron-lane-chart"></div>');
    expect(lane.indexOf('id="cron-queue"')).toBeLessThan(lane.indexOf('id="cron-groups"'));
    expect(lane.indexOf('id="cron-groups"')).toBeLessThan(lane.indexOf('id="cron-lane-chart"'));
    // the fold controls every part it hides (PR review R1)
    expect(lane).toContain('aria-controls="cron-lane-top cron-queue cron-groups cron-lane-chart"');
  });
});

describe('D2 — the pill', () => {
  it('a glyph-led status word, never a live region', () => {
    expect(cap.aqPill('paused', '⏸ 제한 2')).toBe('<span class="aq-pill is-paused">⏸ 제한 2</span>');
    expect(cap.aqPill('ok', '● 사용 가능')).not.toMatch(/role=|aria-live/);
  });
});

describe('D3 — a live countdown', () => {
  it('days · hours · minutes (floored) · seconds · soon', () => {
    expect(cap.aqLeft(NOW + (D + 5 * H + 59) * 1000, NOW)).toBe('1일 5시간');
    expect(cap.aqLeft(NOW + (80 * 60 + 59) * 1000, NOW)).toBe('1시간 20분');
    expect(cap.aqLeft(NOW + (24 * 60 + 59) * 1000, NOW)).toBe('24분');
    expect(cap.aqLeft(NOW + 42_500, NOW)).toBe('42초');
    expect(cap.aqLeft(NOW, NOW)).toBe('곧');
    expect(cap.aqLeft(NOW - 5000, NOW)).toBe('곧');
  });
  it('a <time role="timer"> carries the epoch it counts to', () => {
    expect(cap.aqTime(NOW + 25 * 60_000, NOW)).toBe(timeAt(NOW + 25 * 60_000, '25분'));
  });
  it('"곧" never reads "곧 후" (PR review R1)', () => {
    expect(cap.aqLeftSfx(NOW, NOW, ' 후 실행')).toBe('곧 실행');
    expect(cap.aqLeftSfx(NOW - 1, NOW, ' 후')).toBe('곧');
    expect(cap.aqLeftSfx(NOW + 60_000, NOW, ' 후 복귀')).toBe('1분 후 복귀');
    expect(cap.aqTime(NOW - 5000, NOW, ' 후 복귀')).toContain('>곧 복귀</time>');
    const due = cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, [job('j', 'due', -M, [])], null);
    expect(cron.cronQueue(due, NOW, null)).toContain('aria-label="due, 곧 실행, 1/1');
    expect(cron.cronStats(due, NOW)).toContain('data-aq-sfx=" 후">곧</time>');
    for (const out of [
      cron.cronQueue(due, NOW, null),
      cron.cronStats(due, NOW),
      cron.renderCronTileHead(due.groups[0], NOW),
    ])
      expect(out).not.toContain('곧 후');
  });
  it('capacity speaks epoch seconds, cron epoch ms — both read "24분" (review R1)', () => {
    expect(cap.capMs(NOW_S)).toBe(NOW);
    const cool = a({ ...ai4, cooldown_until: NOW_S + 24 * 60 });
    const g = view([ai1, cool]).groups[0];
    expect(g.units[1].returnAt).toBe(NOW_S + 24 * 60); // seconds, as the server sends it
    expect(cap.capProvHead(g, NOW)).toContain(timeAt((NOW_S + 24 * 60) * 1000, '24분', ' 후 복귀'));
    const q = cron.cronQueue(
      cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, [job('j', 'soon', 24 * M, [])], null),
      NOW,
      null,
    );
    expect(q).toContain(timeAt(NOW + 24 * M, '24분'));
  });
  it('the tick rewrites only what changed, and rests while the tab is hidden', () => {
    const { aqTickIn, aqTick } = load<Cap>(['aqLeft', 'aqLeftSfx', 'aqTickIn', 'aqTick'], [], {
      document: { hidden: true, getElementById: vi.fn() },
    });
    let writes = 0;
    const el = {
      _t: '',
      getAttribute: (n: string) => (n === 'data-aq-at' ? String(NOW + 90_000) : null),
      get textContent() {
        return this._t;
      },
      set textContent(v: string) {
        writes++;
        this._t = v;
      },
    };
    const root = { querySelectorAll: (sel: string) => (sel === '[data-aq-at]' ? [el] : []) };
    aqTickIn(root, NOW);
    expect(el.textContent).toBe('1분');
    aqTickIn(root, NOW + 1000);
    expect(writes).toBe(1);
    aqTickIn(root, NOW + 31_000);
    expect(el.textContent).toBe('59초');
    expect(writes).toBe(2);
    // the suffix rides along, and at zero "곧" drops its "후" (PR review R1)
    const sfx = {
      _t: '',
      getAttribute: (n: string) =>
        n === 'data-aq-at' ? String(NOW + 90_000) : n === 'data-aq-sfx' ? ' 후 복귀' : null,
      textContent: '',
    };
    const root2 = { querySelectorAll: () => [sfx] };
    aqTickIn(root2, NOW);
    expect(sfx.textContent).toBe('1분 후 복귀');
    aqTickIn(root2, NOW + 90_000);
    expect(sfx.textContent).toBe('곧 복귀');
    // hidden → no lookup at all
    const doc = { hidden: true, getElementById: vi.fn() };
    load<Cap>(['aqLeft', 'aqLeftSfx', 'aqTickIn', 'aqTick'], [], { document: doc }).aqTick();
    expect(doc.getElementById).not.toHaveBeenCalled();
    expect(typeof aqTick).toBe('function');
    // one 1 Hz tick for the page (review R1): an additive call on the shared timer path
    expect(clientFn('updateTimers')).toContain('updateTimersIn(document); aqTick();');
    expect(TEMPLATE).not.toMatch(/setInterval\(aqTick/);
    for (const id of ['capacity', 'cron-lane', 'cron-drawer'])
      expect(clientFn('aqTick')).toContain(`getElementById('${id}')`);
  });
});

describe('D4 — one polite sentence per load', () => {
  const snapOf = (g: any, state: string) => ({ available: true, groups: [{ ...g, state }] });
  it('the first load is a baseline', () => {
    expect(cap.capAnnounceDiff(null, MAIN, NOW)).toBe('');
  });
  it('entering all-blocked, recovering, and dropping under 20% each have a sentence', () => {
    expect(cap.capAnnounceDiff(snapOf(EMPTY, 'ok'), { available: true, groups: [EMPTY] }, NOW)).toBe(
      'Claude 계정이 모두 막힘 — 1시간 20분 후 복귀',
    );
    expect(cap.capAnnounceDiff(snapOf(CLAUDE, 'empty'), MAIN, NOW)).toBe('Claude 다시 사용 가능 — 계정 2/5');
    expect(cap.capAnnounceDiff(snapOf(LOW, 'ok'), { available: true, groups: [LOW] }, NOW)).toBe(
      'Claude 지금 20% 아래 — 0.1/1.0 계정',
    );
  });
  it('a countdown that only moved says nothing; the gravest change wins', () => {
    const moved = { available: true, groups: [{ ...CLAUDE, events: [] }, CODEX] };
    expect(cap.capAnnounceDiff(MAIN, moved, NOW + 60_000)).toBe('');
    const prev = {
      available: true,
      groups: [
        { ...LOW, group: 'x', state: 'ok' },
        { ...EMPTY, state: 'ok' },
      ],
    };
    const next = { available: true, groups: [{ ...LOW, group: 'x' }, EMPTY] };
    expect(cap.capAnnounceDiff(prev, next, NOW)).toBe('Claude 계정이 모두 막힘 — 1시간 20분 후 복귀');
  });
  it('the loaders wire it: capacity on each fetch, the lane on each board render', () => {
    expect(clientFn('loadCapacity')).toContain('capAnnounceDiff(');
    expect(clientFn('loadCapacity')).toContain('aqAnnounce(');
    expect(clientFn('syncCronLane')).toContain('cronAnnounceDiff(');
    expect(clientFn('syncCronLane')).toContain('aqAnnounce(');
    expect(clientFn('aqAnnounce')).toContain("getElementById('aq-live')");
  });
});

describe('D5–D7 — tokens, motion, responsive', () => {
  it('D5: warning text has its own token, darker in light theme (4.5:1 on white)', () => {
    // the region's own token blocks, not the shared :root (~3137) / light (~3203) blocks
    expect(TEMPLATE).toContain('\n:root { --aq-warn: var(--st-wait); --aq-warn-text: #f5a524; }\n');
    expect(TEMPLATE).toContain('\n[data-theme="light"] { --aq-warn-text: #9a5b00; }\n');
  });
  it('D6: reduced motion stops every queue animation; nothing loops forever', () => {
    expect(TEMPLATE).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.aq-mark, \.aq-q, \.aq-pop, \.aq-ch-ok, \.aq-ch-run, \.aq-ch-fail \{ animation: none; transition: none; \}/,
    );
    const aqRules = TEMPLATE.split('\n').filter((l) => /^\.aq-/.test(l));
    expect(aqRules.length).toBeGreaterThan(10);
    for (const l of aqRules) expect(l).not.toContain('infinite');
  });
  it('D7: the lane is a size container — 2×2 tiles at 560, stacked queue and a short chart under 600', () => {
    expect(TEMPLATE).toContain('.cron-lane { container: aqlane / inline-size; }');
    expect(TEMPLATE).toMatch(/\.aq-plot \{[^}]*height: 112px;/);
    expect(TEMPLATE).toMatch(
      /@container aqlane \(max-width: 599px\) \{ \.aq-lane-body \{ grid-template-columns: minmax\(0, 1fr\); \} \.aq-plot \{ height: 88px; \} \}/,
    );
    expect(TEMPLATE).toMatch(
      /@container aqlane \(max-width: 560px\) \{ \.aq-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(TEMPLATE).toContain('@media (pointer: coarse) { .aq-mark, .aq-q { min-height: 44px; }');
  });
});

describe('D8 — the provider head says whether its workers are paused, and until when', () => {
  it('blocked accounts: "⏸ 제한 p" with the earliest return counting down', () => {
    const h = cap.capProvHead(CLAUDE, NOW);
    expect(h).toContain(
      '<div class="aq-head"><span class="cap-pname">Claude</span><span class="aq-name">llmux · 계정 5</span>',
    );
    expect(h).toContain(
      `<span class="aq-pill is-paused">⏸ 제한 2 · ${timeAt((NOW_S + 25 * 60) * 1000, '25분', ' 후 복귀')}</span>`,
    );
  });
  it('all blocked > blocked > low > ok; nothing countable reads 계산 불가', () => {
    expect(cap.capProvHead(EMPTY, NOW)).toContain(
      `<span class="aq-pill is-empty">✗ 모두 막힘 · ${timeAt((NOW_S + 80 * 60) * 1000, '1시간 20분', ' 후 복귀')}</span>`,
    );
    expect(cap.capProvHead(LOW, NOW)).toContain('<span class="aq-pill is-low">▲ 부족</span>');
    const okOnly = view([ai1, ai2]).groups[0];
    expect(cap.capProvHead(okOnly, NOW)).toContain('<span class="aq-pill is-ok">● 사용 가능</span>');
    expect(cap.capProvHead(UNKNOWN, NOW)).toContain('<span class="aq-pill is-unknown">◌ 계산 불가</span>');
    const spent = { ...EMPTY, units: [], events: [] };
    expect(cap.capProvHead(spent, NOW)).toContain('<span class="aq-pill is-empty">✗ 소진</span>');
  });
  it('the card leads with that head', () => {
    const html = cap.renderCapacity(MAIN, NOW, 1200);
    expect(html).toContain('<div class="aq-head"><span class="cap-pname">Claude</span>');
    expect(html).not.toContain('<div class="cap-pname">');
  });
});

describe('D9 — the 20% line on each bar', () => {
  it('a dashed mark at CAPACITY_LOW_PCT inside the bar', () => {
    const row = cap.capBarRow(CLAUDE, 'h5', '5시간', '지금 쓸 수 있음', CLAUDE.now, 'dNow', NOW_S);
    expect(row).toMatch(
      /<div class="cap-bar" role="img" aria-label="[^"]*"><span style="width:[\d.]+%"><\/span><i class="cap-low" style="left:20%" title="20% 아래면 부족"><\/i><\/div>/,
    );
    expect(new Function(`${clientVar('CAP_LOW_PCT')} return CAP_LOW_PCT;`)()).toBe(CAPACITY_LOW_PCT);
  });
});

/** A mark's key in the CLAUDE fixture: its place in the server's order + its display name. */
const K = (name: string) => `claude|${['ai1', 'ai2', 'ai3', 'ai4', 'ai6'].indexOf(name)}|${name}`;

describe('D10 — account marks (workers)', () => {
  const workers = once(() => cap.capWorkers(CLAUDE, NOW, false, null, null));
  const mark = (name: string) => {
    const html = workers();
    const i = html.indexOf(`data-aq-key="${K(name)}"`);
    return html.slice(html.lastIndexOf('<button', i), html.indexOf('</button>', i) + 9);
  };
  it('a group named by its count, one mark per account in llmux order', () => {
    expect(workers()).toContain(
      '<div class="aq-workers" role="group" aria-label="Claude 계정 2/5 사용 가능" data-aq-rove="cap:claude">',
    );
    expect(workers()).toContain('<div class="aq-col-head"><span>계정</span> <b>2/5</b></div>');
    const order = ['ai1', 'ai2', 'ai3', 'ai4', 'ai6'].map((n) => workers().indexOf(`data-aq-key="${K(n)}"`));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
  });
  it('usable marks show the window that caps them; paused marks the reason and the return', () => {
    expect(mark('ai1')).toContain('class="aq-mark is-ok"');
    expect(mark('ai1')).toContain('<i class="aq-wdot is-wk" aria-hidden="true"></i><b>ai1</b>');
    expect(mark('ai2')).toContain('<i class="aq-wdot is-h5" aria-hidden="true"></i>');
    expect(mark('ai3')).toContain('class="aq-mark is-paused"');
    expect(mark('ai3')).toContain(`⏸ <b>ai3</b> · 5시간 한도 · ${timeAt((NOW_S + 80 * 60) * 1000, '1시간 20분')}`);
    expect(mark('ai3')).toContain('aria-label="ai3, Max x5, 5시간 한도, 1시간 20분 후 복귀"');
    expect(mark('ai4')).toContain('· 쿨다운 ·');
    expect(mark('ai4')).toContain('aria-label="ai4, x20 가정, 쿨다운, 25분 후 복귀"');
    expect(mark('ai6')).toContain('class="aq-mark is-held"');
    expect(mark('ai6')).toContain('<b>ai6</b> · 일시정지');
  });
  it('spent, unmeasured and left-out accounts each say so', () => {
    const odd = cap.capWorkers(ODD, NOW, false, null, null);
    expect(odd).toMatch(
      /class="aq-mark is-unmeasured"[^>]*data-aq-key="claude\|\d+\|ai9"[\s\S]*?<b>ai9<\/b> · 5시간 미측정/,
    );
    expect(odd).toMatch(/class="aq-mark is-spent"[^>]*data-aq-key="claude\|\d+\|aa"[\s\S]*?<b>aa<\/b> · 소진/);
    expect(odd).toMatch(/class="aq-mark is-out"[^>]*data-aq-key="claude\|\d+\|ab"[\s\S]*?<b>ab<\/b> · 측정 없음/);
    expect(cap.capWorkers(CODEX, NOW, false, null, null)).toMatch(
      /is-out"[^>]*data-aq-key="codex\|\d+\|ai9"[\s\S]*?티어 미지정/,
    );
    expect(
      cap.capReason({ blocked: true, counted: true, blocks: { weekly: true, fiveHour: true, cooldownUntil: 1 } }),
    ).toBe('주간 한도');
  });
  it('the state comes from counted / blocked / unmeasured5h / now — binding only names the window (review R1)', () => {
    expect(cap.capUnitState({ counted: true, blocked: false, unmeasured5h: false, now: 0.2 })).toBe('ok');
    expect(cap.capUnitState({ counted: true, blocked: false, unmeasured5h: false, now: 0, binding: '7d' })).toBe(
      'spent',
    );
    expect(cap.capUnitState({ counted: true, blocked: true, now: 0 })).toBe('paused');
    expect(cap.capUnitState({ counted: true, blocked: false, unmeasured5h: true, now: 0 })).toBe('unmeasured');
    expect(cap.capUnitState({ counted: false, blocked: true, excluded: 'held' })).toBe('held');
    expect(cap.capUnitState({ counted: false, excluded: 'unknownTier', now: 0.5 })).toBe('out');
  });
  it('no usage bars, no %, no tier on a mark — 12 §7 stays', () => {
    const marks = workers().slice(workers().indexOf('<div class="aq-marks">'));
    expect(marks).not.toContain('style="width');
    expect(marks).not.toContain('%');
    expect(marks).not.toMatch(/>x20<|>Max x/);
    for (const gone of ['cap-units', 'cap-unitbar', '계정분', '상한']) expect(workers()).not.toContain(gone);
  });
  it('one tab stop: the first mark, or the last one focused', () => {
    expect(mark('ai1')).toContain('tabindex="0"');
    expect(mark('ai3')).toContain('tabindex="-1"');
    const again = cap.capWorkers(CLAUDE, NOW, false, null, K('ai3'));
    expect(again).toContain(`data-aq-key="${K('ai3')}" tabindex="0"`);
    expect(again).toContain(`data-aq-key="${K('ai1')}" tabindex="-1"`);
  });
  it('narrow: the usable accounts fold into one mark; the exceptions stay', () => {
    const n = cap.capWorkers(CLAUDE, NOW, true, null, null);
    expect(n).toContain('data-aq-key="claude|*ok"');
    expect(n).toContain('● 사용 가능 2');
    expect(n).not.toContain(`data-aq-key="${K('ai1')}"`);
    expect(n).toContain(`data-aq-key="${K('ai3')}"`);
  });
  it('the card shows them between its bars and its timeline', () => {
    const card = cap.renderCapacityGroup(CLAUDE, NOW, 1200);
    expect(card.indexOf('class="aq-workers"')).toBeGreaterThan(card.indexOf('cap-bar-row is-wk'));
    expect(card.indexOf('class="aq-workers"')).toBeLessThan(card.indexOf('class="cap-tl-wrap"'));
  });
});

describe('D11 — the account card', () => {
  const opened = once(() => cap.capWorkers(CLAUDE, NOW, false, K('ai3'), null));
  it('a dialog with a close button, opened from its mark', () => {
    expect(opened()).toMatch(/data-aq-key="claude\|2\|ai3"[^>]*aria-expanded="true"/);
    expect(opened().match(/aria-expanded="true"/g)?.length).toBe(1);
    expect(opened()).toContain('<div class="aq-pop" role="dialog" aria-label="ai3 세부" data-aq-for="claude|2|ai3">');
    expect(opened()).toContain('<button type="button" class="aq-pop-close" aria-label="닫기">×</button>');
    expect(opened().match(/class="aq-pop"/g)?.length).toBe(1);
  });
  it('every row comes from a CapacityUnit field', () => {
    expect(opened()).toContain('<span class="aq-pop-kind">Max x5</span>');
    expect(opened()).toContain('<dt>지금 쓸 수 있음</dt><dd>0%</dd>');
    expect(opened()).toContain('<dt>이번 주 남음</dt><dd>30%</dd>');
    expect(opened()).toContain('<dt>상태</dt><dd>5시간 한도</dd>');
    expect(opened()).toMatch(
      /<div class="is-wide"><dt>복귀<\/dt><dd>\d\d:\d\d · <time class="aq-left"[^>]*>1시간 20분<\/time><\/dd>/,
    );
    const ok = cap.capWorkers(CLAUDE, NOW, false, K('ai1'), null);
    expect(ok).toContain('<dt>먼저 닿는 창</dt><dd>일주일</dd>');
    expect(ok).toContain('<dt>지금 쓸 수 있음</dt><dd>58%</dd>');
    expect(cap.capWorkers(CLAUDE, NOW, false, K('ai4'), null)).toContain('<span class="aq-pop-kind">x20 가정</span>');
    for (const gone of ['계정분', '상한']) expect(opened()).not.toContain(gone);
  });
  it('the folded usable mark opens a list of its accounts', () => {
    const n = cap.capWorkers(CLAUDE, NOW, true, 'claude|*ok', null);
    expect(n).toContain('aria-label="사용 가능 계정 세부"');
    expect(n).toContain('<dt>ai1</dt><dd>지금 58% · 이번 주 58%</dd>');
    expect(n).toContain('<dt>ai2</dt><dd>지금 10% · 이번 주 39%</dd>');
  });
  it('a repaint keeps it open and keeps the focus where it was', () => {
    const paint = clientFn('paintCapacity');
    expect(paint).toContain('aqFocusedKey(');
    expect(paint).toContain('aqRestoreFocus(');
    expect(paint).toContain('aqPlacePops(');
    expect(clientFn('renderCapacityGroup')).toContain('_aqOpen');
  });
});

describe('D10–D12 — identity is the place in the server order, never the (masked) name (final review)', () => {
  // email_anonymous: llmux masks ai1@corp.example and ai2@corp.example both to "a***".
  const masked = buildCapacityView(
    {
      current: null,
      email_anonymous: true,
      accounts: [
        a({
          name: 'claude:ai1@corp.example',
          group: 'claude',
          blocked: '5h 100.0% > 99%',
          five_hour: w(1, 40 * 60),
          seven_day: w(0.5, 3 * D),
        }),
        a({ name: 'claude:ai2@corp.example', group: 'claude', five_hour: w(0.2, H), seven_day: w(0.1, 3 * D) }),
      ],
    } as never,
    {} as never,
    NOW,
  ).groups[0] as any;
  it('the server gives both the same display name and no raw email', () => {
    expect(masked.units.map((u: any) => u.name)).toEqual(['a***', 'a***']);
    expect(JSON.stringify(masked)).not.toContain('corp.example');
  });
  it('each mark has its own key; selecting the blocked first one opens ITS card', () => {
    const html = cap.capWorkers(masked, NOW, false, 'claude|0|a***', null);
    expect(html).toContain('data-aq-key="claude|0|a***" tabindex="0"');
    expect(html).toContain('data-aq-key="claude|1|a***" tabindex="-1"');
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
    expect(html).toMatch(/data-aq-key="claude\|0\|a\*\*\*"[^>]*aria-expanded="true"/);
    const card = html.slice(html.indexOf('<div class="aq-pop"'));
    expect(card).toContain('data-aq-for="claude|0|a***"');
    expect(card).toContain('<dt>상태</dt><dd>5시간 한도</dd>');
    expect(card).not.toContain('사용 가능');
    // and the second one opens its own
    const second = cap.capWorkers(masked, NOW, false, 'claude|1|a***', 'claude|1|a***');
    const card2 = second.slice(second.indexOf('<div class="aq-pop"'));
    expect(card2).toContain('<dt>상태</dt><dd>사용 가능</dd>');
    expect(second).toContain('data-aq-key="claude|1|a***" tabindex="0"');
    expect(second.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html + second).not.toContain('corp.example');
  });
  it('a key whose place now holds another account opens nothing (the order shifted)', () => {
    expect(cap.capWorkers(masked, NOW, false, 'claude|0|ai9', null)).not.toContain('class="aq-pop"');
  });
  it('the same key drives the card lookup, the roving stop and focus restore', () => {
    expect(clientFn('capAccountCard')).toContain('capUnitKey(g, i, x) === key');
    expect(clientFn('capWorkers')).toContain('keys.push(capUnitKey(g, i, u));');
    expect(clientFn('paintCapacity')).toContain('aqRestoreFocus(view, focusKey);');
  });
});

describe('D12 — roving focus', () => {
  const items = ['claude|0|ai1', 'claude|1|ai2', 'claude|2|ai3'].map((k) => {
    const attrs: Record<string, string> = { 'data-aq-key': k, tabindex: '-1' };
    const item: any = {
      focus: vi.fn(),
      getAttribute: (n: string) => attrs[n],
      setAttribute: (n: string, v: string) => {
        attrs[n] = v;
      },
      attrs,
    };
    item.closest = () => item;
    return item;
  });
  const box = { querySelectorAll: () => items, getAttribute: () => 'cap:claude' };
  const rove = lazyFns(['aqRove'], ['_aqFocusKey']);
  const key = (k: string, from: number) => {
    const e = { key: k, target: items[from], preventDefault: vi.fn() };
    return { handled: rove.aqRove(e, box), e };
  };
  it('arrows walk, Home and End jump, the tab stop follows', () => {
    expect(key('ArrowRight', 0).handled).toBe(true);
    expect(items[1].focus).toHaveBeenCalled();
    expect(items[1].attrs.tabindex).toBe('0');
    expect(items[0].attrs.tabindex).toBe('-1');
    key('End', 0);
    expect(items[2].attrs.tabindex).toBe('0');
    key('Home', 2);
    expect(items[0].attrs.tabindex).toBe('0');
    key('ArrowUp', 0);
    expect(items[0].attrs.tabindex).toBe('0');
    key('ArrowDown', 1);
    expect(items[2].attrs.tabindex).toBe('0');
  });
  it('other keys pass through', () => {
    const { handled, e } = key('a', 0);
    expect(handled).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
  it('Escape closes the card and returns focus to its mark', () => {
    expect(TEMPLATE).toContain("if (e.key === 'Escape' && _aqOpen) { aqCloseCard(true); return; }");
    expect(clientFn('aqCloseCard')).toContain('aqFocusKey(');
  });
});

describe('D13 — the all-blocked stretch on the timeline', () => {
  it('shaded from now to the first refill, only when every account is blocked', () => {
    const W = 800;
    const tl = cap.capTimeline(EMPTY, W, NOW_S);
    const m = /<rect class="cap-tl-lim" x="16" y="0" width="([\d.]+)"/.exec(tl);
    expect(m).not.toBeNull();
    const x1 = 16 + cap.capAx(80 * 60) * (W - 32);
    expect(Number(m?.[1])).toBeCloseTo(x1 - 16, 0);
    expect(tl).toMatch(/<title>모두 막힘 — \d\d:\d\d까지<\/title>/);
    expect(cap.capTimeline(CLAUDE, W, NOW_S)).not.toContain('cap-tl-lim');
  });
  it('all blocked with nothing coming back in 7 days: the axis and a stretch to its end (final review)', () => {
    const W = 800;
    const none = { ...EMPTY, events: [] };
    const tl = cap.capTimeline(none, W, NOW_S);
    expect(tl).toContain('<svg class="cap-tl"');
    expect(tl).toContain('class="cap-tl-axis"');
    expect(tl).toMatch(new RegExp(`<rect class="cap-tl-lim" x="16" y="0" width="${(W - 32).toFixed(1)}"`));
    expect(tl).toContain('<title>모두 막힘 — 7일 안에 복귀 없음</title>');
    // and the card draws it
    expect(cap.renderCapacityGroup(none, NOW, W + 36)).toContain('cap-tl-lim');
    // a pool that is not empty and has nothing coming still draws no timeline
    expect(cap.capTimeline({ ...LOW, events: [] }, W, NOW_S)).toBe('');
    expect(cap.capTimeline(LOW, W, NOW_S)).not.toContain('cap-tl-lim');
  });
});

describe('D14 — the folded chip says how many are paused', () => {
  const summary = once(() => cap.renderCapacitySummary(MAIN, NOW));
  it('after the measures, before the ⚠ flag, with the first return counting down', () => {
    expect(summary()).toMatch(/cap-chip is-ok"[^>]*>Claude <span class="cap-m is-now">/);
    expect(summary()).toContain(
      `<em>54%</em></span> <i class="cap-chip-lim">⏸ 2 · ${timeAt((NOW_S + 25 * 60) * 1000, '25분')}</i> <i class="cap-chip-flag">⚠ x20 가정 1</i>`,
    );
    expect(summary()).toMatch(/aria-label="Claude [^"]*제한 2 — 25분 후 첫 복귀/);
  });
  it('a pool with nothing blocked has no marker', () => {
    expect(cap.renderCapacitySummary({ available: true, groups: [view([ai1, ai2]).groups[0]] }, NOW)).not.toContain(
      'cap-chip-lim',
    );
  });
});

// ── CRON fixture ──
const M = 60_000;
const HR = 3_600_000;
const run = (ago: number, over: Record<string, unknown> = {}) => ({
  executedAt: NOW - ago,
  status: 'success',
  executionPath: 'new_thread',
  ...over,
});
const job = (id: string, name: string, nextIn: number | null, runs: unknown[], over: Record<string, unknown> = {}) => ({
  id,
  name,
  expression: '0 * * * *',
  owner: 'U1',
  channel: 'C1',
  mode: 'default',
  target: 'channel',
  model: 'default',
  nextRunAt: nextIn === null ? null : NOW + nextIn,
  lastRunAt: null,
  historyCap: 20,
  runs,
  ...over,
});
const JOBS = [
  job('job-qa', 'nightly-qa', 42 * M, [
    run(1 * HR),
    run(2 * HR, { status: 'failed', error: 'staging 502' }),
    run(30 * HR),
  ]),
  job('job-digest', 'morning-digest', 14 * HR, [
    run(22 * M, { session: { headline: 'd', boardKey: 'k-dig', live: true, activityState: 'waiting' } }),
  ]),
  job(
    'job-deps',
    'dependency-audit',
    12 * M,
    [run(15 * M), run(30 * M, { status: 'queued', executionPath: 'busy_queue' }), run(45 * M)],
    { historyCap: 3 },
  ),
  job('job-retro', 'weekly-retro', 6 * 24 * HR, [run(5 * 24 * HR, { executionPath: 'dm' })]),
  job('job-monthly', 'monthly-bill', null, []),
];
const card = (key: string, jobId: string, name: string, over: Record<string, unknown> = {}) => ({
  key,
  title: name,
  displayHeadline: name,
  cronJob: { id: jobId, name },
  lastActivity: new Date(NOW - M).toISOString(),
  ...over,
});
const BOARD = {
  working: [card('k-qa', 'job-qa', 'nightly-qa', { activeLegStartedAtMs: NOW - 4 * M })],
  waiting: [card('k-dig', 'job-digest', 'morning-digest')],
  idle: [],
  closed: [],
};
const CRON_VARS = ['CLOCK_SVG', 'AQ_NICE'];
const CRON_FNS = [
  'esc',
  'escAttr',
  'pad2',
  'capCountdown',
  'capClockLabel',
  'capDur',
  'aqLeft',
  'aqLeftSfx',
  'aqTime',
  'aqPill',
  'aqPlain',
  'isCronCard',
  'cronGroupKey',
  'cronCardTime',
  'planCronLane',
  'cronRunGlyph',
  'cronScheduleLabel',
  'cronAgo',
  'cronRunWhen',
  'cronCardAsRun',
  'cronGroupRuns',
  'renderCronStrip',
  'renderCronTileHead',
  'renderCronLaneHead',
  'cronDayRuns',
  'cronStats',
  'cronQueue',
  'cronRunChart',
  'cronAnnounceSnap',
  'cronAnnounceDiff',
];
const cron = lazyFns(CRON_FNS, CRON_VARS);
const plan = once(() => cron.planCronLane(BOARD, JOBS, null));
const groupOf = (id: string) => plan().groups.find((g: any) => g.jobId === id);

describe('D15 — the lane head keeps its words as pills', () => {
  it('● 실행 중 n · ▲ 응답 필요 n', () => {
    const h = cron.renderCronLaneHead(plan());
    expect(h).toContain('<h3>CRON</h3><span class="count">5</span>');
    expect(h).toContain('<span class="aq-pill is-run">● 실행 중 1</span>');
    expect(h).toContain('<span class="aq-pill is-wait">▲ 응답 필요 1</span>');
    expect(h).not.toContain('cron-lane-note');
  });
});

describe('D16 — four numbers, each from a named field', () => {
  const stats = once(() => cron.cronStats(plan(), NOW));
  it('next fire, running r/N, 24h runs and 24h failures', () => {
    expect(stats()).toMatch(/^<dl class="aq-stats">/);
    expect(stats()).toMatch(
      new RegExp(
        `<dt>다음 실행</dt><dd title="[^"]*nextRunAt[^"]*">${timeAt(NOW + 12 * M, '12분', ' 후').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<span class="aq-of">dependency-audit</span></dd>`,
      ),
    );
    expect(stats()).toMatch(
      /<dt>실행 중<\/dt><dd title="[^"]*다른 인스턴스 그룹 포함[^"]*">1<span class="aq-of is-n">\/5<\/span><\/dd>/,
    );
    // new_thread / idle_inject write success once the fired turn settles (dm / thread_reply once
    // sent); 진행 중 = a success record whose own session is busy again (strip's ● / ▲)
    expect(stats()).toMatch(
      /<dt>24시간 실행 기록<\/dt><dd title="지난 24시간 실행 기록 5건\(대기열 항목 제외\): 성공\(세션 쉼\) 3 · 실패 1 · 진행 중\(성공 기록, 세션이 지금 실행 중·응답 대기\) 1[^"]*">≥5<\/dd>/,
    );
    expect(stats()).toMatch(
      /<div class="aq-stat" data-kind="failed"><dt>실패 · 24시간<\/dt><dd title="[^"]*">≥1<\/dd>/,
    );
  });
  it('a job whose kept history starts inside the window turns the counts into lower bounds, and says why', () => {
    expect(stats()).toMatch(/title="[^"]*dependency-audit 기록은 보관 한도 3회라 \d\d:\d\d부터[^"]*">≥5</);
    const d = cron.cronDayRuns(plan(), NOW);
    // records only: qa 1h ok + 2h failed · deps 15m + 45m ok (the queue entry is not a run) ·
    // digest 22m in progress — its turn settled (success recorded) and the session it created now
    // waits for a reply (the strip's rule, trinity R2). The running qa card has no record yet.
    expect([d.n, d.ok, d.f, d.run, d.pending, d.unknown]).toEqual([5, 3, 1, 1, 1, 0]);
    expect(stats()).toMatch(/기록 전 카드 1개\(실행 중 1 · 결과 미확인 0\)는 세지 않음/);
    expect(d.cutFrom).toBe(NOW - 45 * M);
  });
  it('no next fire and no failure read plainly', () => {
    const plain = cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, [JOBS[4]], null);
    const out = cron.cronStats(plain, NOW);
    expect(out).toContain('<dt>다음 실행</dt><dd title="8일 안에 없음">—</dd>');
    expect(out).toContain('<div class="aq-stat"><dt>실패 · 24시간</dt>');
    expect(out).toMatch(/<dt>24시간 실행 기록<\/dt><dd title="[^"]*">0<\/dd>/);
  });
  it('a card with no record is never a success: not counted, not drawn, named as unknown (review R1)', () => {
    const idle = card('k-old', 'job-qa', 'nightly-qa', { lastActivity: new Date(NOW - 3 * HR).toISOString() });
    const p = cron.planCronLane({ ...BOARD, idle: [idle] }, JOBS, null);
    const d = cron.cronDayRuns(p, NOW);
    expect([d.n, d.ok, d.unknown]).toEqual([5, 3, 1]);
    expect(cron.cronStats(p, NOW)).toMatch(/">≥5<span class="aq-of">\+미확인 1<\/span><\/dd>/);
    const ch = cron.cronRunChart(p, NOW);
    const sums = [...ch.matchAll(/title="\d\d:\d\d부터 1시간 · 성공 (\d+) · 실패 (\d+) · 진행 중 (\d+)"/g)];
    expect(sums.reduce((t, m) => t + Number(m[1]), 0)).toBe(3);
    expect(ch).toContain('기록 전 카드 2개는 세지 않음.');
  });
  it('the tiles and the chart agree with the strip on every record shape the server emits (trinity R2)', () => {
    // cron-view.ts buildCronJobsView: an injected run (someone else's session) comes back
    // live:true but idle; an earlier run in a reused thread and a queued fire come back
    // live:false, idle. Only the newest run of a thread this job created keeps working/waiting.
    const shape = (session: Record<string, unknown>) => [
      job('job-s', 'shape', 30 * M, [run(10 * M, { session: { headline: 'h', boardKey: 'k-x', ...session } })]),
    ];
    const empty = { working: [], waiting: [], idle: [], closed: [] };
    const cases: [Record<string, unknown>, 'ok' | 'run'][] = [
      [{ live: true, activityState: 'idle' }, 'ok'], // injected into a human session
      [{ live: false, activityState: 'idle', earlierInThread: true }, 'ok'], // an earlier run of the thread
      [{ live: true, activityState: 'working' }, 'run'], // its own session still runs
      [{ live: true, activityState: 'waiting' }, 'run'], // its own session waits for a reply
    ];
    for (const [session, kind] of cases) {
      const p = cron.planCronLane(empty, shape(session), null);
      const d = cron.cronDayRuns(p, NOW);
      expect([d.ok, d.run]).toEqual(kind === 'ok' ? [1, 0] : [0, 1]);
      // the strip's glyph for the same record says the same thing
      const glyph = cron.cronRunGlyph(p.groups[0].job.runs[0]).cls;
      expect(kind === 'run' ? ['run', 'wait'] : ['ok']).toContain(glyph);
    }
    const running = cron.planCronLane(empty, shape({ live: true, activityState: 'working' }), null);
    expect(cron.cronRunChart(running, NOW)).toMatch(/<i class="aq-ch-run" style="height:[1-9][\d.]*%"><\/i>/);
    expect(cron.cronStats(running, NOW)).toContain('진행 중(성공 기록, 세션이 지금 실행 중·응답 대기) 1');
  });
});

describe('D17 — the next-fire queue', () => {
  it('soonest first, each chip a button that opens its job’s drawer', () => {
    const q = cron.cronQueue(plan(), NOW, null);
    // the queue is this instance's schedules; the 실행 중 tile's N also counts other instances' groups
    expect(q).toMatch(
      /<div class="aq-col-head" title="[^"]*다른 인스턴스 그룹은 스케줄이 없어 빠진다"><span>다음 실행<\/span> <b>4<\/b><\/div>/,
    );
    const order = ['job-deps', 'job-qa', 'job-digest', 'job-retro'].map((id) =>
      q.indexOf(`data-cron-group="id:${id}"`),
    );
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect(q).not.toContain('job-monthly');
    expect(q).toContain(
      `<button type="button" class="aq-q" data-cron-group="id:job-deps" data-aq-key="id:job-deps" tabindex="0" aria-label="dependency-audit, 12분 후 실행, 1/4 — 지난 실행 보기">`,
    );
    expect(q).toContain(`<span class="aq-q-name">dependency-audit</span>${timeAt(NOW + 12 * M, '12분')}</button>`);
    expect(q).toMatch(/data-aq-key="id:job-qa" tabindex="-1"/);
    expect(cron.cronQueue(plan(), NOW, 'id:job-qa')).toMatch(/data-aq-key="id:job-qa" tabindex="0"/);
  });
  it('four chips, then +N; an empty queue says so', () => {
    const many = [0, 1, 2, 3, 4, 5].map((i) => job(`j${i}`, `job ${i}`, (i + 1) * M, []));
    const q = cron.cronQueue(
      cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, many, null),
      NOW,
      null,
    );
    expect(q.match(/class="aq-q"/g)?.length).toBe(4);
    expect(q).toContain('<span class="aq-more">+2</span>');
    const none = cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, [JOBS[4]], null);
    expect(cron.cronQueue(none, NOW, null)).toContain('<div class="aq-empty">8일 안에 예정 없음</div>');
  });
});

describe('D18 — the tile counts down live', () => {
  it('the next fire’s remaining time is a <time data-aq-at>', () => {
    const h = cron.renderCronTileHead(groupOf('job-deps'), NOW);
    expect(h).toMatch(
      new RegExp(
        `다음 \\d\\d:\\d\\d \\(${timeAt(NOW + 12 * M, '12분', ' 후').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`,
      ),
    );
  });
});

describe('D19 — 24 hours of runs', () => {
  const chart = once(() => cron.cronRunChart(plan(), NOW));
  it('24 rolling-hour columns, each labelled by its start, that add up to the 24h tile', () => {
    expect(chart().match(/class="aq-ch-col"/g)?.length).toBe(24);
    const sums = [...chart().matchAll(/title="(\d\d:\d\d)부터 1시간 · 성공 (\d+) · 실패 (\d+) · 진행 중 (\d+)"/g)];
    expect(sums.length).toBe(24);
    // a column is the hour from its start, not a clock hour (PR review R1)
    expect(sums[0][1]).toBe(hhmm(NOW - 24 * HR));
    expect(sums[23][1]).toBe(hhmm(NOW - HR));
    expect(sums.reduce((t, m) => t + Number(m[2]) + Number(m[3]) + Number(m[4]), 0)).toBe(5);
    expect(sums.reduce((t, m) => t + Number(m[3]), 0)).toBe(1);
    expect(sums.reduce((t, m) => t + Number(m[4]), 0)).toBe(1);
    expect(chart()).toMatch(/<i class="aq-ch-fail" style="height:[1-9][\d.]*%"><\/i>/);
    expect(chart()).toMatch(/<i class="aq-ch-run" style="height:[1-9][\d.]*%"><\/i>/);
    // the legend defines its words: 성공 = a success record whose session rests
    expect(chart()).toContain(
      '<span class="aq-ch-key" title="성공 기록, 세션 쉼"><i class="is-ok" aria-hidden="true"></i>성공</span>',
    );
    expect(chart()).toContain(
      '<span class="aq-ch-key" title="성공 기록, 세션이 지금 실행 중·응답 대기"><i class="is-run" aria-hidden="true"></i>진행 중</span>',
    );
  });
  it('hatches the stretch a truncated history cannot speak for', () => {
    expect(chart()).toContain(
      '<div class="aq-ch-cut" style="left:0;width:96.9%" title="이 구간은 dependency-audit 기록이 보관 한도로 잘려 실제보다 적을 수 있음"></div>',
    );
  });
  it('is an image with a sentence', () => {
    expect(chart()).toContain('<span class="aq-chart-title">실행 기록 · 24시간</span>');
    expect(chart()).toMatch(
      /<div class="aq-plot" role="img" aria-label="지난 24시간 크론 실행 기록 5건: 성공 3건, 실패 1건, 진행 중 1건, 가장 많은 1시간 \d\d:\d\d부터 4건\. \d\d:\d\d 이전은 일부 잡 기록이 잘림\. 기록 전 카드 1개는 세지 않음\.">/,
    );
    expect(chart()).toContain(
      '<div class="aq-ch-axis"><span>24시간 전</span><span>12시간 전</span><span>지금</span></div>',
    );
  });
});

describe('D4 (lane) — the lane announces a new failure or a new wait, never on its first sight', () => {
  const snap0 = once(() => cron.cronAnnounceSnap(plan()));
  it('baseline', () => {
    expect(cron.cronAnnounceDiff(null, snap0())).toBe('');
    expect(cron.cronAnnounceDiff(snap0(), snap0())).toBe('');
  });
  it('a newer failed run, then a job that starts waiting — failure first', () => {
    const failed = JOBS.map((j: any) =>
      j.id === 'job-deps'
        ? { ...j, runs: [run(1 * M, { status: 'failed', error: `npm audit timed out ${'x'.repeat(90)}` }), ...j.runs] }
        : j,
    );
    const p1 = cron.planCronLane(BOARD, failed, null);
    const msg = cron.cronAnnounceDiff(snap0(), cron.cronAnnounceSnap(p1));
    expect(msg.startsWith('크론 dependency-audit 실패: npm audit timed out x')).toBe(true);
    expect(msg.length).toBeLessThanOrEqual('크론 dependency-audit 실패: '.length + 80);
    expect(msg.endsWith('…')).toBe(true);
    const board2 = { ...BOARD, waiting: [...BOARD.waiting, card('k-qa2', 'job-qa', 'nightly-qa')] };
    const p2 = cron.planCronLane(board2, JOBS, null);
    expect(cron.cronAnnounceDiff(snap0(), cron.cronAnnounceSnap(p2))).toBe('크론 nightly-qa 응답 필요');
  });
  it('a job seen for the first time is not news', () => {
    const before = cron.cronAnnounceSnap(cron.planCronLane(BOARD, [], null));
    expect(cron.cronAnnounceDiff(before, snap0())).toBe('');
  });
});

describe('D20 — the drawer stays the pinned card', () => {
  it('a queue chip reaches the drawer through the existing delegated click', () => {
    expect(TEMPLATE).toMatch(
      /var g = t\.closest\('\[data-cron-group\]'\);\s*if \(g\) openCronDrawer\(g\.getAttribute\('data-cron-group'\)\);/,
    );
    expect(cron.cronQueue(plan(), NOW, null)).toContain('data-cron-group="id:job-deps"');
    expect(TEMPLATE).toMatch(/Escape[\s\S]{0,200}closeCronDrawer/);
  });
});

describe('R1 — names, errors and labels are text, never markup', () => {
  const evil = '<script>alert(1)</script>"q\'';
  it('the tiles, the queue and the chart escape a job name (text and attributes)', () => {
    const jobs = [
      job('job-x', evil, 5 * M, [run(10 * M, { status: 'failed', error: '<img src=x onerror=alert(1)>' })], {
        historyCap: 1,
      }),
    ];
    const p = cron.planCronLane({ working: [], waiting: [], idle: [], closed: [] }, jobs, null);
    const outs = [
      cron.cronStats(p, NOW),
      cron.cronQueue(p, NOW, null),
      cron.cronRunChart(p, NOW),
      cron.renderCronTileHead(p.groups[0], NOW),
    ];
    for (const out of outs) {
      expect(out).not.toMatch(/<script|<img|"q'/);
      expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
    expect(cron.cronRunChart(p, NOW)).toMatch(/class="aq-ch-cut"[^>]*title="이 구간은 &lt;script&gt;/);
  });
  it('an announced error is one plain, capped line', () => {
    const empty = { working: [], waiting: [], idle: [], closed: [] };
    const base = [job('job-y', 'nightly\nqa', 5 * M, [run(30 * M)])];
    const prev = cron.cronAnnounceSnap(cron.planCronLane(empty, base, null));
    const bad = [
      job('job-y', 'nightly\nqa', 5 * M, [
        run(M, { status: 'failed', error: `boom\n\tat x\u0007${'y'.repeat(200)}` }),
        run(30 * M),
      ]),
    ];
    const msg = cron.cronAnnounceDiff(prev, cron.cronAnnounceSnap(cron.planCronLane(empty, bad, null)));
    expect(msg.startsWith('크론 nightly qa 실패: boom at x y')).toBe(true);
    expect([...msg].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)).toBe(false);
    expect(msg.endsWith('…')).toBe(true);
    expect(cap.aqPlain('a\r\n\tb\u0000c', 0)).toBe('a b c');
  });
  it('an account name and a provider label are escaped on the mark, the card and the head', () => {
    const name = '<img src=x onerror=alert(1)>"';
    const g = {
      group: 'claude',
      label: 'Claude<b>',
      has5h: true,
      total: 1,
      now: 0,
      week: 0.5,
      state: 'empty',
      events: [],
      units: [
        { name, counted: true, blocked: true, blocks: { fiveHour: true }, returnAt: NOW_S + 600, now: 0, week: 0.5 },
      ],
    };
    const out = cap.capProvHead(g, NOW) + cap.capWorkers(g, NOW, false, `claude|0|${name}`, null);
    expect(out).not.toMatch(/<img|Claude<b>/);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).toContain('aria-label="&lt;img src=x onerror=alert(1)&gt;&quot; 세부"');
    expect(out).toContain('Claude&lt;b&gt;');
    const prev = { available: true, groups: [{ ...g, label: 'Claude\n<b>', state: 'ok' }] };
    expect(cap.capAnnounceDiff(prev, { available: true, groups: [{ ...g, label: 'Claude\n<b>' }] }, NOW)).toBe(
      'Claude <b> 계정이 모두 막힘 — 10분 후 복귀',
    );
    // the region is written as text, never as markup
    expect(clientFn('aqAnnounce')).toContain('el.textContent = msg;');
    expect(clientFn('aqAnnounce')).not.toContain('innerHTML');
  });
});
