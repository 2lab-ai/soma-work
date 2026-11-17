/**
 * PhoneService (.prd/31-phone-calls-architecture.md §1–§2): one line per environment with a `phone` section, the
 * request files from server-tools, outbound dial → record → run, inbound screening, and the end of a call.
 * The SDK, the voice service and the dialog are fakes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceDialog, VoiceDialogEvent } from '../../agent-runtime/voice-dialog';
import { PhoneCallStore } from '../call-store';
import type { AgentLike, AgentOptions, CallSessionLike, IncomingCallLike, KoreaAiTelSdk } from '../koreaaitel';
import { PhoneService, type PhoneServiceDeps } from '../phone-service';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-svc-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

class FakeAgent implements AgentLike {
  handlers: Record<string, (...a: any[]) => unknown> = {};
  incoming?: (call: IncomingCallLike) => void | Promise<void>;
  connected = false;
  dialed: string[] = [];
  constructor(readonly options: AgentOptions) {}
  on(event: string, handler: (...a: any[]) => unknown) {
    this.handlers[event] = handler;
    return this;
  }
  onIncoming(handler: (call: IncomingCallLike) => void | Promise<void>) {
    this.incoming = handler;
    return this;
  }
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async call(to: string): Promise<CallSessionLike> {
    this.dialed.push(to);
    return fakeCall(`CA${this.dialed.length}`, 'outbound');
  }
}
function fakeCall(callId: string, direction: string, endedStatus: string | null = null): CallSessionLike {
  return {
    callId,
    fromNumber: '01099998888',
    toNumber: '07012345678',
    direction,
    status: 'ringing',
    endedStatus,
    endedDuration: 42,
    sendAudio() {},
    clearAudio() {},
    async hangup() {},
    async wait() {},
  };
}
class SilentDialog implements VoiceDialog {
  sent: string[] = [];
  closed = false;
  send(t: string) {
    this.sent.push(t);
    return true;
  }
  async interrupt() {}
  close() {
    this.closed = true;
  }
  events: AsyncIterable<VoiceDialogEvent> = { async *[Symbol.asyncIterator]() {} };
}

function serverTools(phone: Record<string, unknown> = {}) {
  return {
    permission: { list: 'read' },
    dev2: { ssh: { host: 'x' } },
    '2lab-ai-dev': {
      phone: {
        apiKey: { $secret: 'k' },
        accountId: 'ACtest0000',
        number: '07012345678',
        owner: 'U0OWNER',
        voice: { url: 'http://voice-host:9999' },
        ...phone,
      },
    },
  };
}

function make(
  section: Record<string, unknown> | (() => Record<string, unknown>) = serverTools(),
  secret = () => 'sk_test',
) {
  const agents: FakeAgent[] = [];
  const dialogs: SilentDialog[] = [];
  const notices: Array<[string, string]> = [];
  const released: string[] = [];
  const store = new PhoneCallStore(dir);
  const sdk: KoreaAiTelSdk = {
    createAgent: (o) => {
      const a = new FakeAgent(o);
      agents.push(a);
      return a;
    },
    ulawToPcm16: (b) => b,
    pcm16ToUlaw: (b) => b,
  };
  const deps: PhoneServiceDeps = {
    sdk,
    store,
    phoneDir: dir,
    readServerTools: () => (typeof section === 'function' ? section() : section),
    resolveSecrets: <T>(v: T) => {
      if (JSON.stringify(v) !== '{"$secret":"k"}') return v;
      const value = secret();
      if (!value) throw new Error('secret "k": not found in the secret store');
      return value as unknown as T;
    },
    dialogAuth: async ({ requester }) => ({
      env: {},
      model: `model-for-${requester}`,
      release: async () => {
        released.push(String(requester));
      },
    }),
    openDialog: () => {
      const d = new SilentDialog();
      dialogs.push(d);
      return d;
    },
    notifyOwner: async (u, t) => {
      notices.push([u, t]);
    },
    dashboardUrl: () => 'https://soma.example',
    log: () => undefined,
    voiceClientFor: () => ({
      transcribe: async () => ({ text: '', ms: 0 }),
      speak: async () => ({ sampleRate: 8000, headersMs: 0, chunks: (async function* () {})() }),
    }),
  };
  return { svc: new PhoneService(deps), agents, dialogs, notices, released, store };
}

const request = (over: Record<string, unknown> = {}) => ({
  rid: 'abc123def456',
  env: '2lab-ai-dev',
  to: '01011112222',
  title: '테스트',
  purpose: '오늘 할 일을 묻는다',
  maxMinutes: 3,
  requester: 'U0REQ',
  context: { channel: 'C1', threadTs: '1.2', conversationId: 'conv-1' },
  createdAt: 1,
  ...over,
});

describe('PhoneService', () => {
  it('opens one line per phone section, with the resolved key, no SDK tools, no prewarm', async () => {
    const { svc, agents } = make();
    await svc.start();
    expect(svc.environments).toEqual(['2lab-ai-dev']);
    expect(agents).toHaveLength(1);
    expect(agents[0].connected).toBe(true);
    expect(agents[0].options).toMatchObject({
      apiKey: 'sk_test',
      accountId: 'ACtest0000',
      from: '07012345678',
      builtinTools: [],
      prewarmEnabled: false,
    });
    await svc.stop();
  });

  it('skips a section whose key does not resolve, and starts nothing without one', async () => {
    const bad = make(serverTools({ apiKey: { $secret: 'missing' } }));
    await bad.svc.start();
    expect(bad.svc.environments).toEqual([]);
    const none = make({ dev2: { ssh: { host: 'x' } } } as never);
    await none.svc.start();
    expect(none.agents).toHaveLength(0);
  });

  it('dials a request: record with the conversation, the run asks for its opening, the answer goes back', async () => {
    const { svc, agents, dialogs, store } = make();
    await svc.start();
    const result = await svc.dial(request() as never);
    expect(result).toEqual({ ok: true, callId: 'CA1' });
    expect(agents[0].dialed).toEqual(['01011112222']);
    const r = store.get('CA1');
    expect(r).toMatchObject({
      env: '2lab-ai-dev',
      direction: 'outbound',
      peerNumber: '01011112222',
      conversationId: 'conv-1',
      requester: 'U0REQ',
      status: 'dialing',
      model: 'model-for-U0REQ',
      voice: 'cwon',
    });
    expect(r?.work[0].kind).toBe('instruction');
    expect((r?.work[0] as { text: string }).text).toContain('오늘 할 일을 묻는다');
    expect(dialogs[0].sent[0]).toContain('첫 마디');
    // One call at a time.
    expect(await svc.dial(request({ rid: 'zzz999yyy888' }) as never)).toMatchObject({
      ok: false,
      error: expect.stringContaining('busy'),
    });
    await svc.stop();
  });

  it('refuses a number outside allowTo', async () => {
    const { svc, agents } = make(serverTools({ outbound: { allowTo: ['010-0000-0000'] } }));
    await svc.start();
    expect(await svc.dial(request() as never)).toMatchObject({ ok: false, error: expect.stringContaining('allowTo') });
    expect(agents[0].dialed).toEqual([]);
    await svc.stop();
  });

  it('claims a request file once and answers in its result file', async () => {
    const { svc } = make();
    await svc.start();
    const reqDir = path.join(dir, 'requests');
    fs.writeFileSync(path.join(reqDir, 'abc123def456.json'), JSON.stringify(request()));
    const resultFile = path.join(reqDir, 'abc123def456.result.json');
    for (let i = 0; i < 50 && !fs.existsSync(resultFile); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf-8'))).toEqual({ ok: true, callId: 'CA1' });
    expect(fs.readdirSync(reqDir).sort()).toEqual(['abc123def456.result.json']);
    await svc.stop();
  });

  it('a call that ends: the record closes with the server length, the lease goes back, the line frees up', async () => {
    const { svc, agents, store, released } = make();
    await svc.start();
    await svc.dial(request() as never);
    await agents[0].handlers.call_failed(fakeCall('CA1', 'outbound', 'no-answer'), 'no-answer');
    expect(store.get('CA1')).toMatchObject({ status: 'ended', endedStatus: 'no-answer', durationSec: 42 });
    expect(released).toEqual(['U0REQ']);
    expect(await svc.dial(request({ rid: 'zzz999yyy888' }) as never)).toMatchObject({ ok: true });
    await svc.stop();
  });

  it('inbound: busy while a call is up; else a record and run for the owner, and a notice when it ends', async () => {
    const { svc, agents, store, notices } = make();
    await svc.start();
    const rejected: string[] = [];
    const incoming = (id: string): IncomingCallLike => ({
      callId: id,
      fromNumber: '01099998888',
      toNumber: '07012345678',
      callerIdRestricted: false,
      reject: async (o) => {
        rejected.push(`${id}:${o?.reason}`);
      },
    });
    await agents[0].incoming?.(incoming('IN1'));
    expect(rejected).toEqual([]);
    expect(store.get('IN1')).toMatchObject({ direction: 'inbound', requester: 'U0OWNER', peerNumber: '01099998888' });
    await agents[0].incoming?.(incoming('IN2'));
    expect(rejected).toEqual(['IN2:busy']);
    store.update('IN1', (r) => r.transcript.push({ role: 'peer', text: '여보세요', at: 1 }));
    await agents[0].handlers.call_end(fakeCall('IN1', 'inbound', 'completed'));
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe('U0OWNER');
    expect(notices[0][1]).toContain('010-9999-8888에서 온 전화');
    expect(notices[0][1]).toContain('https://soma.example/dashboard?phoneCall=IN1');
    await svc.stop();
  });

  it('follows the configuration: a key put in place later opens the line; a removed section closes it', async () => {
    let key = '';
    let section: Record<string, unknown> = serverTools();
    const { svc, agents } = make(
      () => section,
      () => key,
    );
    await svc.start();
    expect(svc.environments).toEqual([]);
    await svc.sync();
    expect(agents).toHaveLength(0); // still no key: retried, never half-open
    key = 'sk_later';
    await svc.sync();
    expect(svc.environments).toEqual(['2lab-ai-dev']);
    expect(agents[0].options.apiKey).toBe('sk_later');
    section = { other: {} };
    await svc.sync();
    expect(svc.environments).toEqual([]);
    expect(agents[0].connected).toBe(false);
    await svc.stop();
  });

  it('a changed section reopens the line — but never under a call', async () => {
    let section: Record<string, unknown> = serverTools();
    const { svc, agents } = make(() => section);
    await svc.start();
    await svc.dial(request() as never);
    section = serverTools({ model: 'opus' });
    await svc.sync();
    expect(agents).toHaveLength(1); // busy: kept
    await agents[0].handlers.call_end(fakeCall('CA1', 'outbound', 'completed'));
    await svc.sync();
    expect(agents).toHaveLength(2);
    expect(agents[0].connected).toBe(false);
    expect(agents[1].connected).toBe(true);
    await svc.stop();
  });

  it('inbound off: rejects', async () => {
    const { svc, agents } = make(serverTools({ inbound: { enabled: false } }));
    await svc.start();
    const reasons: string[] = [];
    await agents[0].incoming?.({
      callId: 'X',
      fromNumber: '01000000000',
      toNumber: '07012345678',
      callerIdRestricted: false,
      reject: async (o) => {
        reasons.push(String(o?.reason));
      },
    });
    expect(reasons).toEqual(['rejected']);
    await svc.stop();
  });
});
