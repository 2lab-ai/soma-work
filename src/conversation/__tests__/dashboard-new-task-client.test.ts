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
/** `load` with the page globals the functions read, given as values. */
function loadWith<T>(fns: string[], globals: Record<string, unknown>): T {
  const names = Object.keys(globals);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => globals[n])) as T;
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
  it('is one @2lab.ai/ui <ui-dialog> (D4 H-01) with the form kept whole inside; the page keeps no dialog of its own', () => {
    expect(html).toContain('<ui-dialog id="nt-dialog" class="nt-dialog" heading="새 작업" size="lg" lang="ko">');
    expect(html).toMatch(/<form[^>]*id="nt-form"/);
    // The form is the dialog's body: the element draws the heading and ✕, so the page's head row is gone.
    expect(html).not.toMatch(/<dialog[^>]*id="nt-dialog"/);
    expect(html).not.toContain('class="nt-head"');
    expect(html).not.toContain('nt-head-hint');
    // show() / hide() open and close it; Esc, the scrim and ✕ arrive as ui-close; no native showModal, no soft-close
    // timer, no is-shown class of the page's.
    const open = clientFn('openNewTask');
    expect(open).toContain('dlg.show();');
    expect(open).not.toContain('showModal');
    expect(clientFn('closeNewTask')).toContain('dlg.hide();');
    expect(script).toContain("dlg.addEventListener('ui-close', function () {");
    for (const gone of ['is-shown', "dlg.addEventListener('cancel'", 'ntSyncViewport', '--nt-vvh', '--nt-vvt']) {
      expect(script, gone).not.toContain(gone);
    }
    // N does nothing while a <ui-dialog> is up.
    expect(clientFn('ntIsTypingTarget')).toContain("document.querySelector('dialog[open], ui-dialog[open]')");
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

  it('#600 ⑥ — where the task goes: a Slack channel or a dashboard task, with a folder for the latter', () => {
    expect(html).toContain('id="nt-dest-slack"');
    expect(html).toContain('id="nt-dest-task"');
    expect(html).toMatch(/<select id="nt-folder"[^>]*onchange="ntOnFolderChange\(\)"/);
    expect(script).toContain('function ntSetDestination(');
    // Task mode hides the autogoal / autoz row, never the destination row (both are .nt-toggles).
    expect(script).toContain("'.nt-toggles:not(.nt-dest)'");
  });

  // #640 R1 (astra P2): the dialog's chips and rows set `display`, which beats the
  // `hidden` attribute's UA style — a hidden row must actually be hidden.
  it('#640 R1 — anything hidden inside the dialog is not displayed, whatever its class sets', () => {
    expect(html).toContain('.nt-dialog [hidden] { display: none !important; }');
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
    // (Its one ui-files listener only says why a dashboard task cannot start — #640 R2 — it takes nothing out.)
    expect(script.match(/composer\.addEventListener\('ui-files'/g) ?? []).toHaveLength(1);
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
    // The page's close and the element's ui-close both pass through ntOnClosed (the FAB back, the composer quiet).
    expect(clientFn('closeNewTask')).toContain('ntOnClosed();');
    expect(clientFn('ntOnClosed')).toContain("document.body.classList.remove('nt-open');");
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
  it('PC: a centered dialog of bounded width — the element\'s size="lg" (720px); the page keeps no box rule', () => {
    expect(html).toMatch(/<ui-dialog id="nt-dialog"[^>]* size="lg"/);
    expect(css).not.toMatch(/\.nt-dialog\s*\{/);
    expect(css).not.toMatch(/\.nt-dialog::backdrop/);
    // The form pads itself; the element's body padding is off so the two do not add up.
    expect(css).toContain('.nt-dialog::part(body) { padding: 0; }');
  });

  it("phones: the element's bottom sheet follows the visual viewport (keyboard); the page keeps the form clear of the safe area", () => {
    const phone = mediaBlock('@media (max-width: 639px) {\n  /* New task');
    // sheet="auto" and viewport="visual" are the element's defaults: nothing on the page pins the box or writes
    // --nt-vvh / --nt-vvt any more.
    expect(html).not.toMatch(/<ui-dialog id="nt-dialog"[^>]*(sheet="never"|viewport="layout")/);
    expect(phone).not.toContain('.nt-dialog');
    expect(phone).toMatch(/env\(safe-area-inset-bottom/);
    expect(script).not.toContain('ntSyncViewport');
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
    ntLaunchToast(data: any, channelName: string | null): any;
  }>(['ntDefaultState', 'ntBuildPayload', 'ntCanSubmit', 'ntLaunchToast']);
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
      destination: 'slack',
      folder: '',
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

  // #600 ⑥ — "대시보드 작업" (dashboard task): no channel, no Slack thread.
  describe('a dashboard task (#600 ⑥)', () => {
    const task = () => ({ ...fns.ntDefaultState(ctx, null), destination: 'task', prompt: '고쳐줘', channelId: null });

    it('builds the task body: destination, prompt, the chosen model’s nickname, the folder name — never attachments', () => {
      expect(
        fns.ntBuildPayload({ ...task(), folder: 'repo-a' }, [{ name: 'a.png', data: 'AA' }], 'req-0123456789'),
      ).toEqual({
        requestId: 'req-0123456789',
        destination: 'task',
        prompt: '고쳐줘',
        model: 'opus[1m]', // the server resolves the nickname against the models it offers (#640 R1)
        folder: 'repo-a',
      });
      // A new folder (the default) sends no folder.
      expect(fns.ntBuildPayload(task(), [], 'req-0123456789')).toEqual({
        requestId: 'req-0123456789',
        destination: 'task',
        prompt: '고쳐줘',
        model: 'opus[1m]',
      });
    });

    it('needs no channel, but needs an instruction (a task takes no attachments)', () => {
      expect(fns.ntCanSubmit(task(), [])).toBe(true);
      expect(fns.ntCanSubmit({ ...task(), prompt: ' ' }, [{ name: 'a' }])).toBe(false);
    });

    // #640 R1 (fable, astra P2): files attached before switching to a dashboard
    // task are not silently dropped — the task cannot start until they are removed.
    it('cannot start while files are attached — they would be dropped', () => {
      expect(fns.ntCanSubmit(task(), [{ name: 'a.png' }])).toBe(false);
    });

    it('the launch toast opens the task card — no channel, no Slack link; a task that did not start says why', () => {
      expect(fns.ntLaunchToast({ sessionKey: 'task:x', status: 'running' }, null)).toEqual({
        title: '대시보드 작업을 시작했어요',
        description: '카드에서 진행을 볼 수 있어요',
        tone: 'success',
        action: { id: 'open', label: '카드 열기' },
        duration: 12000,
      });
      expect(
        fns.ntLaunchToast(
          { sessionKey: 'task:x', status: 'not-started', reason: 'one dashboard task runs at a time' },
          null,
        ),
      ).toMatchObject({
        title: '작업을 만들었지만 아직 시작하지 못했어요',
        description: 'one dashboard task runs at a time — 지시는 새 작업 창에 남겨 두었어요',
        tone: 'warning',
        action: { id: 'open', label: '카드 열기' },
      });
    });

    it('a Slack launch toast is as before: the channel, and the thread link', () => {
      expect(
        fns.ntLaunchToast(
          { channel: 'C_ALPHA', status: 'running', permalink: 'https://slack.example/p1' },
          'workspace-alpha',
        ),
      ).toEqual({
        title: '작업을 시작했어요',
        description: '#workspace-alpha',
        tone: 'success',
        action: { id: 'open', label: '카드 열기' },
        duration: 12000,
        link: { label: 'Slack에서 보기', href: 'https://slack.example/p1' },
      });
    });
  });
});

// #640 R1 — what the dialog keeps across a refresh of its context, and after a launch.
// #640 R2 (fable P3): the submit button is disabled while a dashboard task has
// files attached, so the reason must show without a submit — on the switch, and
// clear once the files are gone.
describe('ntBlockedHint (#640 R2)', () => {
  const { ntBlockedHint } = load<{ ntBlockedHint(state: any, attachments: any[]): string }>(['ntBlockedHint']);
  it('says why a dashboard task with files cannot start; nothing otherwise', () => {
    expect(ntBlockedHint({ destination: 'task' }, [{ name: 'a.png' }])).toBe(
      '대시보드 작업은 아직 첨부를 받지 않아요 — 첨부를 빼거나 Slack 채널로 보내 주세요',
    );
    expect(ntBlockedHint({ destination: 'task' }, [])).toBe('');
    expect(ntBlockedHint({ destination: 'slack' }, [{ name: 'a.png' }])).toBe('');
  });
  it('is shown on switching to a dashboard task, and whenever the composer’s files change in task mode', () => {
    expect(clientFn('ntSetDestination')).toContain('ntSetError(ntBlockedHint(_ntState, ntComposerFiles()));');
    // <ui-composer> reports every file added (picker, paste, drop) or removed as ui-files (fable #640 R3).
    const init = clientFn('ntInit');
    expect(init).toContain("composer.addEventListener('ui-files', function (e) {");
    expect(init).toContain('ntSetError(ntBlockedHint(_ntState, (e.detail && e.detail.files) || ntComposerFiles()));');
  });
});

// #640 R2 (astra): what the user submitted is what is sent — a switch of the
// destination while attachments are still being read does not turn a Slack
// launch with files into a dashboard task without them.
describe('submitNewTask — the submitted state is the one sent (#640 R2)', () => {
  it('switching to a dashboard task while the files are read does not drop them', async () => {
    let release!: () => void;
    const reading = new Promise<void>((r) => {
      release = r;
    });
    const state = {
      destination: 'slack',
      channelId: 'C1',
      prompt: '',
      model: 'opus',
      effort: 'xhigh',
      autogoal: false,
      autoz: false,
      folder: '',
    };
    const posted: string[] = [];
    const launched: unknown[][] = [];
    const file = { name: 'a.png', type: 'image/png' };
    const { submitNewTask } = loadWith<{ submitNewTask(detail: unknown): Promise<void> }>(
      ['submitNewTask', 'ntCanSubmit', 'ntBlockedHint', 'ntBuildPayload'],
      {
        _ntBusy: false,
        _ntCtx: {},
        _ntState: state,
        _ntRequestId: 'req-0123456789',
        ntEl: () => ({ files: [file], value: '' }),
        ntSetError: () => {},
        ntSetStatus: () => {},
        paintNtComposer: () => {},
        // The composer's File read as base64 — held until the test releases it.
        ntReadFile: async (f: { name: string; type: string }) => {
          await reading;
          return { name: f.name, mimetype: f.type, data: 'AA' };
        },
        refreshCsrfToken: async () => {},
        ntPostTask: async (b: string) => {
          posted.push(b);
          return { status: 200, data: { ok: true, channel: 'C1', status: 'running' } };
        },
        ntOnLaunched: (...args: unknown[]) => launched.push(args),
      },
    );
    const run = submitNewTask({ text: '사진 봐줘', files: [file] });
    state.destination = 'task'; // the user switches while the files are read
    release();
    await run;
    const body = JSON.parse(posted[0]);
    expect(body).toMatchObject({ channelId: 'C1', prompt: '사진 봐줘', attachments: [{ name: 'a.png' }] });
    expect(body.destination).toBeUndefined();
    // What follows the launch reads the submitted state, too.
    expect(launched[0][1]).toMatchObject({ destination: 'slack', prompt: '사진 봐줘' });
  });
});

// #600 ⑥ / #640 R2 — the dialog's <ui-composer> on a dashboard task: no attach /
// voice / camera tools, and a pasted or dropped file is refused by its type.
describe('ntComposerData — a dashboard task takes no files (#640 R2)', () => {
  const data = (destination: string) =>
    loadWith<{ ntComposerData(): Record<string, unknown> }>(['ntComposerData', 'ntReadDraft'], {
      _ntValue: '',
      _ntBusy: false,
      _ntCtx: null,
      _ntState: { destination },
      NT_NO_FILES: 'application/x-soma-no-attachments',
      NT_DRAFT_KEY: 'k',
      localStorage: { getItem: () => null },
    }).ntComposerData();
  it('task: the tools are off and every file type is refused', () => {
    expect(data('task')).toMatchObject({
      attach: false,
      voice: false,
      camera: false,
      accept: 'application/x-soma-no-attachments',
    });
  });
  it('Slack: the element’s defaults (no file keys of the page’s own)', () => {
    const d = data('slack');
    expect(d).not.toHaveProperty('accept');
    expect(d).not.toHaveProperty('attach');
    expect(d).toMatchObject({ camera: 'environment', image: false });
  });
});

describe('ntReconcile / ntStateAfterLaunch (#640 R1)', () => {
  const fns = load<{
    ntDefaultState(ctx: any, draft: any): any;
    ntReconcile(state: any, ctx: any): void;
    ntStateAfterLaunch(prev: any, data: any, ctx: any): any;
  }>(['ntDefaultState', 'ntReconcile', 'ntStateAfterLaunch']);
  const ctx = (over: Record<string, unknown> = {}) => ({
    models: [{ nickname: 'opus[1m]', model: 'claude-opus-5-5[1m]' }],
    efforts: ['xhigh'],
    channels: [{ id: 'C_ALPHA', name: 'alpha' }],
    defaultModel: 'opus[1m]',
    defaultEffort: 'xhigh',
    defaultChannelId: 'C_ALPHA',
    autogoalDefault: true,
    taskFolders: [{ name: 'repo-a' }],
    ...over,
  });
  const taskState = (over: Record<string, unknown> = {}) => ({
    ...fns.ntDefaultState(ctx(), null),
    destination: 'task',
    folder: 'repo-a',
    prompt: '고쳐줘',
    ...over,
  });

  it('a folder no longer offered falls back to a new folder', () => {
    const s = taskState({ folder: 'gone' });
    fns.ntReconcile(s, ctx());
    expect(s.folder).toBe('');
    const kept = taskState();
    fns.ntReconcile(kept, ctx());
    expect(kept.folder).toBe('repo-a');
  });

  it('a dashboard task no longer offered (no task folders in the context) falls back to Slack', () => {
    const s = taskState();
    fns.ntReconcile(s, ctx({ taskFolders: undefined }));
    expect(s.destination).toBe('slack');
    expect(s.folder).toBe('');
  });

  it('still reconciles the model, effort and channel as before', () => {
    const s = { ...fns.ntDefaultState(ctx(), null), model: 'x', effort: 'y', channelId: 'C_GONE' };
    fns.ntReconcile(s, ctx());
    expect(s).toMatchObject({ model: 'opus[1m]', effort: 'xhigh', channelId: 'C_ALPHA' });
  });

  it('after a started task the next one starts clean, still a dashboard task', () => {
    const next = fns.ntStateAfterLaunch(taskState(), { sessionKey: 'task:x', status: 'running' }, ctx());
    expect(next).toMatchObject({ destination: 'task', prompt: '', folder: '' });
  });

  // #640 R1 (astra P2): a task created but not started keeps its instruction — it was never run.
  it('after a task that did not start, the instruction, folder and model are kept', () => {
    const prev = taskState({ model: 'fable' }); // not the default, so keeping it is observable
    const next = fns.ntStateAfterLaunch(prev, { sessionKey: 'task:x', status: 'not-started', reason: 'busy' }, ctx());
    expect(next).toMatchObject({ destination: 'task', prompt: '고쳐줘', folder: 'repo-a', model: 'fable' });
  });

  it('a Slack launch keeps the channel it used', () => {
    const prev = { ...fns.ntDefaultState(ctx(), null), prompt: 'go', channelId: 'C_ALPHA' };
    const next = fns.ntStateAfterLaunch(prev, { channel: 'C_BETA', status: 'running' }, ctx());
    expect(next).toMatchObject({ destination: 'slack', channelId: 'C_BETA', prompt: '' });
  });
});

// T11 voice recording (the recorder's MIME pick — MP4/AAC first for iOS Safari, then Ogg, WebM last — the note's
// name after its container, the chip sizes) is <ui-composer>'s: library composer.test.ts 'composerRecorderMime: MP4
// first, then Ogg, then WebM; a throwing check means no' and 'Done files a voice-….m4a note'.
