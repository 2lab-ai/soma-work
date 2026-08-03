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
 *   1. Copies <file> into the serve root — a DURABLE per-user data dir that
 *      doubles as the permanent artifact archive (see resolution order at
 *      defaultServeRoot below). Never a system temp dir by default: OS temp
 *      cleanup used to wipe every published artifact.
 *   2. Ensures a detached daemon is listening (spawns one if needed —
 *      survives the agent turn; idempotent across sessions).
 *   3. Prints JSON: { "url", "localUrl", "port", "file" } on stdout
 *      (+ "note" when an older daemon is still serving the legacy root).
 *
 * Daemon mode (internal): node serve.mjs --daemon --port <port>
 *   Plain node:http static server, serving the serve root.
 *   GET /__soma-serve-health → "soma-html-serve\nroot=<serve-root>"
 *     (ownership probe; the root line lets a publisher detect a daemon that
 *     is still serving a different — e.g. legacy /tmp — root).
 *   GET /                    → directory index of the archive, newest first.
 *
 * Archive semantics: artifacts are timestamped by the skill, never
 * auto-pruned here, and migrate forward automatically from the legacy
 * /tmp root when one is found. Reclaiming disk is a human decision.
 *
 * Exposure policy: binds 0.0.0.0 by default — LAN reachability is the whole
 * point (the user opens the link from another machine). Everything ever
 * published to the serve root is therefore listable and readable by anyone
 * on the LAN; do not publish artifacts containing secrets. Set
 * SOMA_HTML_SERVE_BIND=127.0.0.1 to restrict to the host. Symlinks inside
 * the serve root are refused (realpath containment check).
 *
 * Exit codes: 0 published, 1 CLI/input error, 2 could not start/find server.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pre-durable-root versions served from here; kept only as a migration
// source and as the assumed root of daemons started by those versions.
const LEGACY_SERVE_ROOT = '/tmp/soma-html-serve';

function defaultServeRoot() {
  // Resolution order (first hit wins):
  //   1. SOMA_HTML_SERVE_ROOT       — explicit override, any path the user wants.
  //   2. $XDG_DATA_HOME/soma-html-serve
  //   3. ~/.local/share/soma-html-serve  (works on macOS and Linux alike)
  //   4. LEGACY_SERVE_ROOT          — only when no home dir is resolvable.
  if (process.env.SOMA_HTML_SERVE_ROOT) return process.env.SOMA_HTML_SERVE_ROOT;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'soma-html-serve');
  const home = homedir();
  if (home) return join(home, '.local', 'share', 'soma-html-serve');
  return LEGACY_SERVE_ROOT;
}

const SERVE_ROOT = defaultServeRoot();
const BIND_ADDR = process.env.SOMA_HTML_SERVE_BIND || '0.0.0.0';
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
  // Resolves { state: 'ours'|'foreign'|'free', root?: string }.
  // Ownership is decided by the FIRST line only, so daemons from versions
  // that answered a bare body (no root line) still probe as ours; their
  // root is assumed to be the legacy /tmp path.
  return new Promise((resolveProbe) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: HEALTH_PATH, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const lines = body.trim().split('\n');
          if (lines[0].trim() !== HEALTH_BODY) return resolveProbe({ state: 'foreign' });
          const rootLine = lines.find((l) => l.startsWith('root='));
          resolveProbe({ state: 'ours', root: rootLine ? rootLine.slice(5).trim() : LEGACY_SERVE_ROOT });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolveProbe({ state: 'foreign' });
    });
    req.on('error', (err) => {
      resolveProbe({ state: err.code === 'ECONNREFUSED' ? 'free' : 'foreign' });
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

async function waitForOurs(port, attempts = 30, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    const probe = await probeHealth(port);
    if (probe.state === 'ours') return probe;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function ensureServer() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_SCAN_RANGE; port++) {
    const probe = await probeHealth(port);
    if (probe.state === 'ours') return { port, root: probe.root };
    if (probe.state === 'free') {
      startDaemon(port);
      const started = await waitForOurs(port);
      if (started) return { port, root: started.root };
      // Lost the race or daemon died — try the next port instead of looping here.
    }
    // 'foreign': some other process owns this port; never serve through it.
  }
  return null;
}

function migrateLegacyArtifacts() {
  // Best-effort forward migration: anything still alive in the legacy /tmp
  // root gets copied into the durable archive (existing names are never
  // overwritten). Runs at daemon start and at every publish, so surviving
  // artifacts are rescued before the next OS temp cleanup gets them.
  if (SERVE_ROOT === LEGACY_SERVE_ROOT) return 0;
  let migrated = 0;
  try {
    if (!existsSync(LEGACY_SERVE_ROOT)) return 0;
    mkdirSync(SERVE_ROOT, { recursive: true });
    for (const name of readdirSync(LEGACY_SERVE_ROOT)) {
      if (name.startsWith('.')) continue;
      try {
        const src = join(LEGACY_SERVE_ROOT, name);
        const dst = join(SERVE_ROOT, name);
        if (statSync(src).isFile() && !existsSync(dst)) {
          copyFileSync(src, dst);
          migrated++;
        }
      } catch {
        // one unreadable entry must not abort the migration sweep
      }
    }
  } catch {
    // migration is opportunistic — publishing must not fail because of it
  }
  return migrated;
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
  migrateLegacyArtifacts();
  const rootReal = realpathSync(SERVE_ROOT);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === HEALTH_PATH) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        // Line 1 = ownership token (older publishers compare only this);
        // line 2 advertises which root this daemon actually serves.
        res.end(`${HEALTH_BODY}\nroot=${SERVE_ROOT}`);
        return;
      }
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(directoryIndex());
        return;
      }
      const target = resolve(rootReal, '.' + pathname);
      // Path-traversal guard, pass 1: the lexically resolved target must stay
      // inside the serve root (catches ../ tricks).
      if (target !== rootReal && !target.startsWith(rootReal + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!existsSync(target)) {
        res.writeHead(404).end('not found');
        return;
      }
      // Pass 2: follow symlinks and re-check containment — a symlink inside
      // the root pointing at /Users/…/.ssh/id_rsa must not be served.
      const targetReal = realpathSync(target);
      if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      if (!statSync(targetReal).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(targetReal).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(readFileSync(targetReal));
    } catch (err) {
      res.writeHead(500).end(`error: ${err.message}`);
    }
  });
  server.on('error', (err) => {
    // EADDRINUSE on a daemon means we lost a spawn race — exit quietly;
    // the winner serves the same root, so the client's health re-probe succeeds.
    process.exit(err.code === 'EADDRINUSE' ? 0 : 2);
  });
  server.listen(port, BIND_ADDR);
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
  migrateLegacyArtifacts();
  const name = basename(abs);
  copyFileSync(abs, join(SERVE_ROOT, name));

  let port = null;
  let daemonRoot = null;
  if (explicitPort) {
    const probe = await probeHealth(explicitPort);
    if (probe.state === 'ours') {
      port = explicitPort;
      daemonRoot = probe.root;
    } else if (probe.state === 'free') {
      startDaemon(explicitPort);
      const started = await waitForOurs(explicitPort);
      if (started) {
        port = explicitPort;
        daemonRoot = started.root;
      }
    }
  } else {
    const found = await ensureServer();
    if (found) {
      port = found.port;
      daemonRoot = found.root;
    }
  }
  if (!port) {
    console.error(`could not start or find a soma-html-serve daemon (base port ${explicitPort ?? BASE_PORT})`);
    process.exit(2);
  }

  // A daemon from before the durable-root change (or with a different env)
  // serves a different directory than the one we just archived into. Drop a
  // copy where that daemon can see it so the printed link works right now;
  // the durable root takes over when the daemon next restarts.
  let note;
  if (daemonRoot && daemonRoot !== SERVE_ROOT) {
    try {
      mkdirSync(daemonRoot, { recursive: true });
      copyFileSync(abs, join(daemonRoot, name));
      note = `daemon on port ${port} still serves ${daemonRoot} (pre-durable-root daemon); artifact archived in ${SERVE_ROOT} and also copied next to the daemon so the link works now`;
    } catch {
      note = `daemon on port ${port} serves ${daemonRoot}, which is not writable; the link may 404 until the daemon restarts with root ${SERVE_ROOT}`;
    }
  }

  const encoded = encodeURIComponent(name);
  console.log(
    JSON.stringify(
      {
        url: `http://${lanIp()}:${port}/${encoded}`,
        localUrl: `http://localhost:${port}/${encoded}`,
        port,
        file: join(SERVE_ROOT, name),
        ...(note ? { note } : {}),
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
  publish(args.file, args.port).catch((err) => {
    // Keep the documented 0/1/2 exit-code contract even for unexpected
    // throws (EACCES on copy, EROFS on mkdir, …) instead of an unhandled
    // rejection stack.
    console.error(`publish failed: ${err.message}`);
    process.exit(2);
  });
}
