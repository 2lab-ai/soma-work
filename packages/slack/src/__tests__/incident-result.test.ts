/**
 * Eagle incident *result* contract — decoding a model-authored conclusion into a
 * host-owned, wire-ready result, and rendering that result back onto one Slack
 * line.
 *
 * Threat model: the conclusion text is model output, i.e. untrusted. It may not
 * choose correlation ids (the host fixes them from the accepted request), it may
 * not invent evidence (every reference must match an evidence record the host
 * actually collected), and it may not claim success without host-verified
 * evidence plus a complete proposal — a bare claim is downgraded to an explicit
 * `inconclusive` result rather than passing as success.
 *
 * Evidence facts are *host snapshots*: the model's prose for a known id is
 * discarded and replaced by the host's recorded fact, observed at the host's
 * recorded time. This module never claims the fact is still true now.
 *
 * Tests run the real decoder/renderer — no mocks.
 */
import { describe, expect, it } from 'vitest';
import type { IncidentRequest } from '../incident-contract';
import {
  buildHostFailureResult,
  decodeIncidentConclusion,
  type IncidentConclusionDecode,
  type IncidentEvidenceRecord,
  type IncidentResult,
  type IncidentResultErrorReason,
  type IncidentResultField,
  renderIncidentResult,
  validateIncidentResultWire,
} from '../incident-result';

/** Byte length as the Rust side measures it. Hand-computed in tests, not via the module. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

const REQUEST: IncidentRequest = {
  version: 1,
  incident_id: 'inc-2026-09-11-001',
  lifecycle_id: '1757500000.000100',
  attempt_id: 'att-2',
  channel_id: 'C01INCIDENTS',
  parent_ts: '1757500000.000100',
  env: 'stage2',
  summary: 'gucci stage2 deploy failed on the migration step',
};

const HOST_EVIDENCE: IncidentEvidenceRecord[] = [
  {
    id: 'ev-1',
    observed_at: '2026-09-11T10:19:05.405Z',
    fact: 'deploy job 4471 exited 1 at step "ef-migrate"',
  },
  {
    id: 'ev-2',
    observed_at: '2026-09-11T10:20:00Z',
    fact: '__EFMigrationsHistory head is 20260904_AddOrderIndex',
  },
];

/** Hand-written conclusion payload, shaped like the Rust contract. */
function conclusion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    status: 'succeeded',
    summary: 'migration step failed because the head migration was already applied',
    evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: 'the model retelling of ev-1' }],
    proposal: {
      id: 'prop-1',
      action: 'rerun deploy with __EFMigrationsHistory reconciled',
      risk: 'medium — touches stage2 database state',
      rollback: 'restore the pre-deploy snapshot taken at 10:05Z',
      verification: 'deploy job exits 0 and /health reports the new build id',
    },
    uncertainties: ['unclear whether the snapshot predates the failed attempt'],
    ...overrides,
  };
}

/** Marker literal spelled out on purpose — tests must not follow the module constant. */
function markerLine(body: unknown = conclusion()): string {
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  return `EAGLE_INCIDENT_RESULT: ${rendered}`;
}

function decode(body: unknown = conclusion(), evidence: IncidentEvidenceRecord[] = HOST_EVIDENCE) {
  return decodeIncidentConclusion(markerLine(body), REQUEST, evidence);
}

function expectError(
  decoded: IncidentConclusionDecode,
  reason: IncidentResultErrorReason,
  field?: IncidentResultField,
): void {
  expect(decoded).toEqual({
    ok: false,
    error: field === undefined ? { reason } : { reason, field },
  });
}

function expectOk(decoded: IncidentConclusionDecode): IncidentResult {
  if (!decoded.ok) {
    throw new Error(`expected ok, got ${decoded.error.reason}`);
  }
  return decoded.result;
}

describe('decodeIncidentConclusion — correlation ids belong to the host', () => {
  it('stamps the request ids onto the result when the model omits them', () => {
    const result = expectOk(decode());
    expect(result.incident_id).toBe('inc-2026-09-11-001');
    expect(result.lifecycle_id).toBe('1757500000.000100');
    expect(result.attempt_id).toBe('att-2');
  });

  it('accepts a model that echoes the correct ids', () => {
    const result = expectOk(
      decode(
        conclusion({
          incident_id: 'inc-2026-09-11-001',
          lifecycle_id: '1757500000.000100',
          attempt_id: 'att-2',
        }),
      ),
    );
    expect(result.incident_id).toBe('inc-2026-09-11-001');
  });

  it('rejects a forged incident_id instead of taking the model at its word', () => {
    // Break: letting the model choose correlation ids lets one attempt write a
    // result into another incident's lifecycle.
    expectError(decode(conclusion({ incident_id: 'inc-2026-09-11-999' })), 'identity_mismatch', 'incident_id');
  });

  it('rejects a forged lifecycle_id or attempt_id', () => {
    expectError(decode(conclusion({ lifecycle_id: '1757599999.000100' })), 'identity_mismatch', 'lifecycle_id');
    expectError(decode(conclusion({ attempt_id: 'att-99' })), 'identity_mismatch', 'attempt_id');
  });
});

describe('decodeIncidentConclusion — evidence must be host-collected', () => {
  it('rejects an invented evidence id', () => {
    // Break: accepting arbitrary references lets the model fabricate proof.
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-made-up', observed_at: '2026-09-11T10:19:05.405Z' }] })),
      'unknown_evidence_id',
      'evidence.id',
    );
  });

  it('rejects a known id carrying a different observation time', () => {
    // Break: a stale/forged timestamp would let an old observation be presented
    // as a fresh one.
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-1', observed_at: '2026-09-11T09:00:00.000Z' }] })),
      'stale_evidence_reference',
      'evidence.observed_at',
    );
  });

  it('rejects the same evidence id referenced twice', () => {
    expectError(
      decode(
        conclusion({
          evidence: [
            { id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z' },
            { id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z' },
          ],
        }),
      ),
      'duplicate_evidence_id',
      'evidence.id',
    );
  });

  it('rejects a non-ISO observation time before matching it', () => {
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-1', observed_at: 'this morning' }] })),
      'invalid_field_format',
      'evidence.observed_at',
    );
  });

  it('rejects an ISO-shaped time that is not a real calendar day', () => {
    // Date.parse('2026-02-30T00:00:00Z') silently rolls to March 2 — a shape-only
    // check would let that through.
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-1', observed_at: '2026-02-30T00:00:00Z' }] })),
      'invalid_field_format',
      'evidence.observed_at',
    );
  });

  it('rejects an evidence entry with an unknown key', () => {
    const decoded = decode(
      conclusion({
        evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', source_url: 'https://evil.example' }],
      }),
    );
    expectError(decoded, 'unknown_field', 'evidence');
    expect(JSON.stringify(decoded)).not.toContain('source_url');
  });

  it('rejects an evidence list longer than 10', () => {
    const many = Array.from({ length: 11 }, () => ({ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z' }));
    expectError(decode(conclusion({ evidence: many })), 'too_many_items', 'evidence');
  });

  it('accepts exactly 10 references to distinct host records', () => {
    const records: IncidentEvidenceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ev-${i}`,
      observed_at: '2026-09-11T10:19:05.405Z',
      fact: `host fact ${i}`,
    }));
    const result = expectOk(
      decode(conclusion({ evidence: records.map((r) => ({ id: r.id, observed_at: r.observed_at })) }), records),
    );
    expect(result.evidence).toHaveLength(10);
  });
});

describe('decodeIncidentConclusion — evidence facts are host snapshots', () => {
  it('replaces the model prose with the host observation record', () => {
    // Break: keeping the model's retelling would let a summary of evidence pass
    // as the evidence itself. The host cannot cryptographically vouch for a fact,
    // so it publishes only what it recorded.
    const result = expectOk(decode());
    expect(result.evidence).toEqual([
      {
        id: 'ev-1',
        observed_at: '2026-09-11T10:19:05.405Z',
        fact: 'deploy job 4471 exited 1 at step "ef-migrate"',
      },
    ]);
  });

  it('accepts a reference that omits fact entirely', () => {
    const result = expectOk(decode(conclusion({ evidence: [{ id: 'ev-2', observed_at: '2026-09-11T10:20:00Z' }] })));
    expect(result.evidence[0].fact).toBe('__EFMigrationsHistory head is 20260904_AddOrderIndex');
  });

  it('carries the host observation time so downstream can judge staleness', () => {
    const result = expectOk(decode());
    expect(result.evidence[0].observed_at).toBe('2026-09-11T10:19:05.405Z');
  });
});

describe('decodeIncidentConclusion — success is earned, never claimed', () => {
  it('accepts succeeded with one host-verified fact and a complete proposal', () => {
    const decoded = decode();
    const result = expectOk(decoded);
    expect(result.status).toBe('succeeded');
    expect(result.proposal).toEqual({
      id: 'prop-1',
      action: 'rerun deploy with __EFMigrationsHistory reconciled',
      risk: 'medium — touches stage2 database state',
      rollback: 'restore the pre-deploy snapshot taken at 10:05Z',
      verification: 'deploy job exits 0 and /health reports the new build id',
    });
    expect(decoded.ok && decoded.downgrade).toBeUndefined();
  });

  it('downgrades succeeded-without-evidence to an explicit inconclusive result', () => {
    // Break: silently honouring the claim would publish "fixed" with no proof.
    const decoded = decode(conclusion({ evidence: [] }));
    const result = expectOk(decoded);
    expect(result.status).toBe('inconclusive');
    expect(decoded.ok && decoded.downgrade).toEqual({ from: 'succeeded', reason: 'missing_verified_evidence' });
  });

  it('downgrades succeeded-without-proposal to an explicit inconclusive result', () => {
    const decoded = decode(conclusion({ proposal: null }));
    const result = expectOk(decoded);
    expect(result.status).toBe('inconclusive');
    expect(decoded.ok && decoded.downgrade).toEqual({ from: 'succeeded', reason: 'missing_proposal' });
  });

  it('leaves a non-success status alone when evidence and proposal are absent', () => {
    const decoded = decode(conclusion({ status: 'running', evidence: [], proposal: null }));
    const result = expectOk(decoded);
    expect(result.status).toBe('running');
    expect(result.proposal).toBeNull();
    expect(decoded.ok && decoded.downgrade).toBeUndefined();
  });

  it('accepts every status in the contract', () => {
    for (const status of ['running', 'failed', 'interrupted', 'inconclusive'] as const) {
      expect(expectOk(decode(conclusion({ status }))).status).toBe(status);
    }
  });

  it('rejects a status outside the contract', () => {
    expectError(decode(conclusion({ status: 'done' })), 'unknown_status', 'status');
    expectError(decode(conclusion({ status: 'SUCCEEDED' })), 'unknown_status', 'status');
  });
});

describe('decodeIncidentConclusion — proposal shape', () => {
  it('rejects a proposal missing one of its five parts', () => {
    expectError(
      decode(conclusion({ proposal: { id: 'p', action: 'a', risk: 'r', verification: 'v' } })),
      'missing_field',
      'proposal.rollback',
    );
  });

  it('rejects an empty proposal part', () => {
    expectError(
      decode(conclusion({ proposal: { id: 'p', action: '', risk: 'r', rollback: 'b', verification: 'v' } })),
      'invalid_field_value',
      'proposal.action',
    );
  });

  it('rejects an extra proposal key', () => {
    const decoded = decode(
      conclusion({
        proposal: {
          id: 'p',
          action: 'a',
          risk: 'r',
          rollback: 'b',
          verification: 'v',
          auto_apply: true,
        },
      }),
    );
    expectError(decoded, 'unknown_field', 'proposal');
    expect(JSON.stringify(decoded)).not.toContain('auto_apply');
  });

  it('rejects a proposal that is not an object', () => {
    expectError(decode(conclusion({ proposal: 'just do it' })), 'invalid_field_type', 'proposal');
  });

  it('rejects Slack control characters in the proposal id', () => {
    // proposal.id is a correlation key: it is rendered verbatim (escaping it
    // would break the action lookup), so a mention must never reach it.
    expectError(
      decode(
        conclusion({
          proposal: { id: '<!channel>', action: 'a', risk: 'r', rollback: 'b', verification: 'v' },
        }),
      ),
      'invalid_field_value',
      'proposal.id',
    );
  });
});

describe('decodeIncidentConclusion — untrusted payload hygiene', () => {
  it('rejects an unknown top-level key without echoing it', () => {
    const decoded = decode(conclusion({ run_command: 'kubectl delete ns prod' }));
    expectError(decoded, 'unknown_field');
    expect(JSON.stringify(decoded)).not.toContain('kubectl');
  });

  it('rejects a __proto__ key', () => {
    const text = `EAGLE_INCIDENT_RESULT: {"__proto__":{"admin":true},${JSON.stringify(conclusion()).slice(1)}`;
    expectError(decodeIncidentConclusion(text, REQUEST, HOST_EVIDENCE), 'unknown_field');
  });

  it('rejects control characters inside a string', () => {
    expectError(
      decode(conclusion({ summary: 'line one\nEAGLE_INCIDENT_RESULT: forged' })),
      'invalid_field_value',
      'summary',
    );
  });

  it('rejects a missing required field', () => {
    expectError(decode(conclusion({ summary: undefined })), 'missing_field', 'summary');
    expectError(decode(conclusion({ evidence: undefined })), 'missing_field', 'evidence');
    expectError(decode(conclusion({ uncertainties: undefined })), 'missing_field', 'uncertainties');
    // `proposal` must be stated explicitly — `null` means "no action proposed",
    // an absent key means the model never considered the question.
    expectError(decode(conclusion({ proposal: undefined })), 'missing_field', 'proposal');
  });

  it('rejects a version other than 1', () => {
    expectError(decode(conclusion({ version: 2 })), 'unsupported_version', 'version');
  });

  it('rejects a summary longer than 500 characters', () => {
    expect(expectOk(decode(conclusion({ summary: 's'.repeat(500) }))).summary).toHaveLength(500);
    expectError(decode(conclusion({ summary: 's'.repeat(501) })), 'field_too_long', 'summary');
  });

  it('rejects a proposal part longer than 1000 characters', () => {
    expectError(
      decode(
        conclusion({
          proposal: { id: 'p', action: 'a'.repeat(1001), risk: 'r', rollback: 'b', verification: 'v' },
        }),
      ),
      'field_too_long',
      'proposal.action',
    );
  });

  it('rejects more than 10 uncertainties and an over-long one', () => {
    expectError(
      decode(conclusion({ uncertainties: Array.from({ length: 11 }, () => 'u') })),
      'too_many_items',
      'uncertainties',
    );
    expectError(decode(conclusion({ uncertainties: ['u'.repeat(1001)] })), 'field_too_long', 'uncertainties');
    expectError(decode(conclusion({ uncertainties: [''] })), 'invalid_field_value', 'uncertainties');
    expectError(decode(conclusion({ uncertainties: [42] })), 'invalid_field_type', 'uncertainties');
  });

  it('rejects a conclusion message larger than 16000 characters', () => {
    const line = markerLine();
    const text = `${'x'.repeat(16000 - line.length)}\n${line}`;
    expect(text.length).toBe(16001);
    expectError(decodeIncidentConclusion(text, REQUEST, HOST_EVIDENCE), 'message_too_large');
  });

  it('rejects a conclusion whose rendered result would exceed the wire bound', () => {
    // Per-field bounds alone do not bound the whole line: 10 host facts plus 10
    // maximal uncertainties render past 16000 chars.
    const records: IncidentEvidenceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ev-${i}`,
      observed_at: '2026-09-11T10:19:05.405Z',
      fact: 'f'.repeat(1000),
    }));
    const decoded = decode(
      conclusion({
        evidence: records.map((r) => ({ id: r.id, observed_at: r.observed_at })),
        uncertainties: Array.from({ length: 10 }, () => 'u'.repeat(1000)),
      }),
      records,
    );
    expectError(decoded, 'result_too_large');
  });

  it('rejects a missing, empty, duplicated or unparseable marker line', () => {
    expectError(decodeIncidentConclusion('no marker here', REQUEST, HOST_EVIDENCE), 'missing_marker');
    expectError(decodeIncidentConclusion('EAGLE_INCIDENT_RESULT:   ', REQUEST, HOST_EVIDENCE), 'malformed_marker_line');
    expectError(
      decodeIncidentConclusion(`${markerLine()}\n${markerLine()}`, REQUEST, HOST_EVIDENCE),
      'multiple_markers',
    );
    expectError(decodeIncidentConclusion(markerLine('{not json'), REQUEST, HOST_EVIDENCE), 'invalid_json');
    expectError(decodeIncidentConclusion(markerLine('[]'), REQUEST, HOST_EVIDENCE), 'payload_not_object');
  });

  it('accepts a marker preceded by model prose', () => {
    const text = ['Here is what I found.', '', markerLine()].join('\n');
    expect(expectOk(decodeIncidentConclusion(text, REQUEST, HOST_EVIDENCE)).status).toBe('succeeded');
  });
});

describe('renderIncidentResult', () => {
  it('emits one marker line whose JSON reparses to the same result', () => {
    const result = expectOk(decode());
    const line = renderIncidentResult(result);
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith('EAGLE_INCIDENT_RESULT: ')).toBe(true);
    const reparsed = JSON.parse(line.slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(reparsed.incident_id).toBe('inc-2026-09-11-001');
    expect(reparsed.status).toBe('succeeded');
    expect(reparsed.evidence[0].fact).toBe('deploy job 4471 exited 1 at step "ef-migrate"');
  });

  it('emits the Rust contract field order', () => {
    const line = renderIncidentResult(expectOk(decode()));
    const reparsed = JSON.parse(line.slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(Object.keys(reparsed)).toEqual([
      'version',
      'incident_id',
      'lifecycle_id',
      'attempt_id',
      'status',
      'summary',
      'evidence',
      'proposal',
      'uncertainties',
    ]);
  });

  it('escapes Slack control characters without breaking the JSON', () => {
    // Break: an unescaped <!channel> in a summary pages the whole workspace when
    // the host posts the result.
    const result: IncidentResult = {
      ...expectOk(decode()),
      summary: 'ping <!channel> & <@U01EAGLEBOT> about <https://x.example|this>',
    };
    const line = renderIncidentResult(result);
    const reparsed = JSON.parse(line.slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(reparsed.summary).toBe(
      'ping &lt;!channel&gt; &amp; &lt;@U01EAGLEBOT&gt; about &lt;https://x.example|this&gt;',
    );
    expect(line).not.toContain('<!channel>');
  });

  it('escapes nested evidence, proposal and uncertainty strings too', () => {
    const result: IncidentResult = {
      ...expectOk(decode()),
      evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: 'saw <@U09HUMAN> & friends' }],
      uncertainties: ['<!here> might matter'],
    };
    const reparsed = JSON.parse(renderIncidentResult(result).slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(reparsed.evidence[0].fact).toBe('saw &lt;@U09HUMAN&gt; &amp; friends');
    expect(reparsed.uncertainties[0]).toBe('&lt;!here&gt; might matter');
    expect(reparsed.proposal.risk).toBe('medium — touches stage2 database state');
  });

  it('leaves correlation keys verbatim so the host can still match them', () => {
    // Escaping ids would break request/result correlation and the action lookup;
    // decode is what keeps mentions out of those fields.
    const reparsed = JSON.parse(renderIncidentResult(expectOk(decode())).slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(reparsed.incident_id).toBe('inc-2026-09-11-001');
    expect(reparsed.lifecycle_id).toBe('1757500000.000100');
    expect(reparsed.evidence[0].id).toBe('ev-1');
    expect(reparsed.evidence[0].observed_at).toBe('2026-09-11T10:19:05.405Z');
    expect(reparsed.proposal.id).toBe('prop-1');
  });

  it('keeps a host string containing a newline on a single line', () => {
    const result: IncidentResult = { ...expectOk(decode()), summary: 'first\nsecond' };
    const line = renderIncidentResult(result);
    expect(line.split('\n')).toHaveLength(1);
    expect(JSON.parse(line.slice('EAGLE_INCIDENT_RESULT: '.length)).summary).toBe('first\nsecond');
  });

  it('stays within the 16384-byte wire bound for any accepted result', () => {
    const records: IncidentEvidenceRecord[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ev-${i}`,
      observed_at: '2026-09-11T10:19:05.405Z',
      fact: 'f'.repeat(500),
    }));
    const result = expectOk(
      decode(
        conclusion({
          evidence: records.map((r) => ({ id: r.id, observed_at: r.observed_at })),
          uncertainties: Array.from({ length: 10 }, () => 'u'.repeat(300)),
        }),
        records,
      ),
    );
    expect(utf8Bytes(renderIncidentResult(result))).toBeLessThanOrEqual(16384);
  });
});

describe('validateIncidentResultWire — the outbound gate the Rust side enforces', () => {
  const korean = '가'.repeat(950); // 950 codepoints, 2850 UTF-8 bytes
  // Single codepoint, 2 UTF-16 units, 4 UTF-8 bytes. (A composed emoji such as
  // '🛠️' is TWO codepoints — base plus variation selector — and would blur the
  // very distinction under test.)
  const emoji = '😀';

  it('rejects a line that exceeds 16384 UTF-8 bytes while its char count looks safe', () => {
    // Break: bounding `.length` passes 5700 Korean chars that weigh 17k+ bytes —
    // Rust rejects the frame and the result is lost after posting.
    const decoded = decode(conclusion({ uncertainties: Array.from({ length: 6 }, () => korean) }));
    expectError(decoded, 'result_too_large');

    const oversize: IncidentResult = {
      ...buildHostFailureResult(REQUEST, 'inconclusive', 'host_aborted'),
      uncertainties: Array.from({ length: 6 }, () => korean),
    };
    const line = renderIncidentResult(oversize);
    expect(line.length).toBeLessThan(16000); // char count says "fine"
    expect(utf8Bytes(line)).toBeGreaterThan(16384); // bytes say otherwise
    expect(validateIncidentResultWire(oversize)).toEqual({
      ok: false,
      error: { reason: 'result_too_large' },
    });
  });

  it('rejects a raw-999 string whose escaping expands past 1000 codepoints', () => {
    // '&' becomes '&amp;': 999 raw chars clear the raw bound but render as 1799.
    const expanding = `${'&'.repeat(200)}${'a'.repeat(799)}`;
    expect(expanding.length).toBe(999);
    expectError(decode(conclusion({ uncertainties: [expanding] })), 'field_too_long', 'uncertainties');
    expectError(
      decode(
        conclusion({
          proposal: { id: 'p', action: expanding, risk: 'r', rollback: 'b', verification: 'v' },
        }),
      ),
      'field_too_long',
      'proposal.action',
    );
  });

  it('rejects an over-long host evidence fact that no model input could reveal', () => {
    // Break: host facts were never bounded — a 5000-char log line substituted into
    // the result would be emitted unchecked.
    const records: IncidentEvidenceRecord[] = [
      { id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: 'f'.repeat(5000) },
    ];
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z' }] }), records),
      'field_too_long',
      'evidence.fact',
    );
  });

  it('rejects a control character the host put in its own fact', () => {
    const records: IncidentEvidenceRecord[] = [
      { id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: 'line oneline two' },
    ];
    expectError(
      decode(conclusion({ evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z' }] }), records),
      'invalid_field_value',
      'evidence.fact',
    );
  });

  it('counts codepoints, not UTF-16 units, at the Korean and emoji boundaries', () => {
    // 500 emoji = 1000 UTF-16 units. Counting units would reject a summary Rust
    // accepts, since Rust counts chars.
    const summary500Emoji = emoji.repeat(500);
    expect(summary500Emoji.length).toBeGreaterThan(500);
    expect(expectOk(decode(conclusion({ summary: summary500Emoji }))).summary).toBe(summary500Emoji);

    const summary500Korean = '가'.repeat(500);
    expect(expectOk(decode(conclusion({ summary: summary500Korean }))).summary).toBe(summary500Korean);

    expectError(decode(conclusion({ summary: '가'.repeat(501) })), 'field_too_long', 'summary');
    expectError(decode(conclusion({ uncertainties: ['가'.repeat(1001)] })), 'field_too_long', 'uncertainties');
  });

  it('passes a short, safe result', () => {
    expect(validateIncidentResultWire(expectOk(decode()))).toEqual({ ok: true });
    expect(validateIncidentResultWire(buildHostFailureResult(REQUEST, 'failed', 'model_timeout'))).toEqual({
      ok: true,
    });
  });

  it('holds correlation ids to their own limits, not a blanket 1000', () => {
    // Break: a blanket bound lets a hand-built or amended result carry an id the
    // request contract would never have accepted, and Rust then rejects the line.
    const base = expectOk(decode());
    expect(validateIncidentResultWire({ ...base, incident_id: 'i'.repeat(256) })).toEqual({ ok: true });
    expect(validateIncidentResultWire({ ...base, incident_id: 'i'.repeat(257) })).toEqual({
      ok: false,
      error: { reason: 'field_too_long', field: 'incident_id' },
    });
    expect(validateIncidentResultWire({ ...base, lifecycle_id: 'l'.repeat(128) })).toEqual({ ok: true });
    expect(validateIncidentResultWire({ ...base, lifecycle_id: 'l'.repeat(129) })).toEqual({
      ok: false,
      error: { reason: 'field_too_long', field: 'lifecycle_id' },
    });
    expect(validateIncidentResultWire({ ...base, attempt_id: 'a'.repeat(128) })).toEqual({ ok: true });
    expect(validateIncidentResultWire({ ...base, attempt_id: 'a'.repeat(129) })).toEqual({
      ok: false,
      error: { reason: 'field_too_long', field: 'attempt_id' },
    });
  });

  it('validates observed_at on the standalone path, not only through decode', () => {
    // Break: decode checks the timestamp, so a result assembled or amended by hand
    // is exactly how a bogus observed_at would reach the wire unchallenged.
    const base = expectOk(decode());
    for (const observed of ['yesterday', '2026-02-30T00:00:00Z', '2026-09-11T10:19:05']) {
      expect(
        validateIncidentResultWire({
          ...base,
          evidence: [{ id: 'ev-1', observed_at: observed, fact: 'host fact' }],
        }),
      ).toEqual({ ok: false, error: { reason: 'invalid_field_format', field: 'evidence.observed_at' } });
    }
    expect(
      validateIncidentResultWire({
        ...base,
        evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: 'host fact' }],
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a whitespace-only evidence fact or id, as Rust does', () => {
    // Rust's validate_result rejects `ev.fact.trim().is_empty()`. A blank fact
    // clears every length bound here, so without this the line is accepted
    // locally and thrown out at the far end — evidence that proves nothing.
    const base = expectOk(decode());
    for (const blank of ['', '   ', '\t  ']) {
      expect(
        validateIncidentResultWire({
          ...base,
          evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: blank }],
        }),
      ).toEqual({ ok: false, error: { reason: 'invalid_field_value', field: 'evidence.fact' } });
    }
    expect(
      validateIncidentResultWire({
        ...base,
        evidence: [{ id: '   ', observed_at: '2026-09-11T10:19:05.405Z', fact: 'host fact' }],
      }),
    ).toEqual({ ok: false, error: { reason: 'invalid_field_value', field: 'evidence.id' } });

    // Padding around real content is fine — only blankness is rejected.
    expect(
      validateIncidentResultWire({
        ...base,
        evidence: [{ id: 'ev-1', observed_at: '2026-09-11T10:19:05.405Z', fact: '  real content  ' }],
      }),
    ).toEqual({ ok: true });
  });

  it('never lets a whitespace-only proposal part pass as success', () => {
    // Break: '   ' clears decode's empty-string check, so a "succeeded" result
    // could ship with an action nobody can act on.
    expectError(
      decode(conclusion({ proposal: { id: 'p', action: '   ', risk: 'r', rollback: 'b', verification: 'v' } })),
      'invalid_field_value',
      'proposal.action',
    );
    expectError(
      decode(conclusion({ proposal: { id: '  ', action: 'a', risk: 'r', rollback: 'b', verification: 'v' } })),
      'invalid_field_value',
      'proposal.id',
    );
    expectError(
      decode(conclusion({ proposal: { id: 'p', action: 'a', risk: 'r', rollback: '\t', verification: 'v' } })),
      'invalid_field_value',
      'proposal.rollback',
    );
  });

  it('rejects a hand-built result that skipped decode entirely', () => {
    // The validator is reusable on its own — e.g. after a caller appends a caveat
    // to an already-decoded result.
    const withCaveat: IncidentResult = {
      ...expectOk(decode()),
      summary: 's'.repeat(501),
    };
    expect(validateIncidentResultWire(withCaveat)).toEqual({
      ok: false,
      error: { reason: 'field_too_long', field: 'summary' },
    });
  });
});

describe('buildHostFailureResult', () => {
  it('produces a host-owned result with the request ids and no evidence', () => {
    const result = buildHostFailureResult(REQUEST, 'inconclusive', 'invalid_json');
    expect(result.version).toBe(1);
    expect(result.incident_id).toBe('inc-2026-09-11-001');
    expect(result.lifecycle_id).toBe('1757500000.000100');
    expect(result.attempt_id).toBe('att-2');
    expect(result.status).toBe('inconclusive');
    expect(result.evidence).toEqual([]);
    expect(result.proposal).toBeNull();
  });

  it('names the cause so the failure is explicit rather than silent', () => {
    // Break: a failure result that says nothing is indistinguishable from "no
    // problem found".
    expect(buildHostFailureResult(REQUEST, 'inconclusive', 'unknown_evidence_id').summary).toContain(
      'unknown_evidence_id',
    );
    expect(buildHostFailureResult(REQUEST, 'failed', 'model_timeout').summary).toContain('model_timeout');
  });

  it('renders onto a single marker line like any other result', () => {
    const line = renderIncidentResult(buildHostFailureResult(REQUEST, 'interrupted', 'host_aborted'));
    expect(line.split('\n')).toHaveLength(1);
    const reparsed = JSON.parse(line.slice('EAGLE_INCIDENT_RESULT: '.length));
    expect(reparsed.status).toBe('interrupted');
    expect(reparsed.evidence).toEqual([]);
    expect(reparsed.proposal).toBeNull();
  });
});
