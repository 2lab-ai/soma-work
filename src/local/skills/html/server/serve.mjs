#!/usr/bin/env node
/**
 * Local static web server for the local:html skill.
 *
 * Publishes a rendered single-file HTML artifact on a long-lived local web
 * server so the user gets a clickable link (LAN + localhost) in addition to
 * the Slack file upload. Lottie/JS-animated pages need a live browser tab —
 * a PNG preview can't show motion. This server is how the motion actually
 * reaches the user.
 *
 * Contract (CLI, publish mode — the one agents call):
 *   node serve.mjs --file <abs-path-to-html> [--port 8763]
 *
 *   1. Copies <file> into the serve root (default /tmp/soma-html-serve).
 *   2. Ensures a detached daemon is listening (spawns one if needed —
 *      survives the agent turn; idempotent across sessions).
 *   3. Prints JSON: { "url", "localUrl", "port", "file" } on stdout.
 *
 * Daemon mode (internal): node serve.mjs --daemon --port <port>
 *   Plain node:http static server bound to 0.0.0.0, serving the serve root.
 *   GET /__soma-serve-health → "soma-html-serve" (ownership probe).
 *   GET /                    → directory index of published artifacts.
 *
 * Exit codes: 0 published, 1 CLI/input error, 2 could not start/find server.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVE_ROOT = process.env.SOMA_HTML_SERVE_ROOT || '/tmp/soma-html-serve';
const BASE_PORT = Number(process.env.SOMA_HTML_SERVE_PORT || 8763);
const PORT_SCAN_RANGE = 20;
const HEALTH_PATH = '/__soma-serve-health';
const HEALTH_BODY = 'soma-html-serve';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.lottie': 'application/zip',
};

function parseArgs(argv) {
  const out = { port: undefined, daemon: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') out.file = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg === '--daemon') out.daemon = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node serve.mjs --file <html> [--port N] | --daemon --port N');
      process.exit(0);
    } else {
      console.error(`unknown arg: ${arg}`);
      process.exit(1);
    }
  }
  return out;
}

function lanIp() {
  const nets = networkInterfaces();
  // Prefer common primary interfaces, then fall back to any external IPv4.
  const preferred = ['en0', 'eth0', 'en1', 'wlan0'];
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push({ name, address: addr.address });
      }
    }
  }
  for (const p of preferred) {
    const hit = candidates.find((c) => c.name === p);
    if (hit) return hit.address;
  }
  return candidates[0]?.address ?? '127.0.0.1';
}

function probeHealth(port, timeoutMs = 700) {
  return new Promise((resolveProbe) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: HEALTH_PATH, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolveProbe(body.trim() === HEALTH_BODY ? 'ours' : 'foreign'));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolveProbe('foreign');
    });
    req.on('error', (err) => {
      resolveProbe(err.code === 'ECONNREFUSED' ? 'free' : 'foreign');
    });
  });
}

function startDaemon(port) {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--daemon', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function waitForOurs(port, attempts = 15, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    if ((await probeHealth(port)) === 'ours') return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function ensureServer() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_SCAN_RANGE; port++) {
    const state = await probeHealth(port);
    if (state === 'ours') return port;
    if (state === 'free') {
      startDaemon(port);
      if (await waitForOurs(port)) return port;
      // Lost the race or daemon died — try the next port instead of looping here.
    }
    // 'foreign': some other process owns this port; never serve through it.
  }
  return null;
}

function htmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function directoryIndex() {
  let entries = [];
  try {
    entries = readdirSync(SERVE_ROOT)
      .filter((f) => !f.startsWith('.'))
      .map((f) => ({ name: f, mtime: statSync(join(SERVE_ROOT, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    entries = [];
  }
  const rows = entries
    .map(
      (e) =>
        `<li><a href="/${encodeURIComponent(e.name)}">${htmlEscape(e.name)}</a>` +
        ` <small>${new Date(e.mtime).toISOString()}</small></li>`,
    )
    .join('\n');
  return [
    '<!doctype html><meta charset="utf-8"><title>soma html artifacts</title>',
    '<body style="font-family:system-ui;max-width:720px;margin:48px auto;color:#0f172a;background:#fafaf9">',
    '<h1 style="font-size:24px">Published HTML artifacts</h1>',
    `<ul style="line-height:2">${rows || '<li>(none yet)</li>'}</ul>`,
    '</body>',
  ].join('\n');
}

function runDaemon(port) {
  mkdirSync(SERVE_ROOT, { recursive: true });
  const rootReal = realpathSync(SERVE_ROOT);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(HEALTH_BODY);
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(directoryIndex());
        return;
      }
      const target = resolve(rootReal, '.' + pathname);
      // Path-traversal guard: resolved target must stay inside the serve root.
      if (target !== rootReal && !target.startsWith(rootReal + '/')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(readFileSync(target));
    } catch (err) {
      res.writeHead(500).end(`error: ${err.message}`);
    }
  });
  server.on('error', (err) => {
    // EADDRINUSE on a daemon means we lost a spawn race — exit quietly;
    // the winner serves the same root, so the client's health re-probe succeeds.
    process.exit(err.code === 'EADDRINUSE' ? 0 : 2);
  });
  server.listen(port, '0.0.0.0');
}

async function publish(file, explicitPort) {
  if (!file) {
    console.error('--file is required');
    process.exit(1);
  }
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    console.error(`file not found: ${abs}`);
    process.exit(1);
  }
  mkdirSync(SERVE_ROOT, { recursive: true });
  const name = basename(abs);
  copyFileSync(abs, join(SERVE_ROOT, name));

  let port;
  if (explicitPort) {
    const state = await probeHealth(explicitPort);
    if (state === 'ours') port = explicitPort;
    else if (state === 'free') {
      startDaemon(explicitPort);
      port = (await waitForOurs(explicitPort)) ? explicitPort : null;
    } else port = null;
  } else {
    port = await ensureServer();
  }
  if (!port) {
    console.error(`could not start or find a soma-html-serve daemon (base port ${explicitPort ?? BASE_PORT})`);
    process.exit(2);
  }

  const encoded = encodeURIComponent(name);
  console.log(
    JSON.stringify(
      {
        url: `http://${lanIp()}:${port}/${encoded}`,
        localUrl: `http://localhost:${port}/${encoded}`,
        port,
        file: join(SERVE_ROOT, name),
      },
      null,
      2,
    ),
  );
}

const args = parseArgs(process.argv);
if (args.daemon) {
  if (!args.port) {
    console.error('--daemon requires --port');
    process.exit(1);
  }
  runDaemon(args.port);
} else {
  publish(args.file, args.port);
}
