import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
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
    expect(result.stdout).toContain('passkey enrol <admin>');
  });
});

describe('soma-devops-broker passkey (#1056)', () => {
  it('without a running broker, says so and exits 1 (it only ever talks to the broker)', () => {
    fs.mkdirSync(path.join(root, 'state'), { mode: 0o700 });
    const result = run(['passkey', 'list', '--root', root]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no broker with an approval page is running');
    expect(result.stderr).toContain(path.join(root, 'state', 'operator.sock'));
    // The command wrote nothing: passkeys are stored by the broker process only.
    expect(fs.readdirSync(path.join(root, 'state'))).toEqual([]);
  });

  it.each([
    [['passkey']],
    [['passkey', 'enrol']],
    [['passkey', 'frobnicate', 'x']],
  ])('%j prints the passkey usage and exits 2', (args) => {
    const result = run([...args, '--root', root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('passkey enrol <admin>');
  });

  it('refuses --gh', () => {
    expect(run(['passkey', 'list', '--gh', '/usr/bin/true', '--root', root]).status).toBe(2);
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

  /** A policy with the approval page on, and (unless `tls` is false) a certificate for it under tls/. */
  async function prepareApprovalPage(tls = true): Promise<{ port: number; origin: string; cert: Buffer }> {
    prepareServe();
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const found = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(found));
      });
    });
    const origin = `https://approve.home.arpa:${port}`;
    const policyFile = path.join(root, 'policy.json');
    const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8')) as Record<string, unknown>;
    policy.approvalPage = { origin, listenHost: '127.0.0.1' };
    fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o640 });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, 'state'), 0o700);
    const tlsDir = path.join(root, 'tls');
    fs.mkdirSync(tlsDir, { mode: 0o700 });
    fs.chmodSync(tlsDir, 0o700);
    let cert = Buffer.alloc(0);
    if (tls) {
      const config = path.join(tlsDir, 'req.cnf');
      fs.writeFileSync(
        config,
        '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=approve.home.arpa\n[ext]\nsubjectAltName=DNS:approve.home.arpa\n',
      );
      const keyFile = path.join(tlsDir, 'key.pem');
      const certFile = path.join(tlsDir, 'cert.pem');
      for (const args of [
        ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyFile],
        ['req', '-new', '-x509', '-key', keyFile, '-out', certFile, '-days', '2', '-config', config],
      ]) {
        const made = spawnSync('openssl', args, { encoding: 'utf8' });
        if (made.status !== 0) throw new Error(`openssl ${args[0]} failed: ${made.stderr}`);
      }
      fs.rmSync(config);
      fs.chmodSync(keyFile, 0o600);
      cert = fs.readFileSync(certFile);
    }
    return { port, origin, cert };
  }

  function fetchPage(port: number, cert: Buffer, target: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        {
          host: '127.0.0.1',
          port,
          path: target,
          ca: cert,
          servername: 'approve.home.arpa',
          headers: { host: `approve.home.arpa:${port}` },
          agent: false,
        },
        (response) => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            text += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  it('with policy.approvalPage: serves the approval page, opens the operator socket, lists the page address (#1056)', async () => {
    const { port, origin, cert } = await prepareApprovalPage();
    const socketPath = path.join(root, 'run/broker.sock');
    const operatorSocket = path.join(root, 'state/operator.sock');
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
      await waitForFile(operatorSocket);
      expect(fs.lstatSync(operatorSocket).mode & 0o777).toBe(0o600);
      expect(output).toContain(`approval page on ${origin}`);
      // The page answers; a card nobody asked for is gone; the enrol page does not exist yet.
      const shell = await fetchPage(port, cert, '/a/approval-id-0001-aaaaaa');
      expect(shell.status).toBe(200);
      expect(shell.text).toContain('/assets/approve.js');
      expect((await fetchPage(port, cert, '/api/card/approval-id-0001-aaaaaa')).status).toBe(404);
      expect((await fetchPage(port, cert, '/enroll')).status).toBe(404);
      // The operator command reaches the running broker.
      const listed = run(['passkey', 'list', '--root', root]);
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain('no passkeys enrolled');
      // An enrolment opens the enrol page for as long as the operator's terminal stays on it.
      const enrolling = spawn(process.execPath, [CLI, 'passkey', 'enrol', 'U000ADMIN', '--root', root], {
        env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let printed = '';
      enrolling.stdout.on('data', (chunk) => {
        printed += chunk;
      });
      const deadline = Date.now() + 10_000;
      while (!printed.includes('fingerprint> ')) {
        if (Date.now() > deadline) throw new Error(`the enrol command did not prompt: ${printed}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(printed).toContain(`${origin}/enroll#`);
      expect((await fetchPage(port, cert, '/enroll')).status).toBe(200);
      const left = new Promise((resolve) => enrolling.on('exit', resolve));
      enrolling.kill('SIGKILL');
      await left;
      // The terminal is gone: the enrolment went with it.
      const closed = Date.now() + 5_000;
      while ((await fetchPage(port, cert, '/enroll')).status !== 404) {
        if (Date.now() > closed) throw new Error('the enrol page stayed open after the operator left');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toBe(0);
    expect(fs.existsSync(operatorSocket)).toBe(false);
    expect(output).not.toContain(VALUE);
  });

  it('with policy.approvalPage but no certificate: the broker still serves requests, the page stays off', async () => {
    const { port } = await prepareApprovalPage(false);
    const socketPath = path.join(root, 'run/broker.sock');
    const child = spawn(process.execPath, [CLI, 'serve', '--root', root, '--gh', ROOT_OWNED_GH], {
      env: cleanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    try {
      await waitForFile(socketPath);
      const messages = await ask(socketPath, {
        v: 1,
        id: 'req-1',
        tool: 'list',
        args: {},
        claimedRequester: { slackUserId: 'U000ALICE', sessionKey: 'session-1' },
      });
      expect(messages[0]).toMatchObject({ type: 'result', id: 'req-1' });
      expect(output).toMatch(/approval page off: .*cert\.pem does not exist/);
      expect(fs.existsSync(path.join(root, 'state/operator.sock'))).toBe(false);
      await expect(
        new Promise((resolve, reject) => {
          const probe = net.connect(port, '127.0.0.1');
          probe.once('connect', () => {
            probe.destroy();
            resolve('listening');
          });
          probe.once('error', reject);
        }),
      ).rejects.toThrow();
      // The listing has no page address, so the dashboard keeps its Slack link.
      const listed = await ask(socketPath, { v: 1, id: 'dash-1', op: 'approvals', args: {} });
      expect(JSON.stringify(listed)).not.toContain('pageUrl');
    } finally {
      child.kill('SIGTERM');
    }
    expect(await exited).toBe(0);
  });

  it('check-policy reports the approval page and how long its certificate lasts', async () => {
    const { origin } = await prepareApprovalPage();
    const ok = run(['check-policy', '--root', root]);
    expect(ok.stdout).toContain(`approval page: ${origin}`);
    expect(ok.stdout).toMatch(/certificate ok \(\d+ days? left\)/);
    fs.rmSync(path.join(root, 'tls/cert.pem'));
    const broken = run(['check-policy', '--root', root]);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toMatch(/certificate bad \(.*cert\.pem does not exist\)/);
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
