import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The bin as shipped: CI builds the workspace packages before the tests; locally run
// `npx tsc -p packages/devops-broker/tsconfig.json` first.
const CLI = path.resolve(__dirname, '../dist/cli.js');
const VALUE = 'test-secret-0001';
const ZERO_ID = '0'.repeat(32);
const ONE_ID = '1'.repeat(32);

let root: string;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`${CLI} is missing — build packages/devops-broker before running this test`);
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'devops-cli-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SOMA_DEVOPS_ROOT;
  return env;
}

function run(args: string[], input = ''): { status: number | null; stdout: string; stderr: string } {
  const env = cleanEnv();
  const result = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env, timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writePolicy(admins: string[] = ['U000ADMIN', 'U000OTHER']): void {
  const policy = {
    admins,
    gh: {
      org: 'example-org',
      accounts: {
        member: { login: 'alice', class: 'member' },
        'org-admin': { login: 'alice-admin', class: 'org-admin' },
      },
      restWriteAllowlist: [],
    },
    cloudflare: {
      dev2: {
        accountId: ZERO_ID,
        zones: { 'example.com': ONE_ID },
        permissionGroups: { read: ['dns-read-group'], edit: ['dns-edit-group'] },
        defaultTtl: '1h',
        maxTtl: '71h',
        ipCondition: false,
      },
    },
    approvalTimeout: '5m',
  };
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify(policy), { mode: 0o640 });
}

describe('soma-devops-broker ingest', () => {
  it('stores a piped secret 0600 and prints only kind, name and size', () => {
    const result = run(['ingest', 'gh', 'member', '--root', root], `${VALUE}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`stored gh/member (${VALUE.length} bytes)\n`);
    const file = path.join(root, 'secrets/gh/member.token');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe(VALUE);
  });

  it('accepts --root before the command', () => {
    const result = run(['--root', root, 'ingest', 'cf', 'dev2'], VALUE);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`stored cf/dev2 (${VALUE.length} bytes)\n`);
  });

  it('refuses a malformed value without echoing it', () => {
    const value = 'zz-marker-0001 zz-marker-0002';
    const result = run(['ingest', 'slack', 'broker-app', '--root', root], value);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('zz-marker');
    expect(fs.existsSync(path.join(root, 'secrets/slack/broker-app.token'))).toBe(false);
  });

  it.each([
    [['ingest', 'npm', 'member']],
    [['ingest', 'gh']],
    [['ingest', 'gh', 'member', 'extra']],
    [['ingest', 'gh', '../member']],
  ])('refuses %j with exit 2', (args) => {
    const result = run([...args, '--root', root], VALUE);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain(VALUE);
    expect(fs.existsSync(path.join(root, 'secrets'))).toBe(false);
  });
});

describe('soma-devops-broker check-policy', () => {
  it('summarizes the policy and secret files without printing values or admin ids', () => {
    writePolicy();
    fs.mkdirSync(path.join(root, 'secrets/gh'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'secrets/gh/member.token'), VALUE, { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'secrets/gh/org-admin.token'), VALUE, { mode: 0o644 });
    fs.chmodSync(path.join(root, 'secrets/gh/org-admin.token'), 0o644);

    const result = run(['check-policy', '--root', root]);
    const out = result.stdout;
    expect(result.status).toBe(1);
    expect(out).toContain('admins: 2');
    expect(out).toMatch(/member\s+class=member/);
    expect(out).toMatch(/org-admin\s+class=org-admin/);
    expect(out).toMatch(/dev2.*example\.com/);
    expect(out).toMatch(/default 1h, max 71h/);
    expect(out).toMatch(/gh\/member\s+ok/);
    expect(out).toMatch(/gh\/org-admin\s+bad/);
    expect(out).toMatch(/cf\/dev2\s+missing/);
    expect(out).toMatch(/slack\/broker-app\s+missing/);
    expect(`${out}${result.stderr}`).not.toContain(VALUE);
    expect(out).not.toContain('U000ADMIN');
  });

  it('exits 0 when the policy is valid and every secret is in place', () => {
    writePolicy();
    for (const [kind, name] of [
      ['gh', 'member'],
      ['gh', 'org-admin'],
      ['cf', 'dev2'],
      ['slack', 'broker-app'],
    ]) {
      expect(run(['ingest', kind, name, '--root', root], VALUE).status).toBe(0);
    }
    const result = run(['check-policy', '--root', root]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(VALUE);
  });

  it('exits 1 with the problem when the policy is invalid', () => {
    writePolicy([]);
    const result = run(['check-policy', '--root', root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('policy.admins');
  });

  it('exits 1 when there is no policy file', () => {
    const result = run(['check-policy', '--root', root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, 'policy.json'));
  });
});

describe('soma-devops-broker other commands', () => {
  it.each([
    [[]],
    [['frobnicate']],
    [['--root']],
    [['--bogus', 'serve']],
    [['check-policy', '--gh', '/usr/bin/true']],
  ])('%j prints usage and exits 2', (args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: soma-devops-broker');
  });

  it('help prints usage on stdout and exits 0', () => {
    const result = run(['help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: soma-devops-broker');
  });
});

// A root-owned executable in a root-owned, not group-writable directory: passes gh-runner's ownership check.
// `serve` only vets the gh path at startup; nothing here runs it.
const ROOT_OWNED_GH = '/usr/bin/true';

function prepareServe(): void {
  writePolicy();
  expect(run(['ingest', 'slack', 'broker-app', '--root', root], VALUE).status).toBe(0);
  fs.mkdirSync(path.join(root, 'run'), { mode: 0o750 });
  fs.chmodSync(path.join(root, 'run'), 0o750);
}

async function waitForFile(file: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} did not appear`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function ask(socketPath: string, request: unknown): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      text += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () =>
      resolve(
        text
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ),
    );
  });
}

describe('soma-devops-broker serve', () => {
  it('exits 1 naming the policy file when there is no policy', () => {
    const result = run(['serve', '--root', root, '--gh', ROOT_OWNED_GH]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, 'policy.json'));
  });

  it('exits 1 when the Slack app token is missing', () => {
    writePolicy();
    // Another secret in place, so the secrets tree exists and the message names the missing token file.
    expect(run(['ingest', 'slack', 'other', '--root', root], VALUE).status).toBe(0);
    const result = run(['serve', '--root', root, '--gh', ROOT_OWNED_GH]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, 'secrets/slack/broker-app.token'));
  });

  it('exits 1 when gh is not root-owned', () => {
    prepareServe();
    const gh = path.join(root, 'gh');
    fs.writeFileSync(gh, '#!/bin/sh\n', { mode: 0o755 });
    const result = run(['serve', '--root', root, '--gh', gh]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/root/);
    expect(fs.existsSync(path.join(root, 'run/broker.sock'))).toBe(false);
  });

  it('exits 1 when the run directory is group- or other-writable', () => {
    prepareServe();
    fs.chmodSync(path.join(root, 'run'), 0o777);
    const result = run(['serve', '--root', root, '--gh', ROOT_OWNED_GH]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('writable');
    expect(`${result.stdout}${result.stderr}`).not.toContain(VALUE);
  });

  it('listens on a 0660 socket, answers list, and stops cleanly on SIGTERM', async () => {
    prepareServe();
    const socketPath = path.join(root, 'run/broker.sock');
    const child = spawn(process.execPath, [CLI, 'serve', '--root', root, '--gh', ROOT_OWNED_GH], {
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      await waitForFile(socketPath);
      expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o660);
      const messages = await ask(socketPath, {
        v: 1,
        id: 'req-1',
        tool: 'list',
        args: {},
        claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'session-1' },
      });
      expect(messages).toEqual([
        expect.objectContaining({
          type: 'result',
          id: 'req-1',
          data: expect.objectContaining({
            accounts: [
              { name: 'member', class: 'member' },
              { name: 'org-admin', class: 'org-admin' },
            ],
            leases: [],
          }),
        }),
      ]);
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toBe(0);
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(output).not.toContain(VALUE);
    const events = fs
      .readFileSync(path.join(root, 'state/ledger.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { event: string }).event)
      // The startup sweep adds cf-* rows (no forge key in this test); they are cf-client's.
      .filter((event) => !event.startsWith('cf-'));
    expect(events).toEqual(['broker.start', 'request', 'broker.stop']);
    expect(output).toMatch(/startup sweep/);
  }, 30_000);
});
