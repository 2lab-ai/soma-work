/**
 * Dashboard "New task" — the client (SSOT 2026-10-23 T1, T3–T12).
 *
 * Two halves, same harnesses as the other dashboard client suites:
 *   - structure: the page served at GET /dashboard carries every control the
 *     composer needs, laid out differently for PC (top-bar button + centered
 *     dialog) and phones (floating button + full-screen sheet, camera capture,
 *     44px targets, 16px text so iOS does not zoom), with motion that stops
 *     under prefers-reduced-motion;
 *   - behaviour: the shipped client functions, cut out of
 *     renderDashboardPage()'s template literal and cooked exactly as the
 *     browser receives them, run against plain inputs.
 *
 * Layout in a real browser (Chromium + WebKit, 360–1280px) is receipted by
 * scripts/screenshot-new-task.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function load<T>(fns: string[]): T {
  return new Function(`${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`)() as T;
}

// ── Served page ──────────────────────────────────────────────────────

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};
vi.mock('../../config', () => ({ config: mockConfig }));
vi.mock('../../env-paths', () => ({ IS_DEV: true, DATA_DIR: '/tmp/test-data' }));
vi.mock('../recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

let html = '';
let css = '';
let kit = '';
let script = '';

beforeAll(async () => {
  const webServer = await import('../web-server');
  await webServer.startWebServer({ listen: false });
  const res = await webServer.injectWebServer({
    method: 'GET',
    url: '/dashboard',
    headers: { Authorization: 'Bearer test-token' },
  });
  expect(res.statusCode).toBe(200);
  html = res.body;
  css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  kit = html.match(/<style id="ui-kit">([\s\S]*?)<\/style>/)![1];
  script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  (globalThis as any).__stopNewTaskServer = webServer.stopWebServer;
}, 180_000);

afterAll(async () => {
  await (globalThis as any).__stopNewTaskServer?.();
});

/** The body of every CSS rule block whose prelude contains `prelude`. */
function mediaBlock(prelude: string): string {
  const at = css.indexOf(prelude);
  if (at < 0) throw new Error(`no CSS block for ${prelude}`);
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error('unbalanced CSS');
}

describe('T1 — the New task entry is always in reach, calm', () => {
  it('PC: a primary button sits in the top bar, before the nav, with an N shortcut', () => {
    const topbar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<div class="nav">'));
    expect(topbar).toContain('id="new-task-btn"');
    expect(topbar).toMatch(/<button[^>]*id="new-task-btn"[^>]*aria-keyshortcuts="n"/);
    expect(topbar).toMatch(/id="new-task-btn"[^>]*onclick="openNewTask\(\)"/);
  });

  it('phones: a floating action button, clear of the home indicator', () => {
    expect(html).toMatch(/<button[^>]*id="new-task-fab"[^>]*aria-label="[^"]+"/);
    expect(css).toMatch(/\.new-task-fab\s*\{[^}]*position:\s*fixed/);
    expect(css).toMatch(/\.new-task-fab\s*\{[^}]*env\(safe-area-inset-bottom/);
  });

  it('below 640px the top-bar button gives way to the floating button', () => {
    const phone = mediaBlock('@media (max-width: 639px) {\n  /* New task');
    expect(phone).toMatch(/\.new-task-btn\s*\{[^}]*display:\s*none/);
    expect(phone).toMatch(/\.new-task-fab\s*\{[^}]*display:\s*inline-flex/);
  });

  // Tone pass P3 (ui.2lab.ai: one calm ink primary, no decorative motion): the entry no longer
  // animates on its own — no sheen, pulse, glow, ring or hover lift; the FAB arrives once.
  it('both entries are the calm ink primary; the FAB arrives once (0.95 → 1, 240ms); reduced motion stills it', () => {
    for (const gone of [
      /@keyframes nt-sheen/,
      /@keyframes nt-pulse/,
      /@keyframes nt-ring/,
      /conic-gradient/,
      /\.new-task-btn::(before|after)/,
      /\.new-task-fab::after/,
    ])
      expect(css, String(gone)).not.toMatch(gone);
    expect(css).not.toMatch(/\.new-task-btn\s*\{[^}]*animation:/);
    expect(css).not.toMatch(/\.new-task-btn:hover\s*\{[^}]*transform/);
    // D1: the top-bar entry is the kit's ink primary (.ui-btn.is-primary, ui-kit.css) with a kit key for N.
    expect(html).toMatch(/<button type="button" class="ui-btn is-primary new-task-btn" id="new-task-btn"/);
    expect(kit).toMatch(
      /\.ui-btn\.is-primary \{ background: var\(--ui-ib-text\); border-color: var\(--ui-ib-text\); color: var\(--ui-ib-card\); \}/,
    );
    expect(css).toMatch(
      /\.new-task-fab\s*\{[^}]*background: var\(--ib-text\);[^}]*animation: nt-fab-in 240ms var\(--ease-out\) both;/,
    );
    expect(css).toContain(
      '@keyframes nt-fab-in { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: none; } }',
    );
    expect(html).toMatch(/<button type="submit" class="ui-btn is-primary is-lg nt-submit" id="nt-submit">/);
    expect(html).toMatch(
      /id="new-task-btn"[^>]*>[\s\S]*?<kbd class="ui-kbd nt-kbd" aria-hidden="true">N<\/kbd><\/button>/,
    );
    const reduced = mediaBlock('@media (prefers-reduced-motion: reduce) {\n  /* New task');
    expect(reduced).toMatch(/\.new-task-btn/);
    expect(reduced).toMatch(/\.new-task-fab/);
    expect(reduced).toMatch(/animation:\s*none/);
  });

  it('pressing N (outside a text field) or the buttons opens the composer', () => {
    expect(script).toContain('function openNewTask(');
    expect(script).toMatch(/key === 'n'|key==='n'/);
  });
});

describe('T3–T11 — the composer, in the order of the sketch', () => {
  it('is one native dialog with a form', () => {
    expect(html).toMatch(/<dialog[^>]*id="nt-dialog"[^>]*class="nt-dialog"/);
    expect(html).toMatch(/<form[^>]*id="nt-form"/);
  });

  it('row 1: model (with the battery), effort and channel selectors', () => {
    const row = html.slice(html.indexOf('class="nt-config"'), html.indexOf('class="nt-toggles"'));
    const order = ['id="nt-model"', 'id="nt-battery"', 'id="nt-effort"', 'id="nt-channel"'].map((id) =>
      row.indexOf(id),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/id="nt-battery"[^>]*role="img"/);
  });

  it('row 2: autogoal and autoz toggles; autoz starts off; autogoal says it is for this task only', () => {
    expect(html).toMatch(/<button[^>]*id="nt-autogoal"[^>]*aria-pressed=/);
    expect(html).toMatch(/<button[^>]*id="nt-autoz"[^>]*aria-pressed="false"/);
    // Per task, the opening instruction; the user's setting itself is untouched.
    expect(html).toMatch(/id="nt-autogoal"[^>]*title="[^"]*이 작업의 첫 지시에만[^"]*설정 자체는 바뀌지 않습니다/);
  });

  it('the instruction textarea, then the attachment list', () => {
    expect(html).toMatch(/<textarea[^>]*id="nt-prompt"/);
    expect(html.indexOf('id="nt-prompt"')).toBeLessThan(html.indexOf('id="nt-attachments"'));
    expect(html).toMatch(/id="nt-attachments"[^>]*aria-live="polite"/);
  });

  it('toolbar: camera, file and voice on the left, 작업 시작 on the right', () => {
    const bar = html.slice(html.indexOf('class="nt-toolbar"'));
    const idx = ['id="nt-camera"', 'id="nt-attach"', 'id="nt-mic"', 'id="nt-submit"'].map((id) => bar.indexOf(id));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(bar).toMatch(/id="nt-submit"[^>]*>[^<]*작업 시작/);
  });

  it('T10 — the camera input opens the phone camera directly', () => {
    expect(html).toMatch(/<input[^>]*id="nt-camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  });

  it('T9 — the file input is a plain multi-file picker', () => {
    const input = html.match(/<input[^>]*id="nt-file-input"[^>]*>/)![0];
    expect(input).toContain('multiple');
    expect(input).not.toContain('capture');
    expect(input).not.toContain('accept=');
  });

  it('T11 — voice: MediaRecorder first, the native recorder input as a fallback', () => {
    expect(html).toMatch(/<input[^>]*id="nt-audio-input"[^>]*accept="audio\/\*"[^>]*capture/);
    expect(script).toContain('MediaRecorder');
    expect(script).toContain('getUserMedia');
  });

  it('PC: drag-and-drop and pasted screenshots attach too', () => {
    expect(script).toMatch(/addEventListener\('paste'/);
    // A property handler, not addEventListener('drop'): the board's own
    // contract (cards are not draggable, §3.1-5) forbids that literal.
    expect(script).toMatch(/dlg\.ondrop = function/);
  });

  it('⌘/Ctrl+Enter starts the task', () => {
    expect(script).toMatch(/metaKey \|\| e\.ctrlKey|ctrlKey \|\| e\.metaKey/);
  });

  it('loads its context and posts the task with the CSRF token', () => {
    expect(script).toContain("'/api/dashboard/new-task/context'");
    expect(script).toContain("'/api/dashboard/new-task'");
    expect(script).toMatch(/setRequestHeader\('X-CSRF-Token'/);
  });
});

describe('T12 — PC and phone layouts are designed separately', () => {
  it('PC: a centered dialog of bounded width', () => {
    expect(css).toMatch(/\.nt-dialog\s*\{[^}]*width:\s*min\(720px/);
  });

  it('phones: a full-screen sheet that follows the visual viewport (keyboard) and the safe areas', () => {
    const phone = mediaBlock('@media (max-width: 639px) {\n  /* New task');
    expect(phone).toMatch(/\.nt-dialog\s*\{[^}]*height:\s*var\(--nt-vvh,\s*100dvh\)/);
    expect(phone).toMatch(/env\(safe-area-inset-bottom/);
    expect(script).toContain('visualViewport');
  });

  it('touch: 44px targets and 16px text in the instruction field (no iOS zoom)', () => {
    const coarse = mediaBlock('@media (pointer: coarse) {\n  /* New task');
    // The tools are the kit's icon buttons: 44px on touch is ui-kit.css's own rule.
    expect(html).toMatch(/<button type="button" class="ui-icon-btn nt-tool" id="nt-attach"/);
    expect(kit).toMatch(
      /@media \(pointer: coarse\), \(max-width: 639px\) \{[^@]*\.ui-icon-btn, \.ui-icon-btn\.is-sm, \.ui-icon-btn\.is-bordered \{ width: 44px; height: 44px; \}/,
    );
    expect(coarse).toMatch(/\.nt-prompt[^{]*\{[^}]*font-size:\s*16px/);
  });

  it('the camera button is shown on touch devices only (PC gets drop / paste instead)', () => {
    expect(css).toMatch(/\.nt-tool-camera\s*\{[^}]*display:\s*none/);
    const coarse = mediaBlock('@media (pointer: coarse) {\n  /* New task');
    expect(coarse).toMatch(/\.nt-tool-camera\s*\{[^}]*display:\s*inline-grid/);
  });

  it('the whole page script still compiles', () => {
    expect(() => new Function(script)).not.toThrow();
  });
});

// ── Client behaviour ─────────────────────────────────────────────────

interface Battery {
  level: number | null;
  best: number | null;
  windows: Array<{ label: string; remaining: number | null; resetsAt?: number }>;
  accounts: { measured: number; total: number; available: number };
}

describe('ntBatteryView — T3 the battery', () => {
  const { ntBatteryView } = load<{ ntBatteryView(b: Battery | null): any }>(['ntBatteryView']);
  const battery = (level: number | null): Battery => ({
    level,
    best: level,
    windows: [
      { label: '5h', remaining: 0.9 },
      { label: '7d-opus', remaining: level },
    ],
    accounts: { measured: 2, total: 2, available: 2 },
  });

  it('fills to the level and picks a colour band', () => {
    expect(ntBatteryView(battery(0.72))).toMatchObject({ cls: 'nt-batt-high', pct: '72%', fill: 72 });
    expect(ntBatteryView(battery(0.35))).toMatchObject({ cls: 'nt-batt-mid', pct: '35%' });
    expect(ntBatteryView(battery(0.1))).toMatchObject({ cls: 'nt-batt-low', pct: '10%' });
  });

  it('unknown is shown as unknown, never as full', () => {
    expect(ntBatteryView(battery(null))).toMatchObject({ cls: 'nt-batt-unknown', pct: '?', fill: 0 });
    expect(ntBatteryView(null)).toMatchObject({ cls: 'nt-batt-unknown', pct: '?', fill: 0 });
  });

  it('its label says it is a shared-pool estimate and breaks the windows down', () => {
    const { label } = ntBatteryView(battery(0.72));
    expect(label).toContain('공유 풀 추정');
    expect(label).toContain('5h 90%');
    expect(label).toContain('7d-opus 72%');
    expect(label).toContain('가용 2/2');
  });
});

describe('ntDefaultState / ntBuildPayload / ntCanSubmit — T4–T9', () => {
  const fns = load<{
    ntDefaultState(ctx: any, draft: any): any;
    ntBuildPayload(state: any, attachments: any[], requestId: string): any;
    ntCanSubmit(state: any, attachments: any[]): boolean;
  }>(['ntDefaultState', 'ntBuildPayload', 'ntCanSubmit']);
  const ctx = {
    defaultModel: 'opus[1m]',
    defaultEffort: 'xhigh',
    defaultChannelId: 'C_ALPHA',
    autogoalDefault: true,
  };

  it('starts from the user’s defaults; autoz is always off at start (no default setting)', () => {
    expect(fns.ntDefaultState(ctx, null)).toEqual({
      model: 'opus[1m]',
      effort: 'xhigh',
      channelId: 'C_ALPHA',
      autogoal: true,
      autoz: false,
      prompt: '',
    });
  });

  it('a saved draft restores only the text', () => {
    const s = fns.ntDefaultState(ctx, { prompt: '쓰던 글', autoz: true, model: 'x' });
    expect(s.prompt).toBe('쓰던 글');
    expect(s.autoz).toBe(false);
    expect(s.model).toBe('opus[1m]');
  });

  it('builds the request body the server validates', () => {
    const state = { ...fns.ntDefaultState(ctx, null), prompt: '개선해줘', autoz: true };
    const body = fns.ntBuildPayload(
      state,
      [{ name: 'photo.jpg', mimetype: 'image/jpeg', data: 'AAAA', size: 3, kind: 'image' }],
      'req-0123456789',
    );
    expect(body).toEqual({
      requestId: 'req-0123456789',
      prompt: '개선해줘',
      model: 'opus[1m]',
      effort: 'xhigh',
      channelId: 'C_ALPHA',
      autogoal: true,
      autoz: true,
      attachments: [{ name: 'photo.jpg', mimetype: 'image/jpeg', data: 'AAAA' }],
    });
  });

  it('can start with text or with an attachment, and only with a channel', () => {
    const base = fns.ntDefaultState(ctx, null);
    expect(fns.ntCanSubmit(base, [])).toBe(false);
    expect(fns.ntCanSubmit({ ...base, prompt: '  ' }, [])).toBe(false);
    expect(fns.ntCanSubmit({ ...base, prompt: 'go' }, [])).toBe(true);
    expect(fns.ntCanSubmit(base, [{ name: 'a' }])).toBe(true);
    expect(fns.ntCanSubmit({ ...base, prompt: 'go', channelId: null }, [])).toBe(false);
  });
});

describe('voice recording helpers — T11', () => {
  const { ntPickRecorderMime, ntExtForMime } = load<{
    ntPickRecorderMime(isSupported: (t: string) => boolean): string;
    ntExtForMime(m: string): string;
  }>(['ntPickRecorderMime', 'ntExtForMime']);

  it('iOS Safari records AAC in MP4; Chrome / Android record Opus in WebM', () => {
    expect(ntPickRecorderMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(ntPickRecorderMime((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(ntPickRecorderMime(() => false)).toBe('');
  });

  it('names the file after its container', () => {
    expect(ntExtForMime('audio/mp4')).toBe('m4a');
    expect(ntExtForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(ntExtForMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(ntExtForMime('application/x-unknown')).toBe('bin');
  });
});

describe('ntFormatBytes', () => {
  const { ntFormatBytes } = load<{ ntFormatBytes(n: number): string }>(['ntFormatBytes']);
  it('formats sizes for the attachment chips', () => {
    expect(ntFormatBytes(512)).toBe('512 B');
    expect(ntFormatBytes(2048)).toBe('2 KB');
    expect(ntFormatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
