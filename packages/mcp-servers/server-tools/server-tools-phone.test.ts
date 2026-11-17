/**
 * .prd/30-phone-calls-spec.md §3.1 — server-tools `phone_call` · `phone_calls`. The line lives in the daemon, so
 * `phone_call` hands it a request file and waits for the answer file; `phone_calls` reads the daemon's call records.
 * Here a tiny fake daemon answers the request files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler() {}
    connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
}));
vi.mock('@soma/process-shared/stderr-logger.js', () => ({
  StderrLogger: class {
    debug() {}
    info() {}
    warn() {}
    error() {}
  },
}));

import { requestCall } from './env-phone.js';
import {
  handleList,
  handlePhoneCall,
  handlePhoneCalls,
  handleSshExec,
  loadConfig,
  resetConfigCache,
} from './server-tools-mcp-server.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'server-tools-phone-'));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS = path.join(ROOT, 'secrets');
const AUDIT = path.join(ROOT, 'data', 'env-audit');
const PHONE = path.join(ROOT, 'data', 'phone');
const saved = { ...process.env };

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const PHONE_SECTION = {
  apiKey: { $secret: 'koreaaitel-test' },
  accountId: 'ACtest0000',
  number: '070-1234-5678',
  voice: { url: 'http://voice-host:9999' },
  outbound: { maxMinutes: 10 },
};

function writeConfig(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({
      'server-tools': {
        '2lab-ai-dev': { envUser: 'env:2lab-ai-dev', phone: PHONE_SECTION },
        plainkey: { phone: { ...PHONE_SECTION, apiKey: 'sk_in_config' } },
        dev2: { ssh: { host: 'dev2' } },
        ...extra,
      },
    }),
  );
  resetConfigCache();
  loadConfig();
}

/** A fake daemon: answers every request file once, as the real one does (claim → result). */
let daemon: NodeJS.Timeout | undefined;
let seen: Array<Record<string, unknown>> = [];
function startDaemon(answer: (req: Record<string, unknown>) => Record<string, unknown>) {
  const dir = path.join(PHONE, 'requests');
  daemon = setInterval(() => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const m = /^([a-z0-9]+)\.json$/.exec(n);
      if (!m) continue;
      const req = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8'));
      fs.rmSync(path.join(dir, n));
      seen.push(req);
      fs.writeFileSync(path.join(dir, `${m[1]}.result.json`), JSON.stringify(answer(req)));
    }
  }, 20);
}

beforeEach(() => {
  fs.mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(SECRETS, 'koreaaitel-test'), 'sk_test_key\n', { mode: 0o600 });
  process.env.SOMA_CONFIG_FILE = CONFIG_FILE;
  process.env.SOMA_SECRETS_DIR = SECRETS;
  process.env.SOMA_AUDIT_DIR = AUDIT;
  process.env.SOMA_PHONE_DIR = PHONE;
  process.env.SOMA_REQUESTER = 'U123';
  process.env.SOMA_PHONE_CONTEXT = JSON.stringify({ channel: 'C1', threadTs: '1.2', conversationId: 'conv-1' });
  seen = [];
  writeConfig();
});
afterEach(() => {
  if (daemon) clearInterval(daemon);
  daemon = undefined;
  process.env = { ...saved };
  fs.rmSync(path.join(ROOT, 'data'), { recursive: true, force: true });
});

const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const audit = () =>
  fs
    .readFileSync(path.join(AUDIT, 'env-audit.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('config', () => {
  it('lists a phone-only environment with no host, and keeps a key written into config.json out', () => {
    const { servers } = text(handleList() as never);
    expect(servers.find((s: { name: string }) => s.name === '2lab-ai-dev')).toMatchObject({
      ssh_host: null,
      phone: true,
    });
    expect(servers.find((s: { name: string }) => s.name === 'plainkey').phone).toBeUndefined();
    expect(servers.find((s: { name: string }) => s.name === 'dev2')).toMatchObject({ ssh_host: 'dev2' });
  });

  it('a phone key not yet in the secret store leaves the environment and its other tools in place', () => {
    writeConfig({
      mixed: { ssh: { host: 'mixed-host' }, phone: { ...PHONE_SECTION, apiKey: { $secret: 'not-yet' } } },
    });
    const { servers } = text(handleList() as never);
    expect(servers.find((s: { name: string }) => s.name === 'mixed')).toMatchObject({
      ssh_host: 'mixed-host',
      phone: true,
    });
    // server-tools never holds the line's key: only the daemon resolves it.
    expect(JSON.stringify(loadConfig()['2lab-ai-dev'])).not.toContain('sk_test_key');
  });

  it('a host tool on a phone-only environment says there is no host', () => {
    expect(() => handleSshExec({ server: '2lab-ai-dev', command: 'uptime' })).toThrow(/no host to reach/);
  });
});

describe('phone_call', () => {
  it('hands the daemon a request with the session context and returns the call id; audited before and after', async () => {
    startDaemon(() => ({ ok: true, callId: 'CA42' }));
    const r = text(
      (await handlePhoneCall({
        server: '2lab-ai-dev',
        to: '010-1234-5678',
        title: '테스트',
        purpose: '오늘 할 일을 묻는다',
        scenario: '짧게',
        max_minutes: 30,
      })) as never,
    );
    expect(r).toMatchObject({ callId: 'CA42', status: 'dialing', to: '01012345678', maxMinutes: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      env: '2lab-ai-dev',
      to: '01012345678',
      purpose: '오늘 할 일을 묻는다',
      scenario: '짧게',
      maxMinutes: 10,
      requester: 'U123',
      context: { channel: 'C1', threadTs: '1.2', conversationId: 'conv-1' },
    });
    const lines = audit();
    expect(lines.map((l) => l.phase)).toEqual(['intent', 'done']);
    expect(lines[0]).toMatchObject({
      server: '2lab-ai-dev',
      envUser: 'env:2lab-ai-dev',
      requester: 'U123',
      tool: 'phone_call',
      action: 'dial',
    });
    expect(lines[0].detail.purposeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(lines)).not.toContain('오늘 할 일을 묻는다');
    expect(lines[1].detail.callId).toBe('CA42');
  });

  it('reports the daemon refusing, and records the failure', async () => {
    startDaemon(() => ({ ok: false, error: 'phone line 2lab-ai-dev is busy with another call' }));
    await expect(handlePhoneCall({ server: '2lab-ai-dev', to: '01012345678', purpose: 'p' })).rejects.toThrow(
      'not dialed: phone line 2lab-ai-dev is busy with another call',
    );
    expect(audit().map((l) => l.phase)).toEqual(['intent', 'failed']);
  });

  it('refuses before anything is written: no requester, bad number, no purpose, allowTo, no phone section', async () => {
    delete process.env.SOMA_REQUESTER;
    await expect(handlePhoneCall({ server: '2lab-ai-dev', to: '01012345678', purpose: 'p' })).rejects.toThrow(
      /no requester/,
    );
    process.env.SOMA_REQUESTER = 'U123';
    await expect(handlePhoneCall({ server: '2lab-ai-dev', to: '911', purpose: 'p' })).rejects.toThrow(
      /Korean phone number/,
    );
    await expect(handlePhoneCall({ server: '2lab-ai-dev', to: '01012345678', purpose: ' ' })).rejects.toThrow(
      /purpose is required/,
    );
    await expect(handlePhoneCall({ server: 'dev2', to: '01012345678', purpose: 'p' })).rejects.toThrow(
      /has no phone section/,
    );
    await expect(handlePhoneCall({ server: 'nope', to: '01012345678', purpose: 'p' })).rejects.toThrow(
      /Unknown server/,
    );
    writeConfig({ guarded: { phone: { ...PHONE_SECTION, outbound: { allowTo: ['010-0000-0000'] } } } });
    await expect(handlePhoneCall({ server: 'guarded', to: '01012345678', purpose: 'p' })).rejects.toThrow(/allowTo/);
    expect(fs.existsSync(path.join(PHONE, 'requests'))).toBe(false);
  });

  it('a call placed whose closing audit line cannot be written still returns its id', async () => {
    startDaemon(() => {
      fs.chmodSync(path.join(AUDIT, 'env-audit.jsonl'), 0o400); // the audit log turns read-only mid-call
      return { ok: true, callId: 'CA77' };
    });
    try {
      const r = text((await handlePhoneCall({ server: '2lab-ai-dev', to: '010-1234-5678', purpose: '확인' })) as never);
      expect(r).toMatchObject({ callId: 'CA77', status: 'dialing' });
      expect(r.warning).toMatch(/audit/);
    } finally {
      fs.chmodSync(path.join(AUDIT, 'env-audit.jsonl'), 0o600);
    }
  });

  it('withdraws the request when no daemon answers', async () => {
    await expect(
      requestCall(PHONE, { env: 'e', to: '01012345678', title: '', purpose: 'p', maxMinutes: 1, requester: 'U1' }, 200),
    ).rejects.toThrow(/not running/);
    expect(fs.readdirSync(path.join(PHONE, 'requests'))).toEqual([]);
  });
});

describe('phone_calls', () => {
  function writeCall(id: string, over: Record<string, unknown> = {}) {
    const dir = path.join(PHONE, 'calls');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        id,
        env: '2lab-ai-dev',
        status: 'ended',
        endedStatus: 'completed',
        createdAt: Number(id.replace(/\D/g, '')) || 1,
        requester: 'U123',
        transcript: [
          { role: 'agent', text: '안녕하세요', at: 1 },
          { role: 'peer', text: '네', at: 2, interrupted: false },
        ],
        work: [{ kind: 'event', at: 1, text: 'x' }],
        ...over,
      }),
    );
  }

  it('lists the requester’s calls on this environment, newest first, without transcripts or work', async () => {
    writeCall('CA1');
    writeCall('CA2');
    writeCall('CA3', { requester: 'U999' });
    writeCall('CA4', { env: 'other' });
    const r = text((await handlePhoneCalls({ server: '2lab-ai-dev' })) as never);
    expect(r.calls.map((c: { id: string }) => c.id)).toEqual(['CA2', 'CA1']);
    expect(r.calls[0].lines).toBe(2);
    expect(r.calls[0].work).toBeUndefined();
  });

  it('reads one call as lines, and waits for a running call to end', async () => {
    writeCall('CA7', { status: 'active', endedStatus: undefined });
    setTimeout(() => writeCall('CA7'), 300);
    const r = text((await handlePhoneCalls({ server: '2lab-ai-dev', call_id: 'CA7', wait_seconds: 5 })) as never);
    expect(r.status).toBe('ended');
    expect(r.transcript).toEqual(['에이전트: 안녕하세요', '상대: 네']);
    expect(r.work).toBeUndefined();
  });

  it('does not show another person’s call', async () => {
    writeCall('CA8', { requester: 'U999' });
    await expect(handlePhoneCalls({ server: '2lab-ai-dev', call_id: 'CA8' })).rejects.toThrow(/has no call CA8/);
  });

  it('a session with no requester reads no calls at all', async () => {
    writeCall('CA1');
    delete process.env.SOMA_REQUESTER;
    await expect(handlePhoneCalls({ server: '2lab-ai-dev' })).rejects.toThrow(/no requester/);
    await expect(handlePhoneCalls({ server: '2lab-ai-dev', call_id: 'CA1' })).rejects.toThrow(/no requester/);
  });

  it('reads a call whose file was torn from its last good copy', async () => {
    writeCall('CA5');
    const file = path.join(PHONE, 'calls', 'CA5.json');
    fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(file, '{"id": "CA5", "env": "2lab-');
    const one = text((await handlePhoneCalls({ server: '2lab-ai-dev', call_id: 'CA5' })) as never);
    expect(one.transcript).toHaveLength(2);
    const list = text((await handlePhoneCalls({ server: '2lab-ai-dev' })) as never);
    expect(list.calls.map((c: { id: string }) => c.id)).toContain('CA5');
  });
});
