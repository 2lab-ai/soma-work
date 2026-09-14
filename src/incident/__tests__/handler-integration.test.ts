/**
 * Incident attempt, end to end through the REAL `ClaudeHandler.streamQuery`.
 *
 * Every unit on this path is already covered on its own — the option builder,
 * the tool policy, the collector, the registry, the result decoder. What no unit
 * test can show is that they are *wired to each other*: that an incident session
 * reaches the isolated builder with a real evidence config, that the tool the SDK
 * is handed actually records into the registry the validator later reads, and
 * that nothing the model wrote reaches the consumer on any exit path.
 *
 * So this suite drives the real handler and replaces only what must not run in a
 * test: the Claude SDK `query()` call, the CCT lease/auth boundary, and
 * `fetch`. Everything between them is production code —
 * `buildStreamOptions` → `buildIncidentSdkOptions` → the real in-process MCP
 * server → `collectIncidentEvidence` → `createIncidentEvidenceRegistry` →
 * `screenIncidentStream` → `decodeIncidentConclusion`.
 *
 * The fake model is deliberately hostile in the two ways a real one can be: it
 * fabricates the `fact` behind a real evidence reference, and (in the second
 * test) cites a record the host never collected. The host's published line must
 * carry the host's own fact, or reject the conclusion outright.
 *
 * Not covered here (and not fakeable without a real process): the child process
 * spawn, real credentials, and real eagle-eye.
 */

import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  // Hoisted above every import, so no module (`node:path`, `node:os`) is in
  // scope yet — the temp path is assembled from globals only.
  const tmp = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '');
  return {
    /** Swapped per test; stands in for the Claude Agent SDK's `query()`. */
    runQuery: null as null | ((args: { prompt: unknown; options: Record<string, unknown> }) => AsyncIterable<unknown>),
    /** Every options object the SDK was actually handed. */
    seenOptions: [] as Array<Record<string, unknown>>,
    dataDir: `${tmp}/incident-handler-itest-${process.pid}`,
  };
});

vi.mock('../../env-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../env-paths')>()),
  CONFIG_FILE: '/tmp/__nonexistent_incident_handler_itest_config__.json',
  DATA_DIR: harness.dataDir,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  // `createSdkMcpServer` / `tool` stay REAL — the MCP server under test is the
  // one production builds. Only the model call is replaced.
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
    harness.seenOptions.push(args.options);
    if (!harness.runQuery) throw new Error('test did not install a query implementation');
    return harness.runQuery(args);
  },
}));

vi.mock('../../credentials-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../credentials-manager')>()),
  ensureActiveSlotAuth: vi.fn(async () => ({
    heartbeat: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  })),
  getCredentialStatus: vi.fn(() => ({})),
}));

vi.mock('../../auth/query-env-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/query-env-builder')>()),
  buildQueryEnv: vi.fn(() => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-lease-token' } })),
}));

vi.mock('../../auth/llmux-tenant-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/llmux-tenant-keys')>()),
  ensureTenantKey: vi.fn(async () => null),
}));

vi.mock('../../credential-alert', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../credential-alert')>()),
  sendCredentialAlert: vi.fn(async () => undefined),
}));

vi.mock('../../token-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../token-manager')>()),
  getTokenManager: vi.fn(() => ({})),
}));

import { ClaudeHandler } from '../../claude-handler';
import type { McpManager } from '../../mcp-manager';
import type { ConversationSession, SessionIncidentRequest } from '../../types';
import { INCIDENT_EVIDENCE_SERVER_NAME, INCIDENT_EVIDENCE_TOOL, INCIDENT_EVIDENCE_TOOL_NAME } from '../sdk-options';

const EAGLE_ORIGIN = 'https://eagle.internal';
const HOST_ID = 'mac-mini-dev';
const EXPECTED_REF = `eagle:/api/snapshot#hosts[id=${HOST_ID}]`;
/** Only ever written by the fake model. Its presence downstream is a leak. */
const MODEL_ONLY_FACT = 'MODEL-FABRICATED-FACT-the-host-never-observed-this';
const MODEL_PROSE = 'Here is my analysis, which nobody validated yet.';

const REQUEST: SessionIncidentRequest = {
  version: 1,
  incident_id: 'host:mac-mini-dev',
  lifecycle_id: 'lc-itest-1',
  attempt_id: 'att-itest-1',
  channel_id: 'C0EAGLEINC',
  parent_ts: '1757600000.000100',
  env: 'dev2',
  summary: 'mac-mini-dev unreachable',
};

function makeMcpManager(): McpManager {
  return {
    getServerConfiguration: vi.fn(async () => ({})),
    getDefaultAllowedTools: vi.fn(() => []),
    getPluginManager: vi.fn(() => undefined),
  } as unknown as McpManager;
}

function makeSession(over: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ownerId: 'U0INCIDENT1',
    userId: 'U0INCIDENT1',
    channelId: REQUEST.channel_id,
    threadTs: REQUEST.parent_ts,
    isActive: true,
    lastActivity: new Date(),
    model: 'claude-fable-5-1',
    incidentRequest: REQUEST,
    ...over,
  } as ConversationSession;
}

const SLACK_CONTEXT = { user: 'U0INCIDENT1', channel: REQUEST.channel_id, threadTs: REQUEST.parent_ts };

// --------------------------------------------------------------- eagle-eye

/** Canned eagle-eye payloads: one triage issue keyed to one snapshot host row. */
function eagleResponses(observedAt: string): Record<string, unknown> {
  return {
    '/api/triage': {
      generated_at: observedAt,
      issues: [
        {
          id: REQUEST.incident_id,
          cat: 'HOST',
          key: `host:${HOST_ID}`,
          text: 'host unreachable',
          detail: 'icmp probe failed',
          envs: [REQUEST.env],
        },
      ],
    },
    '/api/snapshot': {
      generated_at: observedAt,
      // Batch stamp, deliberately present: the collector must NOT read freshness
      // from it (a sibling row collected this cycle would make a failed probe
      // look current). The row's own `probed_at` below is the one that counts.
      observed_at: { hosts: observedAt },
      hosts: [
        {
          id: HOST_ID,
          env: REQUEST.env,
          reachable: false,
          best_effort: false,
          error: 'icmp probe failed',
          probed_at: observedAt,
        },
      ],
    },
  };
}

function installEagleEye(observedAt: string): ReturnType<typeof vi.fn> {
  const bodies = eagleResponses(observedAt);
  const fetchMock = vi.fn(async (url: string) => {
    const requested = new URL(String(url));
    const body = bodies[requested.pathname];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

// ------------------------------------------------------------- fake model

/** Call the real evidence tool the way the SDK would, through a real MCP client. */
async function callEvidenceTool(options: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const servers = options.mcpServers as Record<string, { instance: { connect: (t: unknown) => Promise<void> } }>;
  const server = servers[INCIDENT_EVIDENCE_SERVER_NAME];
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'incident-handler-itest', version: '1.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: INCIDENT_EVIDENCE_TOOL_NAME, arguments: {} });
    const content = result.content as Array<{ text: string }>;
    return { text: content[0].text, isError: result.isError === true };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function systemInit(): unknown {
  return { type: 'system', subtype: 'init', session_id: 'sdk-session-itest', model: 'claude-fable-5-1', tools: [] };
}

function assistantToolUse(): unknown {
  return {
    type: 'assistant',
    session_id: 'sdk-session-itest',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: INCIDENT_EVIDENCE_TOOL, input: {} }],
    },
  };
}

function userToolResult(text: string, isError = false): unknown {
  return {
    type: 'user',
    session_id: 'sdk-session-itest',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: isError, content: [{ type: 'text', text }] }],
    },
  };
}

function assistantText(text: string): unknown {
  return {
    type: 'assistant',
    session_id: 'sdk-session-itest',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function sdkSuccessResult(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sdk-session-itest',
    is_error: false,
    result: 'raw model result text',
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

/** The marker line a model writes. `evidence[].fact` is a lie on purpose. */
function markerLine(evidence: Array<{ id: string; observed_at: string }>): string {
  return `EAGLE_INCIDENT_RESULT: ${JSON.stringify({
    version: 1,
    status: 'succeeded',
    summary: 'collector still reports mac-mini-dev unreachable in dev2',
    evidence: evidence.map((item) => ({ ...item, fact: MODEL_ONLY_FACT })),
    proposal: {
      id: 'p1',
      action: 'have an operator check power and LAN on mac-mini-dev',
      risk: 'read-only until the operator acts',
      rollback: 'none required',
      verification: 'eagle-eye host row reports reachable=true',
    },
    uncertainties: ['the collector may not have re-probed since the alert'],
  })}`;
}

// ------------------------------------------------------------------ setup

beforeEach(() => {
  fs.mkdirSync(harness.dataDir, { recursive: true });
  harness.seenOptions.length = 0;
  harness.runQuery = null;
  process.env.SOMA_INCIDENT_EVIDENCE_BASE_URL = EAGLE_ORIGIN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SOMA_INCIDENT_EVIDENCE_BASE_URL;
});

afterAll(() => {
  fs.rmSync(harness.dataDir, { recursive: true, force: true });
});

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const message of stream) out.push(message);
  return out;
}

function markerOf(messages: unknown[]): { line: string; payload: Record<string, unknown> } {
  const result = messages.find((m) => (m as { type?: string }).type === 'result') as { result?: string } | undefined;
  const text = result?.result ?? '';
  const lines = text.split('\n').filter((line) => line.startsWith('EAGLE_INCIDENT_RESULT:'));
  expect(lines).toHaveLength(1);
  return { line: lines[0], payload: JSON.parse(lines[0].slice('EAGLE_INCIDENT_RESULT:'.length).trim()) };
}

// ------------------------------------------------------------------ tests

describe('ClaudeHandler.streamQuery — incident attempt, real wiring', () => {
  it('runs the isolated surface, collects through the real tool, and publishes a host-owned conclusion', async () => {
    const observedAt = new Date().toISOString();
    const fetchMock = installEagleEye(observedAt);
    harness.runQuery = async function* run({ options }) {
      const collected = await callEvidenceTool(options);
      const evidence = JSON.parse(collected.text) as {
        snapshot: { host: { ref: string; freshness: { observed_at: string } } };
      };
      yield systemInit();
      yield assistantToolUse();
      yield userToolResult(collected.text);
      yield assistantText(
        `${MODEL_PROSE}\n${markerLine([
          { id: evidence.snapshot.host.ref, observed_at: evidence.snapshot.host.freshness.observed_at },
        ])}`,
      );
      yield sdkSuccessResult();
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const session = makeSession();
    const messages = await drain(
      handler.streamQuery('incident attempt', session, undefined, undefined, SLACK_CONTEXT as never),
    );

    // The builder took the incident branch with the real config getter…
    const options = harness.seenOptions[0];
    expect(Object.keys(options.mcpServers as object)).toEqual([INCIDENT_EVIDENCE_SERVER_NAME]);
    expect(options.allowedTools).toEqual([INCIDENT_EVIDENCE_TOOL]);
    expect(options.settingSources).toEqual([]);
    expect(options.tools).toEqual([]);
    // …and the tool read the operator-configured origin, nothing model-supplied.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(`${EAGLE_ORIGIN}/api/triage`);
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe(`${EAGLE_ORIGIN}/api/snapshot`);

    // The published conclusion carries the request's fixed ids…
    const { payload } = markerOf(messages);
    expect(payload.incident_id).toBe(REQUEST.incident_id);
    expect(payload.lifecycle_id).toBe(REQUEST.lifecycle_id);
    expect(payload.attempt_id).toBe(REQUEST.attempt_id);
    expect(payload.status).toBe('succeeded');

    // …citing the record the HOST recorded, with the HOST's fact, not the model's.
    const cited = payload.evidence as Array<{ id: string; observed_at: string; fact: string }>;
    expect(cited).toHaveLength(1);
    expect(cited[0].id).toBe(EXPECTED_REF);
    expect(cited[0].observed_at).toBe(observedAt);
    expect(cited[0].fact).toContain(`host ${HOST_ID}`);
    expect(cited[0].fact).toContain('reachable=false');
    expect(cited[0].fact).not.toContain(MODEL_ONLY_FACT);

    // The attempt is marked finished, which is what admits a retry later.
    expect(session.incidentAttemptFinishedId).toBe(REQUEST.attempt_id);
  });

  it('never lets the model’s own text or marker reach the consumer', async () => {
    const observedAt = new Date().toISOString();
    installEagleEye(observedAt);
    harness.runQuery = async function* run({ options }) {
      const collected = await callEvidenceTool(options);
      const evidence = JSON.parse(collected.text) as {
        snapshot: { host: { ref: string; freshness: { observed_at: string } } };
      };
      yield systemInit();
      yield userToolResult(collected.text);
      // A marker written mid-stream, before any validation could have happened.
      yield assistantText(
        `${MODEL_PROSE}\n${markerLine([
          { id: evidence.snapshot.host.ref, observed_at: evidence.snapshot.host.freshness.observed_at },
        ])}`,
      );
      yield sdkSuccessResult();
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const messages = await drain(
      handler.streamQuery('incident attempt', makeSession(), undefined, undefined, SLACK_CONTEXT as never),
    );

    const wire = JSON.stringify(messages);
    expect(wire).not.toContain(MODEL_PROSE);
    expect(wire).not.toContain(MODEL_ONLY_FACT);
    // The raw evidence blob is not dumped into the thread either.
    expect(wire).not.toContain('eagle_eye_collector_snapshot');
    // Exactly one marker reaches the consumer, and it is the host's rendering.
    const markerCount = wire.split('EAGLE_INCIDENT_RESULT:').length - 1;
    expect(markerCount).toBeGreaterThan(0);
    expect(markerOf(messages).payload.evidence).toHaveLength(1);
  });

  it('refuses a conclusion citing a record the host never collected', async () => {
    installEagleEye(new Date().toISOString());
    harness.runQuery = async function* run({ options }) {
      await callEvidenceTool(options);
      yield systemInit();
      yield assistantText(
        markerLine([{ id: 'eagle:/api/snapshot#hosts[id=prod-db]', observed_at: new Date().toISOString() }]),
      );
      yield sdkSuccessResult();
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const messages = await drain(
      handler.streamQuery('incident attempt', makeSession(), undefined, undefined, SLACK_CONTEXT as never),
    );

    const { payload } = markerOf(messages);
    expect(payload.status).toBe('inconclusive');
    expect(payload.evidence).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain('prod-db');
  });
});

describe('ClaudeHandler.streamQuery — incident failures terminate, never retry', () => {
  // Reachable, not hypothetical: `session-registry.ts:2075` restores any
  // non-null object verbatim ("any present value keeps the session restricted"),
  // and `claude-handler.ts:944` enters the incident wrapper on a truthy field.
  // A half-shaped value from a truncated sessions file must end as a host
  // terminal — never as an ordinary full-tool session in an unattended thread.
  it('refuses a restored request with a bad version, without ever reaching the SDK', async () => {
    installEagleEye(new Date().toISOString());
    harness.runQuery = () => {
      throw new Error('the SDK must never run for a malformed incident session');
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const session = makeSession({ incidentRequest: { ...REQUEST, version: 99 } as never });
    const messages = await drain(
      handler.streamQuery('incident attempt', session, undefined, undefined, SLACK_CONTEXT as never),
    );

    expect(harness.seenOptions).toHaveLength(0);
    const { payload } = markerOf(messages);
    expect(payload.status).toBe('failed');
    expect(payload.attempt_id).toBe(REQUEST.attempt_id);
    expect(payload.evidence).toEqual([]);
  });

  it('refuses an empty restored request, without ever reaching the SDK', async () => {
    installEagleEye(new Date().toISOString());
    harness.runQuery = () => {
      throw new Error('the SDK must never run for a malformed incident session');
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const session = makeSession({ incidentRequest: {} as never });
    const messages = await drain(
      handler.streamQuery('incident attempt', session, undefined, undefined, SLACK_CONTEXT as never),
    );

    expect(harness.seenOptions).toHaveLength(0);
    const { payload } = markerOf(messages);
    // `{}` carries no correlation ids, so the result contract cannot render a
    // valid wire result for it and the host failure degrades to `inconclusive`
    // (`attempt-output.ts:633` → `tooLargeToFrame`). What this test owns is the
    // property above it: a bounded host terminal, never a model conclusion and
    // never an ordinary session.
    expect(['failed', 'inconclusive', 'interrupted']).toContain(payload.status);
    expect(payload.evidence).toEqual([]);
  });

  it('emits a bounded host failure when no evidence config is wired, without calling the SDK', async () => {
    delete process.env.SOMA_INCIDENT_EVIDENCE_BASE_URL;
    // Not a generator: reaching `query()` at all is the failure this test names.
    harness.runQuery = () => {
      throw new Error('the SDK must never be reached without an evidence config');
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const messages = await drain(
      handler.streamQuery('incident attempt', makeSession(), undefined, undefined, SLACK_CONTEXT as never),
    );

    expect(harness.seenOptions).toHaveLength(0);
    const { payload } = markerOf(messages);
    expect(payload.status).toBe('failed');
    expect(payload.evidence).toEqual([]);
    expect(payload.attempt_id).toBe(REQUEST.attempt_id);
  });

  it('turns a thrown SDK stream into a terminal result instead of rethrowing to the retry path', async () => {
    installEagleEye(new Date().toISOString());
    harness.runQuery = async function* run() {
      yield systemInit();
      throw new Error('SDK transport died: ECONNRESET 10.0.0.9:443');
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const messages = await drain(
      handler.streamQuery('incident attempt', makeSession(), undefined, undefined, SLACK_CONTEXT as never),
    );

    const { payload } = markerOf(messages);
    expect(payload.status).toBe('failed');
    // The transport error text is logged, never published.
    expect(JSON.stringify(messages)).not.toContain('ECONNRESET');
  });

  it('reports an interrupted attempt when the caller aborts, and still terminates cleanly', async () => {
    installEagleEye(new Date().toISOString());
    const callerAbort = new AbortController();
    harness.runQuery = async function* run() {
      yield systemInit();
      callerAbort.abort('operator stopped the session');
      yield sdkSuccessResult();
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const messages = await drain(
      handler.streamQuery('incident attempt', makeSession(), callerAbort, undefined, SLACK_CONTEXT as never),
    );

    expect(markerOf(messages).payload.status).toBe('interrupted');
  });
});

describe('ClaudeHandler.streamQuery — the ordinary path is untouched', () => {
  it('builds ordinary options and forwards the model stream verbatim', async () => {
    const assistant = assistantText('ordinary answer, streamed as written');
    const result = sdkSuccessResult();
    harness.runQuery = async function* run() {
      yield systemInit();
      yield assistant;
      yield result;
    };

    const handler = new ClaudeHandler(makeMcpManager());
    const session = makeSession({ incidentRequest: undefined });
    const messages = await drain(
      handler.streamQuery('ordinary turn', session, undefined, undefined, SLACK_CONTEXT as never),
    );

    const options = harness.seenOptions[0];
    expect(options.settingSources).toEqual(['project']);
    expect(Object.keys((options.mcpServers as object) ?? {})).not.toContain(INCIDENT_EVIDENCE_SERVER_NAME);
    expect(options.maxTurns).toBeUndefined();
    // Same objects, same order, nothing screened or synthesized.
    expect(messages).toHaveLength(3);
    expect(messages[1]).toBe(assistant);
    expect(messages[2]).toBe(result);
    expect(session.incidentAttemptFinishedId).toBeUndefined();
  });
});
