/**
 * PhoneService — the daemon side of the phone (.prd/31-phone-calls-architecture.md §1–§3).
 *
 * The platform keeps one control connection per number and a new one cuts the old (.prd/30 D1), so the daemon
 * holds it: one `ClawOpsAgent` per server-tools environment with a `phone` section. server-tools asks for a call
 * by writing `<phone dir>/requests/<rid>.json`; this service claims the file, dials, and answers in
 * `<rid>.result.json`. Every call is a {@link CallRun} (voice-session.ts) and a record in the {@link PhoneCallStore}.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isRequestId,
  type PhoneCallRequest,
  type PhoneCallRequestResult,
  PhoneConfigError,
  type PhoneEnvConfig,
  parsePhoneRequest,
  parsePhoneSection,
  phoneRequestsDir,
  writeJsonFileAtomic,
} from '@soma/common/phone';
import type { VoiceDialog, VoiceDialogTool } from '../agent-runtime/voice-dialog';
import { LINE_SAMPLE_RATE, StreamResampler } from './audio';
import type { PhoneCallRecord, PhoneCallStore } from './call-store';
import type { AgentLike, CallSessionLike, IncomingCallLike, KoreaAiTelSdk } from './koreaaitel';
import { buildCallSystemPrompt, formatPhoneNumber, greetedNote } from './phone-prompt';
import { createVoiceClient, type VoiceClient } from './voice-client';
import { CallRun, OPENER, PhoneVoiceSession } from './voice-session';

const REQUEST_POLL_MS = 1000;
/** How often the configuration is read again (a line added, changed, removed, or its secret put in place). */
export const CONFIG_SYNC_MS = 30_000;
const DIAL_TIMEOUT_S = 45;
/**
 * An outbound call still not answered this long after the dial is ended here: the platform's final event can be
 * lost (it races the dial's response, or arrives while the control connection reconnects) and is never resent.
 */
const DIAL_WATCHDOG_MS = (DIAL_TIMEOUT_S + 30) * 1000;
/**
 * An accepted inbound call holds the line until the SDK starts it. A caller who hangs up during screening is never
 * started (and gets no end event), so the hold lapses after this.
 */
const INBOUND_HOLD_MS = 10_000;
/** The SDK's connect() retries forever on network errors and 5xx; a line that is not up by then is retried later. */
const CONNECT_TIMEOUT_MS = 15_000;

export interface DialogAuth {
  env: Record<string, string | undefined>;
  model: string;
  effort?: string;
  release(): Promise<void>;
}

export interface PhoneServiceDeps {
  sdk: KoreaAiTelSdk;
  store: PhoneCallStore;
  phoneDir: string;
  /** The raw `server-tools` section of config.json (env vars substituted, secrets NOT resolved). */
  readServerTools(): Record<string, unknown> | null;
  /** Resolve `{"$secret"}` references (the bot process may read the secret store; models may not). */
  resolveSecrets<T>(value: T): T;
  /** Auth and model for one call's dialog — the same `query()` path every soma-work model call takes. */
  dialogAuth(input: { requester?: string; model?: string }): Promise<DialogAuth>;
  openDialog(input: {
    model: string;
    systemPrompt: string;
    env: Record<string, string | undefined>;
    effort?: string;
    tools: VoiceDialogTool[];
  }): VoiceDialog;
  /** One-shot summary of a finished call (may return null). */
  summarize?(record: PhoneCallRecord): Promise<string | null>;
  /** Tell a Slack user about an inbound call that ended. */
  notifyOwner?(userId: string, text: string): Promise<void>;
  /** The dashboard's public base URL, for links in notices. */
  dashboardUrl?(): string | undefined;
  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void;
  voiceClientFor?(cfg: PhoneEnvConfig): VoiceClient;
  /** Timers (tests fire them by hand). */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  connectTimeoutMs?: number;
}

interface PhoneLine {
  env: string;
  cfg: PhoneEnvConfig;
  agent: AgentLike;
  session: PhoneVoiceSession;
  voice: VoiceClient;
  greeting?: { text: string; frames: Buffer[] };
  /** Phrases synthesized when the line opens (the reply opener "네."), said without waiting for the engine. */
  phrases: Map<string, Buffer[]>;
  /** Lease of each call's dialog, released when the call ends. */
  auths: Map<string, DialogAuth>;
  /**
   * Calls being set up that have no run yet (an outbound dial waiting for auth or the platform; an inbound call
   * accepted but not yet started). Taken synchronously, before the first await: the line takes one call at a time.
   */
  pending: number;
  /** Accepted inbound calls not yet started by the SDK, with the timer that lets the hold lapse. */
  holds: Map<string, unknown>;
  /** Outbound calls not yet answered, with their watchdog. */
  watchdogs: Map<string, unknown>;
}

export class PhoneService {
  private readonly lines = new Map<string, PhoneLine>();
  private poll: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private configPoll: NodeJS.Timeout | null = null;
  private scanning = false;
  private syncing = false;
  private stopped = false;
  /** The `phone` section (JSON) each open line was opened with, and the last one that failed to open. */
  private readonly openedWith = new Map<string, string>();
  private readonly failedWith = new Map<string, string>();
  /** Calls already finished: the SDK can report one call's end twice (call_failed and call_end). */
  private readonly finished = new Set<string>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: PhoneServiceDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** The line has a call up or being set up. */
  private busy(line: PhoneLine): boolean {
    return line.session.busy || line.pending > 0;
  }

  /** Environments with a working phone line. */
  get environments(): string[] {
    return [...this.lines.keys()];
  }

  /**
   * Open every configured line and start watching for requests, then keep following the configuration: a `phone`
   * section added, changed or removed (or its secret put in place later) opens, reopens or closes its line within
   * {@link CONFIG_SYNC_MS} — no restart. Lines that fail are logged (once per section) and retried.
   */
  async start(): Promise<void> {
    // Calls a restart cut off get no end event: close them before any line opens.
    const closed = this.deps.store.endUnfinished('interrupted');
    if (closed) this.deps.log('info', 'phone: closed calls cut off by a restart', { count: closed });
    await this.sync();
    const dir = phoneRequestsDir(this.deps.phoneDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      this.watcher = fs.watch(dir, () => void this.scan());
    } catch (err) {
      this.deps.log('warn', 'phone request watch unavailable — polling only', { error: (err as Error).message });
    }
    this.poll = setInterval(() => void this.scan(), REQUEST_POLL_MS);
    this.poll.unref?.();
    this.configPoll = setInterval(() => void this.sync(), CONFIG_SYNC_MS);
    this.configPoll.unref?.();
    void this.scan();
  }

  /** Bring the open lines in line with the configuration. Never throws. */
  async sync(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      const wanted = new Map<string, string>();
      const section = this.deps.readServerTools() ?? {};
      for (const [env, server] of Object.entries(section)) {
        if (env === 'permission' || !server || typeof server !== 'object') continue;
        const phone = (server as { phone?: unknown }).phone;
        if (phone !== undefined) wanted.set(env, JSON.stringify(phone));
      }
      // Removed or changed: close (a line in a call waits for the next pass).
      for (const [env, line] of [...this.lines]) {
        if (wanted.get(env) === this.openedWith.get(env)) continue;
        if (this.busy(line)) continue;
        await this.closeLine(env, line);
      }
      for (const [env, json] of wanted) {
        if (this.lines.has(env)) continue;
        try {
          await this.openLine(env, JSON.parse(json));
          this.openedWith.set(env, json);
          this.failedWith.delete(env);
        } catch (err: unknown) {
          if (this.failedWith.get(env) === json) continue; // said once already
          this.failedWith.set(env, json);
          const msg =
            err instanceof PhoneConfigError ? err.message : `phone line ${env} not opened: ${(err as Error).message}`;
          this.deps.log('warn', `${msg} — retrying every ${CONFIG_SYNC_MS / 1000} s`);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async closeLine(env: string, line: PhoneLine): Promise<void> {
    this.lines.delete(env);
    this.openedWith.delete(env);
    try {
      await line.agent.disconnect();
    } catch {
      // The line is dropped either way.
    }
    for (const auth of line.auths.values()) await auth.release().catch(() => undefined);
    this.deps.log('info', `phone: ${env} closed (configuration changed)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    if (this.configPoll) clearInterval(this.configPoll);
    this.watcher?.close();
    const now = Date.now();
    for (const line of this.lines.values()) {
      // Calls still up end here, on disk, before the process goes: their end event would come too late.
      for (const callId of line.session.callIds) {
        this.finished.add(callId);
        this.deps.store.update(callId, (r) => {
          if (r.status === 'ended') return;
          r.status = 'ended';
          r.endedStatus = 'interrupted';
          r.endedAt = now;
          r.durationSec = r.answeredAt ? Math.round((now - r.answeredAt) / 1000) : 0;
          r.work.push({ kind: 'event', at: now, text: '통화 끝 (interrupted)' });
        });
        line.session.end(callId);
      }
      for (const t of [...line.holds.values(), ...line.watchdogs.values()]) this.clearTimer(t);
      try {
        await line.agent.disconnect();
      } catch {
        // Shutting down: a line that does not close cleanly is dropped either way.
      }
      for (const auth of line.auths.values()) await auth.release().catch(() => undefined);
    }
    this.deps.store.flushAll();
  }

  private async openLine(env: string, raw: unknown): Promise<void> {
    const parsed = parsePhoneSection(env, raw);
    const cfg = { ...parsed, apiKey: this.deps.resolveSecrets(parsed.apiKey) };
    if (typeof cfg.apiKey !== 'string' || !cfg.apiKey)
      throw new PhoneConfigError(`server ${env}: phone.apiKey did not resolve`);
    const voice = this.deps.voiceClientFor?.(cfg) ?? createVoiceClient(cfg.voice);
    const line: PhoneLine = {
      env,
      cfg,
      voice,
      auths: new Map(),
      pending: 0,
      holds: new Map(),
      watchdogs: new Map(),
      session: undefined as unknown as PhoneVoiceSession,
      agent: undefined as unknown as AgentLike,
      phrases: new Map(),
    };
    line.session = new PhoneVoiceSession((call) => this.inboundRun(line, call));
    line.agent = this.deps.sdk.createAgent({
      apiKey: cfg.apiKey,
      accountId: cfg.accountId,
      from: cfg.number,
      session: line.session,
      builtinTools: [],
      prewarmEnabled: false,
    });
    line.agent.onIncoming((call) => this.screenIncoming(line, call));
    line.agent.on('call_end', (call: CallSessionLike) => this.finish(line, call, call.endedStatus ?? 'completed'));
    line.agent.on('call_failed', (call: CallSessionLike, reason: string) =>
      this.finish(line, call, reason || 'failed'),
    );
    await this.connect(line);
    this.lines.set(env, line);
    this.deps.log('info', `phone: ${env} connected`, { number: formatPhoneNumber(cfg.number) });
    void (async () => {
      if (cfg.inbound.enabled) await this.prepareGreeting(line);
      await this.preparePhrases(line);
    })();
  }

  /** connect(), bounded: past the limit the attempt is dropped (its reconnect loop stopped) and sync() retries. */
  private async connect(line: PhoneLine): Promise<void> {
    const limit = this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    let timer: unknown;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limit);
    });
    try {
      const outcome = await Promise.race([line.agent.connect().then(() => 'up' as const), timedOut]);
      if (outcome === 'timeout') {
        await line.agent.disconnect().catch(() => undefined);
        throw new Error(`the phone platform did not answer within ${Math.round(limit / 1000)} s`);
      }
    } finally {
      clearTimeout(timer as NodeJS.Timeout);
    }
  }

  // ── outbound ────────────────────────────────────────────────

  private async scan(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const dir = phoneRequestsDir(this.deps.phoneDir);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const m = /^([a-z0-9]+)\.json$/.exec(name);
        if (!m || !isRequestId(m[1])) continue;
        const rid = m[1];
        const claimed = path.join(dir, `${rid}.claimed.json`);
        try {
          fs.renameSync(path.join(dir, name), claimed);
        } catch {
          continue; // another scan took it
        }
        let request: PhoneCallRequest | null = null;
        try {
          request = parsePhoneRequest(JSON.parse(fs.readFileSync(claimed, 'utf-8')));
        } catch {
          request = null;
        }
        const result = request ? await this.dial(request) : { ok: false, error: 'request file is not valid' };
        writeJsonFileAtomic(path.join(dir, `${rid}.result.json`), result);
        fs.rmSync(claimed, { force: true });
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Place one requested call. Never throws: the answer goes back to server-tools. */
  async dial(req: PhoneCallRequest): Promise<PhoneCallRequestResult> {
    const line = this.lines.get(req.env);
    if (!line) return { ok: false, error: `phone line ${req.env} is not connected` };
    const allow = line.cfg.outbound.allowTo;
    if (allow && !allow.includes(req.to))
      return { ok: false, error: `${formatPhoneNumber(req.to)} is not in ${req.env}'s outbound.allowTo` };
    if (this.busy(line)) return { ok: false, error: `phone line ${req.env} is busy with another call` };
    line.pending++; // taken before the first await: nothing else gets the line while this call is set up
    try {
      return await this.placeCall(line, req);
    } finally {
      line.pending--;
    }
  }

  private async placeCall(line: PhoneLine, req: PhoneCallRequest): Promise<PhoneCallRequestResult> {
    let auth: DialogAuth;
    try {
      auth = await this.deps.dialogAuth({ requester: req.requester, model: line.cfg.model });
    } catch (err) {
      return { ok: false, error: `no model credentials for the call: ${(err as Error).message}` };
    }
    let call: CallSessionLike;
    try {
      call = await line.agent.call(req.to, { timeout: DIAL_TIMEOUT_S });
    } catch (err) {
      await auth.release().catch(() => undefined);
      return { ok: false, error: `dial failed: ${(err as Error).message}` };
    }
    const maxMinutes = Math.min(req.maxMinutes, line.cfg.outbound.maxMinutes);
    const record: PhoneCallRecord = {
      id: call.callId,
      env: req.env,
      direction: 'outbound',
      ourNumber: line.cfg.number,
      peerNumber: req.to,
      title: req.title || `${formatPhoneNumber(req.to)} 통화`,
      purpose: req.purpose,
      ...(req.scenario ? { scenario: req.scenario } : {}),
      status: 'dialing',
      createdAt: Date.now(),
      requester: req.requester,
      ...(req.context?.conversationId ? { conversationId: req.context.conversationId } : {}),
      ...(req.context?.channel ? { channel: req.context.channel } : {}),
      ...(req.context?.threadTs ? { threadTs: req.context.threadTs } : {}),
      model: auth.model,
      voice: line.cfg.voice.voice,
      transcript: [],
      work: [],
    };
    const systemPrompt = buildCallSystemPrompt({
      direction: 'outbound',
      peerNumber: req.to,
      ourNumber: line.cfg.number,
      title: record.title,
      purpose: req.purpose,
      scenario: req.scenario,
      envPrompt: line.cfg.outbound.systemPrompt,
      requester: req.requester,
      maxMinutes,
    });
    record.work.push({ kind: 'instruction', at: record.createdAt, text: systemPrompt });
    this.deps.store.create(record);
    line.auths.set(call.callId, auth);
    const run = this.makeRun(line, call.callId, 'outbound', maxMinutes, systemPrompt, auth);
    line.session.register(run);
    run.begin();
    line.watchdogs.set(
      call.callId,
      this.setTimer(() => {
        line.watchdogs.delete(call.callId);
        if (this.deps.store.get(call.callId)?.status !== 'dialing') return;
        this.deps.log('warn', 'phone: no final event for an unanswered call — ending it', { callId: call.callId });
        void call.hangup().catch(() => undefined);
        void this.finish(line, call, 'no-answer');
      }, DIAL_WATCHDOG_MS),
    );
    this.deps.log('info', 'phone: dialing', { env: req.env, callId: call.callId });
    return { ok: true, callId: call.callId };
  }

  private makeRun(
    line: PhoneLine,
    callId: string,
    direction: 'outbound' | 'inbound',
    maxMinutes: number,
    systemPrompt: string,
    auth: DialogAuth,
    greeting?: { text: string; frames: Buffer[] },
  ): CallRun {
    return new CallRun(
      { callId, direction, maxMinutes, greeting, phrases: line.phrases, model: auth.model },
      {
        ulawToPcm16: (b) => this.deps.sdk.ulawToPcm16(b),
        pcm16ToUlaw: (b) => this.deps.sdk.pcm16ToUlaw(b),
        voice: line.voice,
        openDialog: (tools) =>
          this.deps.openDialog({ model: auth.model, systemPrompt, env: auth.env, effort: auth.effort, tools }),
        update: (mutate) => {
          this.deps.store.update(callId, mutate);
        },
        log: (level, message, data) => this.deps.log(level, message, data),
      },
    );
  }

  // ── inbound ─────────────────────────────────────────────────

  /**
   * The SDK's screening hook: decide at once — it runs inside a 5 s window, and a caller who hangs up meanwhile is
   * never started. An accepted call only holds the line; its run is made when the SDK starts it ({@link inboundRun}).
   */
  private async screenIncoming(line: PhoneLine, call: IncomingCallLike): Promise<void> {
    if (!line.cfg.inbound.enabled) return call.reject({ reason: 'rejected' });
    if (this.busy(line)) return call.reject({ reason: 'busy' });
    line.pending++;
    line.holds.set(
      call.callId,
      this.setTimer(() => this.releaseHold(line, call.callId), INBOUND_HOLD_MS),
    );
  }

  /** Give back an accepted call's hold on the line. True when it was still held. */
  private releaseHold(line: PhoneLine, callId: string): boolean {
    const timer = line.holds.get(callId);
    if (timer === undefined) return false;
    this.clearTimer(timer);
    line.holds.delete(callId);
    line.pending--;
    return true;
  }

  /** The SDK started a call with no run: an accepted inbound call gets its run now; anything else is put down. */
  private async inboundRun(line: PhoneLine, call: CallSessionLike): Promise<CallRun | null> {
    if (call.direction !== 'inbound' || !line.cfg.inbound.enabled) {
      this.deps.log('warn', 'phone: call started without a prepared run', { callId: call.callId });
      return null;
    }
    const held = this.releaseHold(line, call.callId);
    // The hold lapsed and another call took the line meanwhile: this one is put down.
    if (!held && (line.pending > 0 || line.session.callIds.length > 0)) {
      this.deps.log('warn', 'phone: inbound call started after its hold lapsed — line busy', { callId: call.callId });
      return null;
    }
    return this.prepareInbound(line, call.callId, call.fromNumber);
  }

  private async prepareInbound(line: PhoneLine, callId: string, from: string): Promise<CallRun | null> {
    const existing = line.session.runOf(callId);
    if (existing) return existing;
    let auth: DialogAuth;
    try {
      auth = await this.deps.dialogAuth({ requester: line.cfg.owner, model: line.cfg.model });
    } catch (err) {
      this.deps.log('warn', 'phone: inbound call refused — no model credentials', { error: (err as Error).message });
      return null;
    }
    if (this.finished.has(callId)) {
      await auth.release().catch(() => undefined); // the caller hung up while the run was being made
      return null;
    }
    // Only a greeting made earlier: synthesizing now would keep the caller waiting in silence.
    const greeting = line.greeting;
    const systemPrompt = buildCallSystemPrompt({
      direction: 'inbound',
      peerNumber: from,
      ourNumber: line.cfg.number,
      scenario: line.cfg.inbound.scenario,
      envPrompt: [line.cfg.inbound.systemPrompt, greetedNote(line.cfg.inbound.greeting)].filter(Boolean).join('\n'),
      requester: line.cfg.owner,
      maxMinutes: line.cfg.outbound.maxMinutes,
    });
    const now = Date.now();
    this.deps.store.create({
      id: callId,
      env: line.env,
      direction: 'inbound',
      ourNumber: line.cfg.number,
      peerNumber: from,
      title: `${formatPhoneNumber(from)}에서 온 전화`,
      status: 'dialing',
      createdAt: now,
      ...(line.cfg.owner ? { requester: line.cfg.owner } : {}),
      model: auth.model,
      voice: line.cfg.voice.voice,
      transcript: [],
      work: [{ kind: 'instruction', at: now, text: systemPrompt }],
    });
    line.auths.set(callId, auth);
    const run = this.makeRun(
      line,
      callId,
      'inbound',
      line.cfg.outbound.maxMinutes,
      systemPrompt,
      auth,
      greeting ?? undefined,
    );
    run.begin();
    return run;
  }

  /** Synthesize `text` whole, as μ-law frames for the line. */
  private async synthFrames(line: PhoneLine, text: string): Promise<Buffer[]> {
    const stream = await line.voice.speak(text);
    const rs = new StreamResampler(stream.sampleRate, LINE_SAMPLE_RATE);
    const parts: Buffer[] = [];
    for await (const chunk of stream.chunks) parts.push(this.deps.sdk.pcm16ToUlaw(rs.push(chunk)));
    const ulaw = Buffer.concat(parts);
    const frames: Buffer[] = [];
    for (let off = 0; off < ulaw.length; off += 160) {
      const f = ulaw.subarray(off, off + 160);
      frames.push(f.length === 160 ? Buffer.from(f) : Buffer.concat([f, Buffer.alloc(160 - f.length, 0xff)]));
    }
    return frames;
  }

  /** The reply opener, made once per line: a reply that starts with "네," is heard ~0.8 s sooner. Best effort. */
  private async preparePhrases(line: PhoneLine): Promise<void> {
    try {
      line.phrases.set(OPENER, await this.synthFrames(line, OPENER));
    } catch (err) {
      this.deps.log('warn', 'phone: opener not synthesized', { env: line.env, error: (err as Error).message });
    }
  }

  /** Synthesize the inbound greeting once (μ-law frames), so a caller hears it the moment the line opens. */
  private async prepareGreeting(line: PhoneLine): Promise<{ text: string; frames: Buffer[] } | undefined> {
    const text = line.cfg.inbound.greeting;
    try {
      line.greeting = { text, frames: await this.synthFrames(line, text) };
      return line.greeting;
    } catch (err) {
      this.deps.log('warn', 'phone: inbound greeting not synthesized', {
        env: line.env,
        error: (err as Error).message,
      });
      return undefined;
    }
  }

  // ── ending ──────────────────────────────────────────────────

  private async finish(line: PhoneLine, call: CallSessionLike, endedStatus: string): Promise<void> {
    // The clean-up runs on every end event (it is idempotent): a run set up after the first one — an inbound call
    // ended while its run was being made — still has its lease given back by the second.
    const first = !this.finished.has(call.callId);
    this.finished.add(call.callId);
    if (this.finished.size > 1000) this.finished.delete(this.finished.values().next().value as string);
    const watchdog = line.watchdogs.get(call.callId);
    if (watchdog !== undefined) this.clearTimer(watchdog);
    line.watchdogs.delete(call.callId);
    this.releaseHold(line, call.callId);
    line.session.end(call.callId);
    const auth = line.auths.get(call.callId);
    line.auths.delete(call.callId);
    if (auth) await auth.release().catch(() => undefined);
    if (!first) return; // the record, the summary and the owner's notice: once per call
    const now = Date.now();
    if (this.deps.store.get(call.callId)?.status === 'ended') return;
    const record = this.deps.store.update(call.callId, (r) => {
      r.status = 'ended';
      r.endedStatus = endedStatus;
      r.endedAt = now;
      const server = typeof call.endedDuration === 'number' ? call.endedDuration : null;
      r.durationSec = server ?? (r.answeredAt ? Math.round((now - r.answeredAt) / 1000) : 0);
      r.work.push({ kind: 'event', at: now, text: `통화 끝 (${endedStatus})` });
    });
    if (!record) return;
    this.deps.log('info', 'phone: call ended', { env: line.env, callId: call.callId, endedStatus });
    if (record.transcript.length && this.deps.summarize) {
      const summary = await this.deps.summarize(record).catch(() => null);
      if (summary) this.deps.store.update(call.callId, (r) => (r.summary = summary));
    }
    if (record.direction === 'inbound' && line.cfg.owner && this.deps.notifyOwner) {
      const base = this.deps.dashboardUrl?.();
      const link = base
        ? `\n<${base.replace(/\/+$/, '')}/dashboard?phoneCall=${encodeURIComponent(record.id)}|통화 보기>`
        : '';
      const mins = Math.floor((record.durationSec ?? 0) / 60);
      const secs = String((record.durationSec ?? 0) % 60).padStart(2, '0');
      const text = `📞 ${formatPhoneNumber(record.peerNumber)}에서 온 전화 (${mins}:${secs}, ${endedStatus})\n${
        record.summary ??
        record.transcript
          .slice(-4)
          .map((l) => `${l.role === 'peer' ? '상대' : '에이전트'}: ${l.text}`)
          .join('\n')
      }${link}`;
      await this.deps
        .notifyOwner(line.cfg.owner, text)
        .catch((err) => this.deps.log('warn', 'phone: owner notice failed', { error: (err as Error).message }));
    }
  }
}
