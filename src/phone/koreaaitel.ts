/**
 * The narrow slice of the 한국AI통신 (koreaaitel, formerly ClawOps) Voice Agent SDK that soma-work uses.
 *
 * The package is loaded with `require('@koreaaitel/sdk/agent')`: its `exports` map has a `require` condition, so
 * the CommonJS daemon loads it at runtime, but `moduleResolution: node` cannot see the sub-path's types. These
 * interfaces describe only what `phone-service.ts` and `voice-session.ts` call, so tests can hand in fakes.
 * Source of truth for the shapes: `@koreaaitel/sdk` 0.62.3 `dist/agent/index.d.ts` (.prd/research/2026-11-17-koreaaitel-phone.md §3).
 */

/** One call's handle (SDK `CallSession`). */
export interface CallSessionLike {
  readonly callId: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly direction: string; // 'inbound' | 'outbound'
  readonly status: string; // 'ringing' | 'active' | 'ended'
  readonly endedStatus: string | null;
  readonly endedDuration: number | null;
  /** G.711 μ-law, 8 kHz mono — 160-byte (20 ms) frames. */
  sendAudio(ulaw: Buffer): void;
  clearAudio(): void;
  hangup(): Promise<void>;
  sendDtmfSequence?(digits: string): Promise<void>;
  wait(): Promise<void>;
  /** SDK internal event emitter — `transcript` reaches `agent.on('transcript')` handlers. */
  _emit?(event: string, ...args: unknown[]): void;
}

/** A call that has not been answered yet (SDK `IncomingCall`). */
export interface IncomingCallLike {
  readonly callId: string;
  readonly fromNumber: string;
  readonly toNumber: string;
  readonly callerIdRestricted: boolean;
  reject(opts?: { reason?: 'rejected' | 'busy' }): Promise<void>;
}

/** The session slot the SDK drives (SDK `Session`). One object serves every call of an agent. */
export interface SessionLike {
  start(callSession: CallSessionLike, tools?: unknown): Promise<void>;
  prewarm(tools?: unknown): Promise<void>;
  attach(callSession: CallSessionLike): Promise<void>;
  feedAudio(audio: Buffer, timestamp?: number): void;
  feedDtmf?(digits: string): Promise<void>;
  stop(): Promise<void>;
  setLogger?(logger: unknown): void;
}

export interface AgentLike {
  on(
    event: 'call_start' | 'call_end' | 'call_failed' | 'transcript' | 'dtmf',
    handler: (...args: any[]) => unknown,
  ): this;
  onIncoming(handler: (call: IncomingCallLike) => void | Promise<void>): this;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  call(to: string, options?: { timeout?: number }): Promise<CallSessionLike>;
}

export interface AgentOptions {
  apiKey: string;
  accountId: string;
  from: string;
  session: SessionLike;
  /** `[]` — the session runs its own tools; the SDK's built-in schemas are not offered to anyone. */
  builtinTools?: string[];
  prewarmEnabled?: boolean;
  logger?: unknown;
}

export interface KoreaAiTelSdk {
  createAgent(options: AgentOptions): AgentLike;
  ulawToPcm16(ulaw: Buffer): Buffer;
  pcm16ToUlaw(pcm: Buffer): Buffer;
}

let loaded: KoreaAiTelSdk | undefined;

/** The real SDK, loaded on first use (the daemon only pays for it when a phone environment is configured). */
export function loadKoreaAiTelSdk(): KoreaAiTelSdk {
  if (loaded) return loaded;
  // biome-ignore lint/style/noCommonJs: sub-path types are invisible to moduleResolution node; see the header.
  const mod = require('@koreaaitel/sdk/agent') as {
    ClawOpsAgent: new (options: Record<string, unknown>) => AgentLike;
    ulawToPcm16: (b: Buffer) => Buffer;
    pcm16ToUlaw: (b: Buffer) => Buffer;
  };
  loaded = {
    createAgent: (options) => new mod.ClawOpsAgent({ ...options }),
    ulawToPcm16: (b) => mod.ulawToPcm16(b),
    pcm16ToUlaw: (b) => mod.pcm16ToUlaw(b),
  };
  return loaded;
}
