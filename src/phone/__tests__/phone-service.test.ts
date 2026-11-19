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
import { BUSY_NOTICE } from '../phone-prompt';
import { PhoneService, type PhoneServiceDeps } from '../phone-service';
import type { VoiceClient, VoiceHostClaim } from '../voice-client';

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
  disconnects = 0;
  dialed: string[] = [];
  /** The platform does not answer: connect() never settles (the SDK retries forever). */
  static hang = false;
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
    if (FakeAgent.hang) return new Promise<void>(() => undefined);
    this.connected = true;
  }
  async disconnect() {
    this.disconnects++;
    this.connected = false;
  }
  /** The SDK starting a call's media: the session object the agent was made with. */
  start(call: CallSessionLike) {
    return (this.options.session as unknown as { start(c: CallSessionLike): Promise<void> }).start(call);
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

/** A manual clock for the service's timers: advance(ms) fires exactly the timers whose deadline has come. */
class Timers {
  now = 0;
  pending: { fn: () => void; at: number; id: number }[] = [];
  private seq = 0;
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.pending.push({ fn, at: this.now + ms, id });
    return id;
  };
  clear = (id: unknown) => {
    this.pending = this.pending.filter((t) => t.id !== id);
  };
  advance(ms: number) {
    this.now += ms;
    const due = this.pending.filter((t) => t.at <= this.now);
    this.pending = this.pending.filter((t) => t.at > this.now);
    for (const t of due) t.fn();
  }
}

function make(
  section: Record<string, unknown> | (() => Record<string, unknown>) = serverTools(),
  secret = () => 'sk_test',
  over: Partial<PhoneServiceDeps> = {},
) {
  const timers = new Timers();
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
    setTimer: timers.set,
    clearTimer: timers.clear,
    connectTimeoutMs: 30,
    ...over,
  };
  return { svc: new PhoneService(deps), agents, dialogs, notices, released, store, timers };
}

const incoming = (id: string, rejected: string[]): IncomingCallLike => ({
  callId: id,
  fromNumber: '01099998888',
  toNumber: '07012345678',
  callerIdRestricted: false,
  reject: async (o) => {
    rejected.push(`${id}:${o?.reason}`);
  },
});

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

  it('inbound: the hook only screens; the call is set up when the SDK starts it, for the owner, with a notice at the end', async () => {
    const { svc, agents, store, notices } = make();
    await svc.start();
    const rejected: string[] = [];
    await agents[0].incoming?.(incoming('IN1', rejected));
    expect(rejected).toEqual([]);
    expect(store.get('IN1')).toBeUndefined(); // nothing slow inside the SDK's 5 s screening window
    await agents[0].incoming?.(incoming('IN2', rejected));
    expect(rejected).toEqual(['IN2:busy']); // the line is held for IN1
    await agents[0].start(fakeCall('IN1', 'inbound'));
    expect(store.get('IN1')).toMatchObject({ direction: 'inbound', requester: 'U0OWNER', peerNumber: '01099998888' });
    store.update('IN1', (r) => r.transcript.push({ role: 'peer', text: '여보세요', at: 1 }));
    await agents[0].handlers.call_end(fakeCall('IN1', 'inbound', 'completed'));
    expect(notices).toHaveLength(1);
    expect(notices[0][0]).toBe('U0OWNER');
    expect(notices[0][1]).toContain('010-9999-8888에서 온 전화');
    expect(notices[0][1]).toContain('https://soma.example/dashboard?phoneCall=IN1');
    await svc.stop();
  });

  it('a caller who hangs up while being screened does not keep the line', async () => {
    const { svc, agents, timers } = make();
    await svc.start();
    await agents[0].incoming?.(incoming('IN1', []));
    expect(await svc.dial(request() as never)).toMatchObject({ ok: false, error: expect.stringContaining('busy') });
    // The SDK never starts IN1 (it ended during screening): the hold lapses after 10 s, not before.
    timers.advance(9_999);
    expect(await svc.dial(request() as never)).toMatchObject({ ok: false, error: expect.stringContaining('busy') });
    timers.advance(1);
    expect(await svc.dial(request() as never)).toMatchObject({ ok: true });
    await svc.stop();
  });

  it('one call at a time, also while the first is still being set up', async () => {
    let letAuthGo!: () => void;
    const authGate = new Promise<void>((r) => {
      letAuthGo = r;
    });
    const { svc, agents } = make(serverTools(), undefined, {
      dialogAuth: async ({ requester }) => {
        await authGate;
        return { env: {}, model: `m-${requester}`, release: async () => undefined };
      },
    });
    await svc.start();
    const first = svc.dial(request() as never);
    const rejected: string[] = [];
    await agents[0].incoming?.(incoming('IN9', rejected)); // arrives while the outbound call waits for auth
    const second = await svc.dial(request({ rid: 'zzz999yyy888' }) as never);
    letAuthGo();
    expect(await first).toMatchObject({ ok: true });
    expect(rejected).toEqual(['IN9:busy']);
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining('busy') });
    expect(agents[0].dialed).toHaveLength(1);
    await svc.stop();
  });

  it('an outbound call that never gets a final event is ended by a watchdog', async () => {
    const { svc, store, released, timers } = make();
    await svc.start();
    await svc.dial(request() as never);
    // 45 s of ringing + 30 s of grace for the platform's own final event, then the watchdog — not before.
    timers.advance(74_999);
    expect(store.get('CA1')?.status).toBe('dialing');
    timers.advance(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get('CA1')).toMatchObject({ status: 'ended', endedStatus: 'no-answer' });
    expect(released).toEqual(['U0REQ']);
    expect(await svc.dial(request({ rid: 'zzz999yyy888' }) as never)).toMatchObject({ ok: true });
    await svc.stop();
  });

  it('a call ends once: call_failed then call_end for the same call give one summary and one notice', async () => {
    let summaries = 0;
    const { svc, agents, store, notices } = make(serverTools(), undefined, {
      summarize: async () => {
        summaries++;
        return '요약';
      },
    });
    await svc.start();
    await agents[0].incoming?.(incoming('IN1', []));
    await agents[0].start(fakeCall('IN1', 'inbound'));
    store.update('IN1', (r) => r.transcript.push({ role: 'peer', text: '네', at: 1 }));
    await Promise.all([
      agents[0].handlers.call_failed(fakeCall('IN1', 'inbound', 'failed'), 'failed'),
      agents[0].handlers.call_end(fakeCall('IN1', 'inbound', 'failed')),
    ]);
    expect(summaries).toBe(1);
    expect(notices).toHaveLength(1);
    await svc.stop();
  });

  it('an inbound call that ends while its run is being made gives its lease back', async () => {
    let letAuthGo!: () => void;
    const authGate = new Promise<void>((r) => {
      letAuthGo = r;
    });
    const leases: string[] = [];
    const { svc, agents } = make(serverTools(), undefined, {
      dialogAuth: async () => {
        await authGate;
        leases.push('taken');
        return { env: {}, model: 'm', release: async () => void leases.push('released') };
      },
    });
    await svc.start();
    await agents[0].incoming?.(incoming('IN1', []));
    const starting = agents[0].start(fakeCall('IN1', 'inbound'));
    await agents[0].handlers.call_failed(fakeCall('IN1', 'inbound', 'canceled'), 'canceled');
    letAuthGo();
    await starting;
    expect(leases).toEqual(['taken', 'released']);
    expect(await svc.dial(request() as never)).toMatchObject({ ok: true }); // the line is free
    await svc.stop();
  });

  it('a restart closes the calls it cut off, and stop() closes the live ones', async () => {
    const before = new PhoneCallStore(dir);
    before.create({
      id: 'OLD1',
      env: '2lab-ai-dev',
      direction: 'outbound',
      ourNumber: '07012345678',
      peerNumber: '01011112222',
      title: 't',
      status: 'active',
      createdAt: 1,
      transcript: [],
      work: [],
    });
    const { svc, store } = make();
    await svc.start();
    expect(store.get('OLD1')).toMatchObject({ status: 'ended', endedStatus: 'interrupted' });
    await svc.dial(request() as never);
    await svc.stop();
    expect(new PhoneCallStore(dir).get('CA1')).toMatchObject({ status: 'ended', endedStatus: 'interrupted' });
  });

  it('a platform that does not answer: start() returns, the attempt is dropped, the line is retried later', async () => {
    FakeAgent.hang = true;
    try {
      const { svc, agents } = make();
      await svc.start();
      expect(svc.environments).toEqual([]);
      expect(agents[0].disconnects).toBe(1); // the SDK's reconnect loop is stopped
      FakeAgent.hang = false;
      await svc.sync();
      expect(svc.environments).toEqual(['2lab-ai-dev']);
      await svc.stop();
    } finally {
      FakeAgent.hang = false;
    }
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

  describe('one job at a time on the voice host', () => {
    const settleAll = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };
    /** 0.3 s of a 300 Hz tone at 8 kHz (the test codec is identity: PCM16 goes in as if it were μ-law). */
    const tone = (ms: number, amp: number) => {
      const n = (8000 * ms) / 1000;
      const b = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++)
        b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / 8000) * amp * 32767), i * 2);
      return b;
    };
    /** A voice host that answers claims with `answer()`; `log` says which client did what. */
    function voiceHost(answer: () => VoiceHostClaim['kind'], opts: { speakFails?: () => boolean } = {}) {
      const log: string[] = [];
      const client = (tag: string): VoiceClient => ({
        transcribe: async () => {
          log.push(`${tag} transcribe`);
          return { text: '네', ms: 1 };
        },
        speak: async (text) => {
          if (opts.speakFails?.()) throw new Error('text-to-speech answered 409');
          log.push(`${tag} speak ${text}`);
          return {
            sampleRate: 8000,
            headersMs: 0,
            chunks: (async function* () {
              yield Buffer.alloc(3200); // identity codec: 20 frames of 160 B
            })(),
          };
        },
      });
      const voice: VoiceClient = {
        ...client('line'),
        claim: async (owner) => {
          log.push(`claim ${owner}`);
          const kind = answer();
          if (kind === 'busy') return { kind, reason: 'busy with voicechat' };
          if (kind === 'shared') return { kind };
          return {
            kind,
            voice: client('leased'),
            renew: async () => {
              log.push('renew');
              return true;
            },
            release: async () => {
              log.push('release');
            },
          };
        },
      };
      return { voice, log };
    }
    function liveCall(callId: string, direction: string) {
      const call = { ...fakeCall(callId, direction), frames: 0, hungUp: 0 };
      call.sendAudio = () => {
        call.frames++;
      };
      call.hangup = async () => {
        call.hungUp++;
      };
      return call;
    }

    it('the line makes the notices while it is idle, with the line client (no lease)', async () => {
      const host = voiceHost(() => 'held');
      const { svc } = make(serverTools(), undefined, { voiceClientFor: () => host.voice });
      await svc.start();
      await settleAll();
      expect(host.log).toEqual(
        expect.arrayContaining([`line speak ${BUSY_NOTICE.outbound}`, `line speak ${BUSY_NOTICE.inbound}`]),
      );
      expect(host.log.some((l) => l.startsWith('claim'))).toBe(false);
      await svc.stop();
    });

    it('a call takes the host: its words go through the lease, renewed every 10 s, given back when it ends', async () => {
      const host = voiceHost(() => 'held');
      const { svc, agents, timers } = make(serverTools(), undefined, { voiceClientFor: () => host.voice });
      await svc.start();
      await settleAll();
      host.log.length = 0;
      await agents[0].incoming?.(incoming('IN1', []));
      await agents[0].start(liveCall('IN1', 'inbound'));
      expect(host.log).toEqual(['claim phone:2lab-ai-dev:inbound']);
      const session = agents[0].options.session as unknown as { feedAudio(b: Buffer): void };
      session.feedAudio(tone(600, 0.3));
      session.feedAudio(tone(700, 0.0005));
      await settleAll();
      expect(host.log).toContain('leased transcribe');
      expect(host.log).not.toContain('line transcribe');
      timers.advance(10_000);
      await settleAll();
      timers.advance(10_000);
      await settleAll();
      expect(host.log.filter((l) => l === 'renew')).toHaveLength(2);
      await agents[0].handlers.call_end(fakeCall('IN1', 'inbound', 'completed'));
      expect(host.log.filter((l) => l === 'release')).toHaveLength(1);
      timers.advance(30_000);
      await settleAll();
      expect(host.log.filter((l) => l === 'renew')).toHaveLength(2); // no renewal after the end
      await svc.stop();
    });

    it('busy on an inbound call: the caller hears the notice, no model is used, the owner is told', async () => {
      let kind: VoiceHostClaim['kind'] = 'held';
      const host = voiceHost(() => kind);
      const auths: string[] = [];
      let summaries = 0;
      const { svc, agents, store, dialogs, notices } = make(serverTools(), undefined, {
        voiceClientFor: () => host.voice,
        dialogAuth: async () => {
          auths.push('taken');
          return { env: {}, model: 'm', release: async () => undefined };
        },
        summarize: async () => {
          summaries++;
          return 'summary';
        },
      });
      await svc.start();
      await settleAll();
      kind = 'busy';
      await agents[0].incoming?.(incoming('IN1', []));
      const call = liveCall('IN1', 'inbound');
      await agents[0].start(call);
      expect(call.frames).toBe(20); // the notice, at once
      const r = store.get('IN1');
      expect(r?.transcript).toMatchObject([{ role: 'agent', text: BUSY_NOTICE.inbound }]);
      expect(r?.work[0]).toMatchObject({ kind: 'event', text: expect.stringContaining('busy with voicechat') });
      expect(auths).toEqual([]);
      expect(dialogs).toHaveLength(0);
      await agents[0].handlers.call_end(fakeCall('IN1', 'inbound', 'completed'));
      expect(notices[0][1]).toContain(BUSY_NOTICE.inbound);
      expect(summaries).toBe(0); // the other side said nothing: nothing to sum up
      expect(host.log).not.toContain('release'); // nothing was held
      await svc.stop();
    });

    it('busy on an outbound call: it is still placed, says only the notice, and the requester is told', async () => {
      let kind: VoiceHostClaim['kind'] = 'held';
      const host = voiceHost(() => kind);
      const { svc, agents, store, dialogs, released } = make(serverTools(), undefined, {
        voiceClientFor: () => host.voice,
      });
      await svc.start();
      await settleAll();
      kind = 'busy';
      const result = await svc.dial(request() as never);
      expect(result).toMatchObject({ ok: true, callId: 'CA1', notice: expect.stringContaining('busy with voicechat') });
      expect(agents[0].dialed).toHaveLength(1);
      expect(dialogs).toHaveLength(0);
      const r = store.get('CA1');
      expect(r?.model).toBeUndefined();
      expect(r?.work[0]).toMatchObject({ kind: 'event', text: expect.stringContaining('안내 음성만') });
      await agents[0].handlers.call_end(fakeCall('CA1', 'outbound', 'completed'));
      expect(released).toEqual([]); // no model credentials were taken
      kind = 'held';
      expect(await svc.dial(request({ rid: 'zzz999yyy888' }) as never)).toMatchObject({ ok: true, callId: 'CA2' });
      expect(store.get('CA2')?.work[0].kind).toBe('instruction');
      await svc.stop();
    });

    it('busy and the notice could not be made: nothing is dialed; the notice is made on a later idle pass', async () => {
      let fails = true;
      const host = voiceHost(() => 'busy', { speakFails: () => fails });
      const { svc, agents } = make(serverTools(), undefined, { voiceClientFor: () => host.voice });
      await svc.start();
      await settleAll();
      expect(await svc.dial(request() as never)).toMatchObject({
        ok: false,
        error: expect.stringContaining('no notice is ready'),
      });
      expect(agents[0].dialed).toHaveLength(0);
      fails = false;
      await svc.sync();
      await settleAll();
      expect(await svc.dial(request({ rid: 'zzz999yyy888' }) as never)).toMatchObject({
        ok: true,
        notice: expect.any(String),
      });
      await svc.stop();
    });

    it('the host is kept from the claim on: renewed while the dialog credentials and the dial are still pending', async () => {
      const host = voiceHost(() => 'held');
      let letAuthGo!: () => void;
      const authGate = new Promise<void>((r) => {
        letAuthGo = r;
      });
      const { svc, timers } = make(serverTools(), undefined, {
        voiceClientFor: () => host.voice,
        dialogAuth: async () => {
          await authGate;
          return { env: {}, model: 'm', release: async () => undefined };
        },
      });
      await svc.start();
      await settleAll();
      const dialing = svc.dial(request() as never);
      await settleAll();
      for (let i = 0; i < 4; i++) {
        timers.advance(10_000); // 40 s of slow setup: past the host's 30 s
        await settleAll();
      }
      expect(host.log.filter((l) => l === 'renew')).toHaveLength(4);
      letAuthGo();
      expect(await dialing).toMatchObject({ ok: true });
      await svc.stop();
      expect(host.log.filter((l) => l === 'release')).toHaveLength(1);
    });

    it('stop() with a call up gives its host back once, and no renewal follows', async () => {
      const host = voiceHost(() => 'held');
      const { svc, timers } = make(serverTools(), undefined, { voiceClientFor: () => host.voice });
      await svc.start();
      await settleAll();
      expect(await svc.dial(request() as never)).toMatchObject({ ok: true });
      await svc.stop(); // no call_end comes: the process is going
      expect(host.log.filter((l) => l === 'release')).toHaveLength(1);
      const renewed = host.log.filter((l) => l === 'renew').length;
      timers.advance(60_000);
      await settleAll();
      expect(host.log.filter((l) => l === 'renew')).toHaveLength(renewed);
    });

    it('a dial that fails gives the host back at once', async () => {
      const host = voiceHost(() => 'held');
      const { svc, agents } = make(serverTools(), undefined, { voiceClientFor: () => host.voice });
      await svc.start();
      await settleAll();
      agents[0].call = async () => {
        throw new Error('422 quota');
      };
      expect(await svc.dial(request() as never)).toMatchObject({ ok: false, error: expect.stringContaining('422') });
      expect(host.log.filter((l) => l === 'release')).toHaveLength(1);
      await svc.stop();
    });
  });
});
