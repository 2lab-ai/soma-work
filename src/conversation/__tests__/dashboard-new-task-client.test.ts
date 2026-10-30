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
  it('PC: a primary button sits in the app bar (its actions slot, before the status) with an N shortcut', () => {
    const bar = html.slice(html.indexOf('<ui-app-bar id="app-bar"'), html.indexOf('</ui-app-bar>'));
    expect(bar).toMatch(/<button[^>]*id="new-task-btn" slot="actions"[^>]*aria-keyshortcuts="n"/);
    expect(bar).toMatch(/id="new-task-btn"[^>]*onclick="openNewTask\(\)"/);
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
    // D2: 작업 시작 is <ui-composer>'s send button (its ink primary, data.submitLabel).
    expect(script).toContain("submitLabel: '작업 시작',");
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

  it('D2 (H-05..H-09) — the instruction, files, voice and 작업 시작 are one @2lab.ai/ui <ui-composer>', () => {
    expect(html).toContain('<script type="module" src="/dashboard/ui/composer.js?v=');
    expect(html).toContain('<ui-composer id="nt-composer" class="nt-composer" lang="ko"></ui-composer>');
    // After the toggles; the page's error line and the upload status follow it.
    const at = html.indexOf('id="nt-composer"');
    expect(html.indexOf('class="nt-toggles"')).toBeLessThan(at);
    expect(at).toBeLessThan(html.indexOf('id="nt-error"'));
    expect(at).toBeLessThan(html.indexOf('id="nt-status"'));
    // The inline field, chips, recorder and toolbar are gone.
    for (const gone of [
      'id="nt-prompt"',
      'id="nt-attachments"',
      'id="nt-recorder"',
      'class="nt-toolbar"',
      'id="nt-submit"',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
    for (const gone of [
      'function ntAddBlob(',
      'function ntRenderFiles(',
      'function ntToggleRecording(',
      'function ntAutosize(',
      // D4 E-30: the panel composer is a <ui-composer> too — the helpers the two shared went with it.
      'function ntPickRecorderMime(',
      'function ntExtForMime(',
      'function ntFormatBytes(',
      'function ntFormatDuration(',
      'function ntStamp(',
      'function ntKindOf(',
    ]) {
      expect(script, gone).not.toContain(gone);
    }
  });

  it('the composer gets its data from the page: label, placeholder, the draft, 작업 시작, the context limits', () => {
    const data = clientFn('ntComposerData');
    expect(data).toContain("label: '작업 지시',");
    expect(data).toContain('value: _ntValue,');
    expect(data).toContain('busy: _ntBusy,');
    expect(data).toContain('d.maxLength = lim.maxPromptChars;');
    expect(data).toContain('d.maxFiles = lim.maxFiles;');
    expect(data).toContain('d.maxFileSize = lim.maxFileBytes;');
    // The server's cap on all files together is the element's (0.10.0 maxTotalBytes: it rejects the file that
    // crosses it and says so) — the page no longer takes the file back out on ui-files (D2-GAPS G5-3).
    expect(data).toContain('d.maxTotalBytes = lim.maxTotalBytes;');
    expect(script).not.toContain("composer.addEventListener('ui-files'");
    expect(script).not.toContain('composer.removeFile(');
    // It answers ui-submit (cancelled: the page posts, the composer keeps its text and files until the launch)
    // and ui-input (the draft).
    expect(script).toContain(
      "composer.addEventListener('ui-submit', function (e) {\n    e.preventDefault();\n    submitNewTask(e.detail);",
    );
    expect(script).toContain('ntSaveDraft(v);');
    expect(clientFn('ntOnLaunched')).toContain(
      "if (composer && typeof composer.clear === 'function') composer.clear();",
    );
  });

  it("T10 — 카메라 is the composer's own tool on touch screens; it opens the back camera directly", () => {
    // 0.10.0 camera: 'environment' (shown on touch only) — the page's capture input and ui-tool answer are gone.
    expect(clientFn('ntComposerData')).toContain("camera: 'environment',");
    expect(clientFn('ntComposerData')).not.toContain('tools:');
    expect(html).not.toContain('nt-camera-input');
    expect(script).not.toContain('function ntAddCamera(');
    expect(script).not.toContain("composer.addEventListener('ui-tool'");
  });

  it("T9 / T11 / PC — files, voice, drop and paste are the composer's: any file type, MediaRecorder, screenshots named", () => {
    // No accept list (any file); the image picker is off (the attach tool takes images too).
    expect(clientFn('ntComposerData')).not.toContain('accept:');
    expect(clientFn('ntComposerData')).toContain('image: false,');
    // The dialog keeps no drop / paste handler of its own: the composer takes them (and names screenshots).
    expect(script).not.toContain('dlg.ondrop');
    expect(script).not.toContain("prompt.addEventListener('paste'");
  });

  it("⌘/Ctrl+Enter starts the task; a plain Enter is a new line — the element's enter: 'newline', with its hint", () => {
    expect(clientFn('ntComposerData')).toContain("enter: 'newline',");
    expect(clientFn('ntComposerData')).toContain('hint: true,');
    // The capture keydown that kept a plain Enter from the element (D2-GAPS G5-2) is gone.
    expect(script).not.toMatch(/composer\.addEventListener\(\s*'keydown'/);
    expect(script).not.toContain(
      "if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) e.stopPropagation();",
    );
  });

  it("closing the sheet discards a recording in progress and stops a preview — the element's cancelRecording / pause", () => {
    expect(clientFn('closeNewTask')).toContain('ntQuietComposer();');
    expect(clientFn('ntOnClosed')).toContain('ntQuietComposer();');
    const quiet = clientFn('ntQuietComposer');
    expect(quiet).toContain('el.cancelRecording();');
    expect(quiet).toContain('el.pause();');
    expect(quiet).not.toContain('disabled: true');
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
    // The composer's tools, send, chips and field are 44px / 16px on touch by its own rules; the page's selects too.
    expect(coarse).toMatch(/\.nt-chip select[^{]*\{[^}]*font-size:\s*16px/);
    expect(coarse).not.toContain('.nt-prompt');
  });

  it('the camera tool is offered on touch devices only (PC gets drop / paste instead)', () => {
    // The element shows camera only on touch screens (coarse pointer); the page no longer decides.
    expect(css).not.toContain('.nt-tool-camera');
    expect(clientFn('ntComposerData')).toContain("camera: 'environment',");
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

// T11 voice recording (the recorder's MIME pick — MP4/AAC first for iOS Safari, then Ogg, WebM last — the note's
// name after its container, the chip sizes) is <ui-composer>'s: library composer.test.ts 'composerRecorderMime: MP4
// first, then Ogg, then WebM; a throwing check means no' and 'Done files a voice-….m4a note'.
