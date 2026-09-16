/**
 * Eagle-eye incident attempt output — host guard tests.
 *
 * The property under test is not "does it format nicely" but "can anything the
 * model wrote reach the thread unvalidated". So every case here drives the REAL
 * production functions — the real registry, the real screener, and the real
 * result contract from `@soma/slack/incident-result` — over fixture SDK messages
 * shaped like the ones the Agent SDK emits. No mocks of the decoder, no network,
 * no model.
 *
 * The fixtures encode the attacks the path actually has to survive: a forged
 * `EAGLE_INCIDENT_RESULT:` line written mid-stream, a success claim with no
 * evidence behind it, a real record reference carrying an invented fact, a
 * conclusion addressed to a different attempt, and a crash whose raw text
 * carries a credential.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { INCIDENT_RESULT_MARKER, validateIncidentResultWire } from '@soma/slack/incident-result';
import { describe, expect, it } from 'vitest';
import {
  buildIncidentAttemptOutput,
  buildIncidentTerminalMessages,
  createIncidentEvidenceRegistry,
  INCIDENT_EVIDENCE_MAX_AGE_SECONDS,
  INCIDENT_SOURCE_CAVEAT,
  isFailedSdkResult,
  MAX_MODEL_TEXT_CHARS,
  resolveIncidentAttemptEnd,
  screenIncidentMessage,
  screenIncidentStream,
} from '../attempt-output';
import type { EvidenceHost, IncidentEvidence, SanitizedText } from '../evidence';
import type { IncidentRequestLike } from '../sdk-options';

// ------------------------------------------------------------------ fixtures

const REQUEST: IncidentRequestLike = {
  version: 1,
  incident_id: 'HOST-proj-dev2-api-unreachable',
  lifecycle_id: 'LC-2026-09-11-0007',
  attempt_id: 'AT-2026-09-11-0007-1',
  channel_id: 'C0EAGLE123',
  parent_ts: '1757500000.000100',
  env: 'dev2',
  summary: 'proj-dev2-api is unreachable',
};

const OBSERVED_AT = '2026-09-11T10:30:00Z';
const NOW = new Date('2026-09-11T10:31:00Z');
const HOST_REF = 'eagle:/api/snapshot#hosts[id=proj-dev2-api]';
const CHECK_REF = 'eagle:/api/snapshot#http_checks[name=proj-dev2-api-health]';

function sanitized(text: string | null, extra: Partial<SanitizedText> = {}): SanitizedText {
  return { text, redacted: false, truncated: false, ...extra };
}

function hostRow(overrides: Partial<EvidenceHost> = {}): EvidenceHost {
  return {
    ref: HOST_REF,
    id: 'proj-dev2-api',
    env: 'dev2',
    reachable: false,
    best_effort: true,
    error: sanitized('connection refused'),
    freshness: { state: 'fresh', observed_at: OBSERVED_AT, age_seconds: 12 },
    ...overrides,
  };
}

/** An `IncidentEvidence` whose host row is the only snapshot record. */
function evidenceWithHost(host: EvidenceHost | null): IncidentEvidence {
  return evidenceFixture({
    snapshot: { ref: 'eagle:/api/snapshot', generated_at: '2026-09-11T10:30:03Z', host, external: null, check: null },
  });
}

function evidenceFixture(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    incident_id: REQUEST.incident_id,
    env: REQUEST.env,
    status: 'reported',
    provenance: 'eagle_eye_collector_snapshot',
    caveat: 'Eagle-eye still reports this issue for this env. Collector snapshot re-read, not an independent probe.',
    collected_at: '2026-09-11T10:30:05Z',
    triage: {
      ref: 'eagle:/api/triage',
      generated_at: '2026-09-11T10:30:04Z',
      freshness: { state: 'fresh', observed_at: '2026-09-11T10:30:04Z', age_seconds: 1 },
      issue: {
        ref: 'eagle:/api/triage#issues[id=HOST-proj-dev2-api-unreachable]',
        id: REQUEST.incident_id,
        cat: 'HOST',
        key: 'host:proj-dev2-api',
        text: sanitized('host unreachable'),
        detail: sanitized('ssh probe failed'),
        envs: ['dev2'],
      },
    },
    snapshot: {
      ref: 'eagle:/api/snapshot',
      generated_at: '2026-09-11T10:30:03Z',
      host: hostRow(),
      external: null,
      check: null,
    },
    errors: [],
    ...overrides,
  };
}

function assistantMessage(content: Array<Record<string, unknown>>, usage?: Record<string, number>): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'uuid-assistant',
    session_id: 'sdk-session',
    parent_tool_use_id: null,
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5-1',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage ?? { input_tokens: 120, output_tokens: 40 },
    },
  } as unknown as SDKMessage;
}

/**
 * Stands in for the collector's raw blob in the tool-result channel: if this
 * string ever appears downstream, the whole evidence payload did too.
 */
const RAW_EVIDENCE_SENTINEL = `{"__raw_evidence_sentinel__":"${HOST_REF}","status":"reported"}`;

function userMessage(content: Array<Record<string, unknown>>): SDKMessage {
  return {
    type: 'user',
    uuid: 'uuid-user',
    session_id: 'sdk-session',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  } as unknown as SDKMessage;
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'uuid-result',
    session_id: 'sdk-session',
    is_error: false,
    result: 'raw model final text',
    stop_reason: 'end_turn',
    duration_ms: 4321,
    duration_api_ms: 4000,
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 900, output_tokens: 250 },
    modelUsage: { 'claude-fable-5-1': { inputTokens: 900, outputTokens: 250, costUSD: 0.0123 } },
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage;
}

function markerPayload(overrides: Record<string, unknown> = {}): string {
  return `${INCIDENT_RESULT_MARKER} ${JSON.stringify({
    version: 1,
    status: 'succeeded',
    summary: 'proj-dev2-api has been unreachable since 10:30Z.',
    evidence: [{ id: HOST_REF, observed_at: OBSERVED_AT }],
    proposal: {
      id: 'P1',
      action: 'have an operator check the dev2 api host',
      risk: 'none, read-only',
      rollback: 'not applicable',
      verification: 'eagle-eye stops reporting the incident',
    },
    uncertainties: ['snapshot may have aged'],
    ...overrides,
  })}`;
}

function registryWith(evidence: IncidentEvidence = evidenceFixture()) {
  const registry = createIncidentEvidenceRegistry(REQUEST);
  registry.record(REQUEST, evidence);
  return registry;
}

function markerLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().startsWith(INCIDENT_RESULT_MARKER));
}

/** What the Rust side measures. A Korean codepoint is three of these, not one. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ------------------------------------------------------------------- registry

describe('incident evidence registry', () => {
  it('projects a fresh snapshot row into a citable record with a host-authored fact', () => {
    const records = registryWith().verifiedAt(NOW);

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(HOST_REF);
    expect(records[0].observed_at).toBe(OBSERVED_AT);
    expect(records[0].fact).toBe(
      'host proj-dev2-api env=dev2 reachable=false best_effort=true error=connection refused',
    );
  });

  it('never turns a triage report into evidence, however fresh its generated_at is', () => {
    // Triage says the incident is real and says it 1 second ago — but
    // `generated_at` is when the report was built, not an observation of the
    // host. An issue with no matching snapshot row leaves the attempt with
    // nothing to cite.
    const evidence = evidenceFixture({
      snapshot: { ref: 'eagle:/api/snapshot', generated_at: null, host: null, external: null, check: null },
    });

    expect(registryWith(evidence).verifiedAt(NOW)).toHaveLength(0);
  });

  it('refuses a row the collector did not mark fresh', () => {
    const evidence = evidenceWithHost(
      hostRow({ freshness: { state: 'stale', observed_at: '2026-09-11T09:00:00Z', age_seconds: 5400 } }),
    );

    expect(registryWith(evidence).verifiedAt(NOW)).toHaveLength(0);
    expect(registryWith(evidence).stats().unusableRows).toBe(1);
  });

  it('refuses a row whose source observation time is not a strict UTC instant', () => {
    const evidence = evidenceWithHost(
      hostRow({ freshness: { state: 'fresh', observed_at: '2026-09-11T10:30:00+00:00', age_seconds: 5 } }),
    );

    expect(registryWith(evidence).verifiedAt(NOW)).toHaveLength(0);
  });

  it('ages a record out at validation time, because the attempt kept running', () => {
    const registry = registryWith();
    const late = new Date(Date.parse(OBSERVED_AT) + (INCIDENT_EVIDENCE_MAX_AGE_SECONDS + 1) * 1000);

    expect(registry.verifiedAt(NOW)).toHaveLength(1);
    expect(registry.verifiedAt(late)).toHaveLength(0);
  });

  it.each([
    ['attempt_id', { attempt_id: 'AT-SOMEONE-ELSE' }],
    ['lifecycle_id', { lifecycle_id: 'LC-SOMEONE-ELSE' }],
    ['incident_id', { incident_id: 'HOST-other' }],
    ['channel_id', { channel_id: 'C0OTHER999' }],
    ['parent_ts', { parent_ts: '1757509999.000999' }],
    ['env', { env: 'prod' }],
  ])('refuses a collection whose %s does not match the attempt’s fixed context', (_field, override) => {
    const registry = createIncidentEvidenceRegistry(REQUEST);
    registry.record({ ...REQUEST, ...override }, evidenceFixture());

    expect(registry.verifiedAt(NOW)).toHaveLength(0);
    expect(registry.stats().foreign).toBe(1);
  });

  it('refuses a collection whose subject is a different incident or env', () => {
    const registry = createIncidentEvidenceRegistry(REQUEST);
    registry.record(REQUEST, evidenceFixture({ env: 'prod' }));

    expect(registry.verifiedAt(NOW)).toHaveLength(0);
    expect(registry.stats().foreign).toBe(1);
  });

  it('publishes the sanitizer refusal instead of an un-redactable string, and bounds the fact', () => {
    const evidence = evidenceWithHost(
      hostRow({ error: sanitized(null, { redacted: true, omitted: 'unsafe_to_sanitize' }) }),
    );
    const refused = registryWith(evidence).verifiedAt(NOW)[0];
    expect(refused.fact).toContain('error=<withheld: unsafe to sanitize>');

    const long = evidenceWithHost(hostRow({ error: sanitized('e'.repeat(4000)) }));
    const bounded = registryWith(long).verifiedAt(NOW)[0];
    expect(bounded.fact.length).toBeLessThanOrEqual(1000);
  });

  it('keeps the newest observation of a record rather than accumulating history', () => {
    const registry = createIncidentEvidenceRegistry(REQUEST);
    registry.record(REQUEST, evidenceFixture());
    const second = evidenceWithHost(
      hostRow({ freshness: { state: 'fresh', observed_at: '2026-09-11T10:30:45Z', age_seconds: 3 } }),
    );
    registry.record(REQUEST, second);

    const records = registry.verifiedAt(NOW);
    expect(records).toHaveLength(1);
    expect(records[0].observed_at).toBe('2026-09-11T10:30:45Z');
  });

  it('invalidates an earlier record when the newest collection could read nothing', () => {
    // Second look comes back empty. Keeping the first observation alive would
    // let "we can no longer see it" back a `succeeded` conclusion — the exact
    // inversion the collector refuses to make.
    const registry = createIncidentEvidenceRegistry(REQUEST);
    registry.record(REQUEST, evidenceFixture());
    expect(registry.verifiedAt(NOW)).toHaveLength(1);

    registry.record(REQUEST, evidenceFixture({ status: 'evidence_unavailable', snapshot: null }));

    expect(registry.verifiedAt(NOW)).toHaveLength(0);
    expect(registry.stats().invalidated).toBe(1);
  });

  it('leaves no citable ref after an unavailable → reported → unavailable sequence', () => {
    // The real callback order the evidence tool produces across an attempt's
    // turns. The middle collection is the only one that ever saw anything, and
    // once the third could not read, nothing it observed may still be cited —
    // otherwise a conclusion written at the end is backed by a record the host
    // has since failed to confirm.
    const unavailable = evidenceFixture({ status: 'evidence_unavailable', snapshot: null });
    const registry = createIncidentEvidenceRegistry(REQUEST);

    registry.record(REQUEST, unavailable);
    expect(registry.verifiedAt(NOW)).toHaveLength(0);

    registry.record(REQUEST, evidenceFixture());
    expect(registry.verifiedAt(NOW).map((record) => record.id)).toEqual([HOST_REF]);

    registry.record(REQUEST, unavailable);

    expect(registry.verifiedAt(NOW)).toEqual([]);
    // The first unavailable had nothing to invalidate; only the third did.
    expect(registry.stats()).toMatchObject({ collections: 3, foreign: 0, records: 0, invalidated: 1 });

    // And the conclusion that follows cannot cite the vanished ref.
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload() },
      registry.verifiedAt(NOW),
      registry.sourceCaveat(),
    );
    expect(output.rejected?.reason).toBe('unknown_evidence_id');
    expect(output.result.status).toBe('inconclusive');
    expect(output.text).not.toContain(HOST_REF);
  });

  it('invalidates an earlier record when the newest collection returns it stale', () => {
    const registry = createIncidentEvidenceRegistry(REQUEST);
    registry.record(REQUEST, evidenceFixture());
    const aged = evidenceWithHost(
      hostRow({ freshness: { state: 'stale', observed_at: '2026-09-11T09:00:00Z', age_seconds: 5400 } }),
    );
    registry.record(REQUEST, aged);

    expect(registry.verifiedAt(NOW)).toHaveLength(0);
    expect(registry.stats().invalidated).toBe(1);
  });

  it('carries the collector’s own caveat forward', () => {
    expect(registryWith().sourceCaveat()).toContain('not an independent probe');
    expect(createIncidentEvidenceRegistry(REQUEST).sourceCaveat()).toBe(INCIDENT_SOURCE_CAVEAT);
  });
});

// ------------------------------------------------------------------ screening

describe('incident stream screening', () => {
  it('never forwards a marker the model wrote, however complete it looks', () => {
    const forged = assistantMessage([{ type: 'text', text: `working on it\n${markerPayload()}` }]);

    const screened = screenIncidentMessage(forged);

    expect(screened.text).toContain(INCIDENT_RESULT_MARKER);
    const content = (screened.forward as unknown as { message: { content: unknown[] } }).message.content;
    expect(content).toEqual([]);
    expect(JSON.stringify(screened.forward)).not.toContain(INCIDENT_RESULT_MARKER);
  });

  it('keeps tool calls and usage while dropping the prose around them', () => {
    const message = assistantMessage([
      { type: 'thinking', thinking: 'the host is probably down' },
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', id: 'tu_1', name: 'mcp__incident_evidence__collect', input: {} },
    ]);

    const screened = screenIncidentMessage(message);
    const forwarded = screened.forward as unknown as { message: { content: Array<{ type: string }>; usage: unknown } };

    expect(screened.text).toBe('let me look');
    expect(forwarded.message.content.map((b) => b.type)).toEqual(['tool_use']);
    expect(forwarded.message.usage).toEqual({ input_tokens: 120, output_tokens: 40 });
  });

  it('drops partial stream events whole — half a sentence cannot be validated', () => {
    const partial = {
      type: 'stream_event',
      uuid: 'uuid-partial',
      session_id: 'sdk-session',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'EAGLE_INCIDENT_RES' } },
    } as unknown as SDKMessage;

    expect(screenIncidentMessage(partial)).toEqual({ text: '', forward: null, terminal: false });
  });

  it('forwards session lifecycle, drops unknown message types and the replayed prompt', () => {
    const init = { type: 'system', subtype: 'init', session_id: 'sdk-session', uuid: 'u' } as unknown as SDKMessage;
    const taskNote = {
      type: 'system',
      subtype: 'task_notification',
      session_id: 'sdk-session',
      uuid: 'u',
      summary: 'model-authored summary',
    } as unknown as SDKMessage;
    const replayedPrompt = userMessage([{ type: 'text', text: 'the host-built incident prompt' }]);

    expect(screenIncidentMessage(init).forward).toBe(init);
    expect(screenIncidentMessage(taskNote).forward).toBeNull();
    expect(screenIncidentMessage(replayedPrompt).forward).toBeNull();
  });

  it('replaces a tool result with a fixed line, keeping only its lifecycle identity', () => {
    // The mapper turns a forwarded `tool_result` into `rawOutput`
    // (sdk-message-to-event.ts:172) and the processor renders it
    // (stream-processor.ts:1399) — so the collector's whole blob would land in
    // the thread ahead of any validation. `RAW_EVIDENCE_SENTINEL` stands in for
    // every ref, timestamp and error inside it.
    const screened = screenIncidentMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: RAW_EVIDENCE_SENTINEL }]),
    );

    const blocks = (screened.forward as unknown as { message: { content: Array<Record<string, unknown>> } }).message
      .content;
    expect(JSON.stringify(screened.forward)).not.toContain(RAW_EVIDENCE_SENTINEL);
    expect(JSON.stringify(screened.forward)).not.toContain(HOST_REF);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool_use_id).toBe('tu_1');
    expect(blocks[0].is_error).toBe(false);
    expect(blocks[0].content).toEqual([{ type: 'text', text: '증거 조회 완료 — 검증된 결론에 포함됩니다' }]);
  });

  it('keeps a failed tool result legible as a failure, without its message', () => {
    const screened = screenIncidentMessage(
      userMessage([
        {
          type: 'tool_result',
          tool_use_id: 'tu_2',
          is_error: true,
          content: `collector said ${RAW_EVIDENCE_SENTINEL}`,
        },
      ]),
    );

    const blocks = (screened.forward as unknown as { message: { content: Array<Record<string, unknown>> } }).message
      .content;
    expect(blocks[0].is_error).toBe(true);
    expect(blocks[0].tool_use_id).toBe('tu_2');
    expect(blocks[0].content).toEqual([{ type: 'text', text: '증거 조회 실패 — 결론에 반영되지 않습니다' }]);
    expect(JSON.stringify(screened.forward)).not.toContain(RAW_EVIDENCE_SENTINEL);
  });

  it('preserves the absence of is_error, which the mapper distinguishes from false', () => {
    const screened = screenIncidentMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'tu_3', content: RAW_EVIDENCE_SENTINEL }]),
    );

    const blocks = (screened.forward as unknown as { message: { content: Array<Record<string, unknown>> } }).message
      .content;
    expect('is_error' in blocks[0]).toBe(false);
  });

  it('treats the SDK result as terminal and forwards none of it', () => {
    const screened = screenIncidentMessage(resultMessage());

    expect(screened.terminal).toBe(true);
    expect(screened.forward).toBeNull();
    expect(screened.text).toBe('');
  });

  it('recognises a broken run', () => {
    expect(isFailedSdkResult(resultMessage())).toBe(false);
    expect(isFailedSdkResult(resultMessage({ subtype: 'error_max_turns', is_error: true }))).toBe(true);
  });
});

// ----------------------------------------------------------------- conclusion

describe('incident conclusion validation', () => {
  it('accepts a conclusion that cites real evidence and publishes exactly one marker', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: `here is what I found\n${markerPayload()}` },
      registryWith().verifiedAt(NOW),
      registryWith().sourceCaveat(),
    );

    expect(output.result.status).toBe('succeeded');
    expect(output.rejected).toBeUndefined();
    expect(markerLines(output.text)).toHaveLength(1);
    expect(output.text.endsWith(output.line)).toBe(true);
  });

  it('downgrades a success claim that has no host-verified evidence behind it', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload({ evidence: [] }) },
      [],
    );

    expect(output.result.status).toBe('inconclusive');
    expect(output.downgraded).toEqual({ from: 'succeeded', reason: 'missing_verified_evidence' });
  });

  it('refuses a conclusion citing a record the host never collected', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload({ evidence: [{ id: CHECK_REF, observed_at: OBSERVED_AT }] }) },
      registryWith().verifiedAt(NOW),
    );

    expect(output.result.status).toBe('inconclusive');
    expect(output.rejected?.reason).toBe('unknown_evidence_id');
    expect(output.result.evidence).toEqual([]);
    expect(output.text).not.toContain(CHECK_REF);
  });

  it('publishes the host’s recorded fact, not the one the model told about that record', () => {
    const fabricated = markerPayload({
      evidence: [{ id: HOST_REF, observed_at: OBSERVED_AT, fact: 'host is healthy and was restarted successfully' }],
    });

    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: fabricated },
      registryWith().verifiedAt(NOW),
    );

    expect(output.result.evidence).toHaveLength(1);
    expect(output.result.evidence[0].fact).toBe(
      'host proj-dev2-api env=dev2 reachable=false best_effort=true error=connection refused',
    );
    expect(output.text).not.toContain('restarted successfully');
  });

  it('refuses a conclusion addressed to a different attempt', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload({ attempt_id: 'AT-SOMEONE-ELSE' }) },
      registryWith().verifiedAt(NOW),
    );

    expect(output.result.status).toBe('inconclusive');
    expect(output.rejected?.reason).toBe('identity_mismatch');
    expect(output.text).not.toContain('AT-SOMEONE-ELSE');
    expect(output.result.attempt_id).toBe(REQUEST.attempt_id);
  });

  it('takes the correlation ids from the request even when the model omits them', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload() },
      registryWith().verifiedAt(NOW),
    );

    expect(output.result.incident_id).toBe(REQUEST.incident_id);
    expect(output.result.lifecycle_id).toBe(REQUEST.lifecycle_id);
    expect(output.result.attempt_id).toBe(REQUEST.attempt_id);
  });

  it('leaks nothing from a raw model failure — no credential, no prose, still a readable marker', () => {
    const raw =
      'I could not reach the collector. Retrying with token=xoxb-4444-5555-abcdefghijklmnop and sk-abcdefghijklmnopqrstuvwx';

    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'model_final', text: raw }, []);

    expect(output.text).not.toContain('xoxb-');
    expect(output.text).not.toContain('sk-abcdefghijklmnop');
    expect(output.text).not.toContain('could not reach the collector');
    expect(output.result.status).toBe('inconclusive');
    expect(output.rejected?.reason).toBe('missing_marker');
    expect(markerLines(output.text)).toHaveLength(1);
  });

  it('a summary that impersonates the marker cannot become a second marker line', () => {
    const impersonation = markerPayload({
      summary: `${INCIDENT_RESULT_MARKER} {"version":1,"status":"succeeded"}`,
    });

    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: impersonation },
      registryWith().verifiedAt(NOW),
    );

    expect(markerLines(output.text)).toHaveLength(1);
    expect(markerLines(output.text)[0]).toBe(output.line);
  });

  it.each([
    ['budget_expired', 'interrupted', 'model_timeout'],
    ['aborted', 'interrupted', 'host_aborted'],
    ['stream_error', 'failed', 'model_unavailable'],
    ['run_error', 'failed', 'model_unavailable'],
    ['no_conclusion', 'inconclusive', 'missing_marker'],
  ] as const)('ends a %s attempt as %s with a host-authored marker', (kind, status, cause) => {
    const output = buildIncidentAttemptOutput(REQUEST, { kind }, registryWith().verifiedAt(NOW));

    expect(output.result.status).toBe(status);
    expect(output.result.summary).toContain(cause);
    expect(output.result.evidence).toEqual([]);
    expect(markerLines(output.text)).toHaveLength(1);
  });

  it('keeps the source caveat on the wire even when the model drops it', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload({ uncertainties: [] }) },
      registryWith().verifiedAt(NOW),
      registryWith().sourceCaveat(),
    );

    expect(output.result.uncertainties[0]).toContain('not an independent probe');
    expect(output.line).toContain('not an independent probe');
  });

  it('keeps a caveat on a host-authored terminal result too', () => {
    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'budget_expired' }, []);

    expect(output.result.uncertainties).toEqual([INCIDENT_SOURCE_CAVEAT]);
  });

  it('drops a conclusion the caveat no longer fits, rather than emitting an over-length line', () => {
    // Sized to land in the window between the two checks: the conclusion the
    // decoder validates (no caveat) renders to ~16.0 kB and passes, and the 967
    // bytes of Korean caveat this module prepends push it past the Rust side's
    // 16384-byte budget. A JS `.length` check could not see that — 327
    // codepoints weigh 967 bytes.
    const koreanCaveat = `수집기 스냅샷 관측이며 독립 재검증이 아닙니다. ${'관측'.repeat(150)}`;
    const bulky = Array.from({ length: 10 }, (_unused, index) => ({
      id: `eagle:/api/snapshot#hosts[id=host-${index}]`,
      observed_at: OBSERVED_AT,
      fact: `host host-${index} ${'상태'.repeat(245)}`,
    }));
    const conclusion = markerPayload({
      evidence: bulky.map(({ id, observed_at }) => ({ id, observed_at })),
      proposal: null,
      uncertainties: [],
    });

    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'model_final', text: conclusion }, bulky, koreanCaveat);

    // The decoder accepted it — this module is what refused to publish it, so
    // the fallback below is genuinely this file's behaviour and not the
    // contract's inbound check firing early.
    expect(output.rejected).toBeUndefined();
    expect(validateIncidentResultWire(output.result)).toEqual({ ok: true });
    expect(utf8Bytes(output.line)).toBeLessThanOrEqual(16384);
    expect(output.result.status).toBe('inconclusive');
    expect(output.result.summary).toContain('result_too_large');
    expect(output.result.evidence).toEqual([]);
    expect(markerLines(output.text)).toHaveLength(1);
  });

  it('steps the fallback down to its own caveat when the collector’s will not fit either', () => {
    // The caveat is upstream text, so it can be the very thing that overflows.
    // The host result must still say what kind of evidence this was.
    const unusableCaveat = '관'.repeat(1200);

    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'budget_expired' }, [], unusableCaveat);

    expect(validateIncidentResultWire(output.result)).toEqual({ ok: true });
    expect(output.result.uncertainties).toEqual([INCIDENT_SOURCE_CAVEAT]);
  });

  it('refuses a caveat whose escaped form blows the per-field bound', () => {
    // `&` costs five codepoints once escaped, so a 300-char caveat renders as
    // 1500 — over the per-field limit, though nothing about it looks long.
    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'budget_expired' }, [], '&'.repeat(300));

    expect(validateIncidentResultWire(output.result)).toEqual({ ok: true });
    expect(output.result.uncertainties).toEqual([INCIDENT_SOURCE_CAVEAT]);
  });
});

// ------------------------------------------------------- terminal resolution

describe('incident attempt end resolution', () => {
  const streamed = {
    budgetExpired: false,
    aborted: false,
    threw: false,
    oversize: false,
    sdkResult: resultMessage(),
    modelText: `here it is\n${markerPayload()}`,
  };

  it('accepts a conclusion only from a stream that actually finished', () => {
    expect(resolveIncidentAttemptEnd(streamed)).toEqual({ kind: 'model_final', text: streamed.modelText });
  });

  it('refuses a syntactically perfect marker from a stream that ended early', () => {
    // The iterator stopped before the SDK reported a result. The marker line
    // parses, so nothing downstream would notice — but the model never finished
    // writing, and a half-qualified conclusion is not a conclusion.
    const truncated = { ...streamed, sdkResult: null };

    expect(resolveIncidentAttemptEnd(truncated)).toEqual({ kind: 'no_conclusion' });

    const output = buildIncidentAttemptOutput(
      REQUEST,
      resolveIncidentAttemptEnd(truncated),
      registryWith().verifiedAt(NOW),
    );
    expect(output.result.status).toBe('inconclusive');
    expect(output.result.summary).toContain('missing_marker');
    expect(output.result.evidence).toEqual([]);
  });

  it('lets host observations outrank whatever the stream looked like', () => {
    // A budget abort reaches the loop as an ordinary stream end carrying text.
    expect(resolveIncidentAttemptEnd({ ...streamed, budgetExpired: true, aborted: true })).toEqual({
      kind: 'budget_expired',
    });
    expect(resolveIncidentAttemptEnd({ ...streamed, aborted: true })).toEqual({ kind: 'aborted' });
    expect(resolveIncidentAttemptEnd({ ...streamed, threw: true })).toEqual({ kind: 'stream_error' });
    expect(
      resolveIncidentAttemptEnd({
        ...streamed,
        sdkResult: resultMessage({ subtype: 'error_max_turns', is_error: true }),
      }),
    ).toEqual({ kind: 'run_error' });
    expect(resolveIncidentAttemptEnd({ ...streamed, modelText: '   ' })).toEqual({ kind: 'no_conclusion' });
    expect(resolveIncidentAttemptEnd({ ...streamed, oversize: true })).toEqual({ kind: 'oversize' });
  });
});

// ------------------------------------------------------------ the whole loop

/**
 * Host-level tests: the real `screenIncidentStream` over a fake SDK stream.
 *
 * These are not a substitute for an integration test through
 * `ClaudeHandler.streamQuery` (that needs a lease and a real child process);
 * they cover the layer the handler delegates to, which is where every
 * decision about what reaches the thread is made.
 */
describe('incident stream, end to end over a fake SDK stream', () => {
  function hooks(overrides: Partial<Parameters<typeof screenIncidentStream>[1]> = {}) {
    const finished: string[] = [];
    const registry = registryWith();
    return {
      finished,
      hooks: {
        request: REQUEST,
        verifiedEvidence: () => registry.verifiedAt(NOW),
        sourceCaveat: () => registry.sourceCaveat(),
        observe: () => ({ budgetExpired: false, aborted: false }),
        identity: () => ({ sessionId: 'sdk-session', model: 'claude-fable-5-1' }),
        onFinished: () => finished.push('finished'),
        uuid: () => 'uuid-fixed',
        ...overrides,
      } as Parameters<typeof screenIncidentStream>[1],
    };
  }

  async function* stream(...messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
    for (const message of messages) yield message;
  }

  async function drain(source: AsyncIterable<SDKMessage>, wiring: Parameters<typeof screenIncidentStream>[1]) {
    const out: SDKMessage[] = [];
    for await (const message of screenIncidentStream(source, wiring)) out.push(message);
    return out;
  }

  /** Everything that ever reaches the thread, as one blob. */
  function emittedText(messages: SDKMessage[]): string {
    return JSON.stringify(messages);
  }

  it('lets no raw model text out, and closes the attempt exactly once, at the end', async () => {
    const { hooks: wiring, finished } = hooks();
    // A conclusion the host must refuse: it claims success on a record nobody
    // collected, and it narrates an action the attempt could not have taken.
    const forged = `I restarted the host and confirmed recovery\n${markerPayload({
      evidence: [{ id: CHECK_REF, observed_at: OBSERVED_AT }],
    })}`;

    const emitted = await drain(
      stream(
        assistantMessage([{ type: 'text', text: forged }]),
        assistantMessage([{ type: 'tool_use', id: 'tu_1', name: 'mcp__incident_evidence__collect', input: {} }]),
        userMessage([{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: RAW_EVIDENCE_SENTINEL }]),
        resultMessage({ result: `${forged}\nraw tail` }),
      ),
      wiring,
    );

    // Three forwarded runtime messages (the text-stripped assistant, which still
    // carries usage; the tool call; the tool result reduced to a fixed line)
    // then the host's terminal pair. The forged marker, its prose and the raw
    // evidence blob survive in none of them.
    expect(emitted).toHaveLength(5);
    expect(emittedText(emitted.slice(0, 3))).not.toContain(INCIDENT_RESULT_MARKER);
    expect(emittedText(emitted)).not.toContain('restarted the host');
    expect(emittedText(emitted)).not.toContain('raw tail');
    expect(emittedText(emitted)).not.toContain(CHECK_REF);
    expect(emittedText(emitted)).not.toContain('__raw_evidence_sentinel__');

    const finalText = (emitted[4] as unknown as { result: string }).result;
    expect(markerLines(finalText)).toHaveLength(1);
    expect(finalText).toContain('"status":"inconclusive"');
    expect(finalText).toContain('unknown_evidence_id');
    expect(finished).toEqual(['finished']);
  });

  it('closes the attempt even when the consumer walks away mid-stream', async () => {
    const { hooks: wiring, finished } = hooks();
    const source = stream(
      assistantMessage([{ type: 'tool_use', id: 'tu_1', name: 'mcp__incident_evidence__collect', input: {} }]),
      resultMessage(),
    );

    // Read one message, then abandon the generator — the marker the ingress
    // needs must still be written.
    for await (const _message of screenIncidentStream(source, wiring)) break;

    expect(finished).toEqual(['finished']);
  });

  it('turns a throwing stream into a host terminal instead of propagating it', async () => {
    const seen: unknown[] = [];
    const { hooks: wiring, finished } = hooks({ onStreamError: (error) => seen.push(error) });
    async function* failing(): AsyncGenerator<SDKMessage> {
      yield assistantMessage([{ type: 'text', text: markerPayload() }]);
      throw new Error('CLAUDE_CODE_OAUTH_TOKEN=sk-abcdefghijklmnopqrstuvwx rejected');
    }

    const emitted = await drain(failing(), wiring);

    expect(seen).toHaveLength(1);
    expect(emittedText(emitted)).not.toContain('sk-abcdefghijklmnop');
    const finalText = (emitted[emitted.length - 1] as unknown as { result: string }).result;
    expect(finalText).toContain('model_unavailable');
    expect(finished).toEqual(['finished']);
  });

  it('refuses a conclusion buried in more prose than the host will buffer', async () => {
    const { hooks: wiring } = hooks();
    const flood = 'x'.repeat(MAX_MODEL_TEXT_CHARS + 1);

    const emitted = await drain(
      stream(assistantMessage([{ type: 'text', text: `${flood}\n${markerPayload()}` }]), resultMessage()),
      wiring,
    );

    const finalText = (emitted[emitted.length - 1] as unknown as { result: string }).result;
    expect(finalText).toContain('message_too_large');
    expect(finalText).not.toContain('xxxxxxxxxx');
  });

  it('reports a budget expiry as interrupted, whatever the stream managed to say', async () => {
    const { hooks: wiring } = hooks({ observe: () => ({ budgetExpired: true, aborted: true }) });

    const emitted = await drain(
      stream(assistantMessage([{ type: 'text', text: markerPayload() }]), resultMessage()),
      wiring,
    );

    const finalText = (emitted[emitted.length - 1] as unknown as { result: string }).result;
    expect(finalText).toContain('model_timeout');
    expect(finalText).toContain('"status":"interrupted"');
  });
});

// ------------------------------------------------------------- SDK terminal

describe('incident terminal messages', () => {
  it('emits one assistant message and one result carrying the identical validated text', () => {
    const output = buildIncidentAttemptOutput(
      REQUEST,
      { kind: 'model_final', text: markerPayload() },
      registryWith().verifiedAt(NOW),
    );

    const messages = buildIncidentTerminalMessages(output, {
      sessionId: 'sdk-session',
      model: 'claude-fable-5-1',
      sdkResult: resultMessage(),
      uuid: () => 'uuid-fixed',
    });

    const assistantText = (messages.assistant as unknown as { message: { content: Array<{ text: string }> } }).message
      .content[0].text;
    const resultText = (messages.result as unknown as { result: string }).result;

    expect(assistantText).toBe(output.text);
    expect(resultText).toBe(output.text);
    expect(resultText).not.toContain('raw model final text');
  });

  it('preserves the run’s accounting and reports success at the SDK level so nothing auto-retries', () => {
    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'run_error' }, []);

    const messages = buildIncidentTerminalMessages(output, {
      sessionId: 'sdk-session',
      sdkResult: resultMessage({ subtype: 'error_max_turns', is_error: true, errors: ['turn budget exhausted'] }),
      uuid: () => 'uuid-fixed',
    });
    const result = messages.result as unknown as Record<string, unknown>;

    expect(result.subtype).toBe('success');
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBe(0.0123);
    expect(result.usage).toEqual({ input_tokens: 900, output_tokens: 250 });
    expect(JSON.stringify(result)).not.toContain('turn budget exhausted');
    expect(output.result.status).toBe('failed');
  });

  it('still authors a terminal pair when the stream never produced a result message', () => {
    const output = buildIncidentAttemptOutput(REQUEST, { kind: 'stream_error' }, []);

    const messages = buildIncidentTerminalMessages(output, { sessionId: 'sdk-session', uuid: () => 'uuid-fixed' });
    const result = messages.result as unknown as Record<string, unknown>;

    expect(result.total_cost_usd).toBe(0);
    expect(markerLines(result.result as string)).toHaveLength(1);
  });
});
