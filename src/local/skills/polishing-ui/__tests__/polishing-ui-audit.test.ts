import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs scripts/audit.mjs for real (Playwright's Chromium, which CI installs for the html skill) against a fixture
// page, and reads its report.json: the thresholds reach the in-page checks, and each check classifies as SKILL.md says.
const AUDIT = resolve(__dirname, '..', 'scripts', 'audit.mjs');

type Finding = { level: 'red' | 'amber'; el: string; text?: string; issue?: string };
type Preset = {
  target: Finding[];
  inputZoom: Finding[];
  contrast: Finding[];
  name: Finding[];
};

const FRAME = `<!doctype html><script>parent.postMessage(localStorage.getItem('pu-secret'), '*');</script>`;

function page(frameOrigin: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body { margin: 0; padding: 40px; font: 16px system-ui; background: #fff; color: #111; }
  .row { margin: 0 0 60px; }
  button { padding: 0; border: 0; background: #222; color: #fff; }
  #pair-a, #pair-b { width: 8px; height: 8px; }
  #pair-b { margin-left: 12px; }
  #alone, #grown { width: 20px; height: 20px; }
  #grown { position: relative; }
  #grown::after { content: ''; position: absolute; inset: -12px; }
  #thirty { width: 30px; height: 30px; }
  #field { font-size: 14px; width: 200px; height: 48px; }
  #go { font-size: 16px; width: 120px; height: 48px; }
  #x { width: 48px; height: 48px; }
  .faded { opacity: 0.3; }
  .flag { color: #eee; }
  iframe { width: 10px; height: 10px; border: 0; }
  </style></head><body>
  <div class="row"><button id="pair-a" aria-label="a"></button><button id="pair-b" aria-label="b"></button></div>
  <div class="row"><button id="alone" aria-label="alone"></button></div>
  <div class="row"><button id="grown" aria-label="grown"></button></div>
  <div class="row"><button id="thirty" aria-label="thirty"></button></div>
  <div class="row"><input id="field" aria-label="field"></div>
  <div class="row"><form><input id="go" type="submit"></form></div>
  <div class="row"><button id="x"><span aria-hidden="true">×</span></button></div>
  <div class="row faded"><span>Faded words here</span></div>
  <div class="row" id="flags"></div>
  <iframe src="${frameOrigin}/frame"></iframe>
  <script>
    const flag = (word) => { const p = document.createElement('p'); p.className = 'flag'; p.textContent = word; document.getElementById('flags').append(p); };
    if (localStorage.getItem('pu-secret') === 'tok') flag('SEEDED');
    addEventListener('message', (e) => { if (e.data === 'tok') flag('LEAKED'); });
  </script>
  </body></html>`;
}

function serve(handler: (path: string) => { status: number; body: string }): Promise<Server> {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? '/');
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

const origin = (s: Server): string => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

function audit(
  url: string,
  out: string,
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [AUDIT, url, '--out', out, ...extra], { timeout: 120_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

const has = (list: Finding[], id: string, level?: Finding['level']): boolean =>
  list.some((f) => f.el.endsWith(`#${id}`) && (!level || f.level === level));

describe('polishing-ui audit.mjs — real browser', () => {
  let main: Server;
  let frame: Server;
  let out: string;
  let report: { presets: { desktop: Preset; mobile: Preset } };

  beforeAll(async () => {
    frame = await serve(() => ({ status: 200, body: FRAME }));
    main = await serve((path) =>
      path === '/broken' ? { status: 500, body: 'nope' } : { status: 200, body: page(origin(frame)) },
    );
    out = mkdtempSync(join(tmpdir(), 'polish-audit-'));
    const run = await audit(`${origin(main)}/`, out, ['--storage', 'pu-secret=tok']);
    expect(run.code, run.stderr).toBe(0);
    report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  }, 180_000);

  afterAll(() => {
    main?.close();
    frame?.close();
    if (out) rmSync(out, { recursive: true, force: true });
  });

  it('hit targets: touching small targets are red, a spaced one amber, a pseudo-element hit area passes', () => {
    for (const preset of ['desktop', 'mobile'] as const) {
      const t = report.presets[preset].target;
      expect(has(t, 'pair-a', 'red'), preset).toBe(true);
      expect(has(t, 'pair-b', 'red'), preset).toBe(true);
      expect(has(t, 'alone', 'amber'), preset).toBe(true);
      expect(has(t, 'grown'), preset).toBe(false);
    }
  });

  it('the preset numbers reach the page: 30px passes on desktop (28), not on the phone (44)', () => {
    expect(has(report.presets.desktop.target, 'thirty')).toBe(false);
    expect(has(report.presets.mobile.target, 'thirty', 'amber')).toBe(true);
  });

  it('a 14px field makes iOS zoom: flagged on the phone only', () => {
    expect(has(report.presets.desktop.inputZoom, 'field')).toBe(false);
    expect(has(report.presets.mobile.inputZoom, 'field', 'red')).toBe(true);
  });

  it('names: a submit input is named by default; an aria-hidden glyph is no name', () => {
    for (const preset of ['desktop', 'mobile'] as const) {
      const n = report.presets[preset].name;
      expect(has(n, 'go'), preset).toBe(false);
      expect(has(n, 'x', 'red'), preset).toBe(true);
    }
  });

  it('contrast counts a faded wrapper', () => {
    const c = report.presets.desktop.contrast;
    expect(c.some((f) => f.text === 'Faded words here' && f.level === 'red')).toBe(true);
  });

  it('--storage seeds the audited origin and never an embedded one', () => {
    const texts = report.presets.desktop.contrast.map((f) => f.text);
    expect(texts).toContain('SEEDED');
    expect(texts).not.toContain('LEAKED');
  });

  it('a page that does not load fails the run', async () => {
    const run = await audit(`${origin(main)}/broken`, out, ['--preset', 'desktop']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/did not load \(HTTP 500\)/);
  }, 120_000);
});
