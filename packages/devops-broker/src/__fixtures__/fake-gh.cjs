#!/usr/bin/env node
// Stand-in for the pinned gh binary in gh-runner.test.ts. The test installs a copy with an absolute
// interpreter path in the shebang (the runner's child PATH has no node on it). The mode is the repo name
// in `-R example-org/<mode>`, so every call still passes classifyGh. Every invocation appends a line to
// `invocations.log` next to the installed copy — the only channel a denied call could leave a trace in.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

fs.appendFileSync(path.join(__dirname, 'invocations.log'), `${JSON.stringify(process.argv.slice(2))}\n`);

const argv = process.argv.slice(2);
const repoAt = argv.indexOf('-R');
const mode = repoAt >= 0 ? (argv[repoAt + 1] || '').split('/')[1] || '' : '';
const token = process.env.GH_TOKEN || '';

/** Byte offset a token is written at in `token-at-cut`; the test caps output at 64 KiB. */
const CUT = 64 * 1024;

function tryRead(file) {
  try {
    return { file, content: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { file, error: err.code || String(err) };
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    return `error:${err.code || String(err)}`;
  }
}

function base64At(offset, alphabet) {
  const padded = Buffer.concat([Buffer.alloc(offset, 0x41), Buffer.from(token, 'utf8')]);
  return padded.toString(alphabet);
}

/** A grandchild that sleeps 30 s; `stdio` decides whether it holds the runner's pipes. */
function grandchild(stdio, detached) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio, detached });
  child.unref();
  return child.pid;
}

function flood(stream, bytes, done) {
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  let left = bytes;
  const pump = () => {
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      left -= n;
      if (!stream.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
        stream.once('drain', pump);
        return;
      }
    }
    done();
  };
  pump();
}

switch (mode) {
  case 'env': {
    const home = process.env.HOME || '';
    const config = process.env.GH_CONFIG_DIR || '';
    const xdg = process.env.XDG_CONFIG_HOME || '';
    const report = {
      env: process.env,
      cwd: process.cwd(),
      cwdEntries: list(process.cwd()),
      homeEntries: list(home),
      configEntries: list(config),
      hostsReads: [
        tryRead(path.join(home, '.config', 'gh', 'hosts.yml')),
        tryRead(path.join(config, 'hosts.yml')),
        tryRead(path.join(xdg, 'gh', 'hosts.yml')),
      ],
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    break;
  }
  case 'token-raw':
    process.stdout.write(`token=${token}\nagain:${token}${token}\n`);
    process.stderr.write(`debug: GH_TOKEN=${token}\n`);
    break;
  case 'token-encoded':
    process.stdout.write(
      [
        `b64-0=${base64At(0, 'base64')}`,
        `b64-1=${base64At(1, 'base64')}`,
        `b64-2=${base64At(2, 'base64')}`,
        `b64url-0=${base64At(0, 'base64url')}`,
        `b64url-1=${base64At(1, 'base64url')}`,
        `b64url-2=${base64At(2, 'base64url')}`,
        `pct=${encodeURIComponent(token)}`,
        `pct-lower=${encodeURIComponent(token).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`,
        '',
      ].join('\n'),
    );
    break;
  case 'stderr-exit':
    process.stdout.write('partial result\n');
    process.stderr.write(`HTTP 401: Bad credentials (token ${token})\n`);
    process.exitCode = 3;
    break;
  case 'sleep':
    process.stdout.write('sleeping\n');
    setTimeout(() => {}, 60_000);
    break;
  case 'flood':
    flood(process.stdout, 4 * 1024 * 1024, () => flood(process.stderr, 4 * 1024 * 1024, () => {}));
    break;
  case 'token-at-cut':
    // The token straddles the 64 KiB cap: its first 12 characters land inside it.
    process.stdout.write(`${'x'.repeat(CUT - 12)}${token}\n`);
    break;
  case 'utf8-at-cut':
    // A 3-byte character straddles the 64 KiB cap.
    process.stdout.write(`${'x'.repeat(CUT - 1)}\u{D55C}tail\n`);
    break;
  case 'grandchild-exit':
    // Exits at once; its grandchild (same process group) keeps the stdout/stderr pipes open.
    process.stdout.write(`grandchild=${grandchild(['ignore', 'inherit', 'inherit'], false)}\n`);
    break;
  case 'grandchild-timeout':
    // Sleeps past the timeout; its grandchild (same process group) holds no pipes.
    process.stdout.write(`grandchild=${grandchild('ignore', false)}\n`);
    setTimeout(() => {}, 60_000);
    break;
  case 'setsid-holder':
    // Exits at once; a grandchild in its own session (out of reach of a group kill) keeps the pipes open.
    process.stdout.write(`holder=${grandchild(['ignore', 'inherit', 'inherit'], true)}\n`);
    break;
  case 'nap':
    // Runs for 1.5 s, then exits cleanly.
    setTimeout(() => process.stdout.write('rested\n'), 1_500);
    break;
  case 'balloon': {
    // Grows resident memory to 512 MiB, then holds it.
    const hold = [];
    for (let i = 0; i < 32; i++) hold.push(Buffer.alloc(16 * 1024 * 1024, 1));
    process.stdout.write(`allocated ${hold.length}\n`);
    setTimeout(() => hold.length, 60_000);
    break;
  }
  default:
    process.stderr.write(`fake gh: unknown mode "${mode}"\n`);
    process.exitCode = 64;
}
