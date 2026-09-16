/**
 * Eagle incident request contract — strict v1 parsing of the
 * `EAGLE_INCIDENT_REQUEST:` marker line, BEFORE any wiring.
 *
 * Why this exists: `event-router.ts:275` hands every `app_mention` to the
 * ordinary `messageHandler`, and `session-initializer.ts:725` opens a new root
 * thread unless an internal `routeContext.skipAutoBotThread` is set. Anything
 * that reaches those paths from Slack text is attacker-reachable, so the
 * incident receiver needs a parser that authenticates the *envelope* (team /
 * app / bot / channel / thread) and accepts nothing but the eight-field v1
 * schema — no URLs, no commands, no permissions, no options.
 *
 * These tests exercise the real parser (no mocks): it is a pure function over
 * a Slack event shape plus a server-side trusted-source config.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyIncidentRequest,
  type IncidentCandidateEvent,
  type IncidentClassification,
  type IncidentRejectReason,
  type IncidentRequestField,
  isUntrustedSenderRejection,
  type TrustedIncidentSource,
} from '../incident-contract';

const TRUSTED: TrustedIncidentSource = {
  teamId: 'T01TRUSTED',
  appId: 'A01EAGLE',
  botUserId: 'U01EAGLEBOT',
  botId: 'B01EAGLEBOT',
  channelIds: ['C01INCIDENTS', 'C02INCIDENTS'],
};

const PARENT_TS = '1757500000.000100';
const EVENT_TS = '1757500111.000200';

/** Canonical, hand-written v1 payload. Overrides set to `undefined` drop the key (JSON.stringify). */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    incident_id: 'inc-2026-09-11-001',
    lifecycle_id: 'lc-7f3a',
    attempt_id: 'att-2',
    channel_id: 'C01INCIDENTS',
    parent_ts: PARENT_TS,
    env: 'stage2',
    summary: 'proj stage2 deploy failed on the migration step',
    ...overrides,
  };
}

/** Marker literal is spelled out on purpose — the test must not follow the module's constant. */
function markerLine(body: unknown = payload()): string {
  const rendered = typeof body === 'string' ? body : JSON.stringify(body);
  return `EAGLE_INCIDENT_REQUEST: ${rendered}`;
}

function botEvent(overrides: Partial<IncidentCandidateEvent> = {}): IncidentCandidateEvent {
  return {
    text: markerLine(),
    team: 'T01TRUSTED',
    user: 'U01EAGLEBOT',
    app_id: 'A01EAGLE',
    bot_id: 'B01EAGLEBOT',
    channel: 'C01INCIDENTS',
    thread_ts: PARENT_TS,
    ts: EVENT_TS,
    ...overrides,
  };
}

function expectRejected(
  result: IncidentClassification,
  reason: IncidentRejectReason,
  field?: IncidentRequestField,
): void {
  expect(result).toEqual(field === undefined ? { kind: 'rejected', reason } : { kind: 'rejected', reason, field });
}

describe('classifyIncidentRequest — ordinary traffic stays untouched', () => {
  it('classifies a plain human message as non-incident', () => {
    // Break: a receiver that rejects (or accepts) ordinary chat would break every
    // existing app_mention / DM route.
    const result = classifyIncidentRequest(
      botEvent({ text: '@eagle 이거 왜 안 돼?', user: 'U09HUMAN', bot_id: undefined }),
      TRUSTED,
    );
    expect(result).toEqual({ kind: 'non-incident' });
  });

  it('classifies a message whose marker is mid-line as non-incident', () => {
    // Break: detecting with text.includes() instead of a line prefix lets a human
    // smuggle a request inside a sentence.
    const result = classifyIncidentRequest(
      botEvent({ text: `look at this EAGLE_INCIDENT_REQUEST: ${JSON.stringify(payload())}` }),
      TRUSTED,
    );
    expect(result).toEqual({ kind: 'non-incident' });
  });

  it('classifies an event without text as non-incident', () => {
    const result = classifyIncidentRequest(botEvent({ text: undefined }), TRUSTED);
    expect(result).toEqual({ kind: 'non-incident' });
  });

  it('classifies a non-string text payload as non-incident', () => {
    const result = classifyIncidentRequest(botEvent({ text: { blocks: [] } }), TRUSTED);
    expect(result).toEqual({ kind: 'non-incident' });
  });
});

describe('classifyIncidentRequest — trusted source config', () => {
  it('rejects a marker message when no trusted source is configured', () => {
    // Break: a receiver that defaults to "open" when config is missing.
    expectRejected(classifyIncidentRequest(botEvent(), undefined), 'receiver_disabled');
    expectRejected(classifyIncidentRequest(botEvent(), null), 'receiver_disabled');
  });

  it('rejects when a trusted-source field is empty', () => {
    expectRejected(classifyIncidentRequest(botEvent(), { ...TRUSTED, botId: '' }), 'invalid_trusted_source');
    expectRejected(classifyIncidentRequest(botEvent(), { ...TRUSTED, teamId: '' }), 'invalid_trusted_source');
  });

  it('rejects when the trusted channel list is empty', () => {
    expectRejected(classifyIncidentRequest(botEvent(), { ...TRUSTED, channelIds: [] }), 'invalid_trusted_source');
  });

  it('rejects a wildcard channel entry instead of honouring it', () => {
    // Break: '*' silently meaning "every channel" turns one config typo into a
    // workspace-wide command surface.
    expectRejected(classifyIncidentRequest(botEvent(), { ...TRUSTED, channelIds: ['*'] }), 'invalid_trusted_source');
    expectRejected(
      classifyIncidentRequest(botEvent(), { ...TRUSTED, channelIds: ['C01INCIDENTS', 'C*'] }),
      'invalid_trusted_source',
    );
  });
});

describe('classifyIncidentRequest — envelope authentication', () => {
  it('rejects a marker from another workspace', () => {
    expectRejected(classifyIncidentRequest(botEvent({ team: 'T99OTHER' }), TRUSTED), 'untrusted_team');
  });

  it('rejects a marker from a different Slack app', () => {
    expectRejected(classifyIncidentRequest(botEvent({ app_id: 'A99OTHER' }), TRUSTED), 'untrusted_app');
  });

  it('rejects a marker from another bot', () => {
    expectRejected(classifyIncidentRequest(botEvent({ bot_id: 'B99OTHER' }), TRUSTED), 'untrusted_bot');
  });

  it('rejects a marker typed by a human (no bot_id)', () => {
    // Break: the whole point of the contract — a person must not be able to open
    // an incident lifecycle by typing the marker.
    expectRejected(
      classifyIncidentRequest(botEvent({ bot_id: undefined, user: 'U09HUMAN' }), TRUSTED),
      'untrusted_bot',
    );
  });

  it('rejects a marker with no sender user (incoming webhook)', () => {
    expectRejected(classifyIncidentRequest(botEvent({ user: undefined }), TRUSTED), 'missing_sender_identity');
  });

  it('rejects a marker whose user is not the trusted bot user', () => {
    expectRejected(classifyIncidentRequest(botEvent({ user: 'U09HUMAN' }), TRUSTED), 'untrusted_user');
  });

  it('rejects a marker on an event carrying no channel', () => {
    // Break: defaulting a missing channel to anything (including the first
    // configured one) accepts an event that never proved where it came from.
    expectRejected(classifyIncidentRequest(botEvent({ channel: undefined }), TRUSTED), 'untrusted_channel');
  });

  it('rejects a marker posted in a channel outside the trusted list', () => {
    expectRejected(
      classifyIncidentRequest(
        botEvent({ channel: 'C88RANDOM', text: markerLine(payload({ channel_id: 'C88RANDOM' })) }),
        TRUSTED,
      ),
      'untrusted_channel',
    );
  });

  it('accepts a marker in the second configured channel', () => {
    const result = classifyIncidentRequest(
      botEvent({ channel: 'C02INCIDENTS', text: markerLine(payload({ channel_id: 'C02INCIDENTS' })) }),
      TRUSTED,
    );
    expect(result.kind).toBe('accepted');
  });

  it('never lets the payload stand in for envelope identity', () => {
    // Break: reading channel_id (or any payload field) as the trust anchor lets an
    // untrusted channel claim a trusted one.
    expectRejected(
      classifyIncidentRequest(
        botEvent({ channel: 'C88RANDOM', text: markerLine(payload({ channel_id: 'C01INCIDENTS' })) }),
        TRUSTED,
      ),
      'untrusted_channel',
    );
  });
});

describe('classifyIncidentRequest — thread placement', () => {
  it('rejects a marker posted at channel root (no thread_ts)', () => {
    expectRejected(classifyIncidentRequest(botEvent({ thread_ts: undefined }), TRUSTED), 'not_in_thread');
  });

  it('rejects a marker that is its own thread parent', () => {
    // A message whose thread_ts equals its ts is a root, not a reply into an
    // existing incident thread.
    expectRejected(classifyIncidentRequest(botEvent({ thread_ts: EVENT_TS }), TRUSTED), 'not_in_thread');
  });

  it('rejects an event with no ts', () => {
    expectRejected(classifyIncidentRequest(botEvent({ ts: undefined }), TRUSTED), 'missing_event_ts');
  });
});

describe('classifyIncidentRequest — marker line shape', () => {
  it('accepts a marker preceded by a mention line and a human description', () => {
    const text = ['<@U01EAGLEBOT>', 'stage2 deploy broke — see below', markerLine()].join('\n');
    const result = classifyIncidentRequest(botEvent({ text }), TRUSTED);
    expect(result.kind).toBe('accepted');
  });

  it('rejects a message carrying two marker lines', () => {
    // Break: parsing only the first marker would let a second request ride along
    // unexamined.
    const text = [markerLine(), markerLine(payload({ attempt_id: 'att-3' }))].join('\n');
    expectRejected(classifyIncidentRequest(botEvent({ text }), TRUSTED), 'multiple_markers');
  });

  it('rejects a marker line with nothing after the prefix', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: 'EAGLE_INCIDENT_REQUEST:   ' }), TRUSTED),
      'malformed_marker_line',
    );
  });

  it('rejects a malformed marker rather than falling back to ordinary handling', () => {
    // Break: a try/catch that returns non-incident on parse failure would route a
    // broken request into the normal message path.
    const result = classifyIncidentRequest(botEvent({ text: markerLine('{not json') }), TRUSTED);
    expect(result.kind).toBe('rejected');
    expectRejected(result, 'invalid_json');
  });

  it('rejects trailing text after the JSON object', () => {
    expectRejected(
      classifyIncidentRequest(
        botEvent({ text: markerLine(`${JSON.stringify(payload())} and please deploy`) }),
        TRUSTED,
      ),
      'invalid_json',
    );
  });

  it('rejects a JSON payload that is not an object', () => {
    expectRejected(classifyIncidentRequest(botEvent({ text: markerLine([payload()]) }), TRUSTED), 'payload_not_object');
    expectRejected(classifyIncidentRequest(botEvent({ text: markerLine('"inc-1"') }), TRUSTED), 'payload_not_object');
    expectRejected(classifyIncidentRequest(botEvent({ text: markerLine('null') }), TRUSTED), 'payload_not_object');
  });

  it('rejects a JSON object spread over several lines', () => {
    // The contract is one line: a multi-line object leaves a dangling `{` on the
    // marker line and JSON garbage on the next.
    const text = `EAGLE_INCIDENT_REQUEST: {\n${JSON.stringify(payload()).slice(1)}`;
    expectRejected(classifyIncidentRequest(botEvent({ text }), TRUSTED), 'invalid_json');
  });

  it('rejects a message longer than 4096 characters', () => {
    const line = markerLine();
    const text = `${'x'.repeat(4096 - line.length)}\n${line}`;
    expect(text.length).toBe(4097);
    expectRejected(classifyIncidentRequest(botEvent({ text }), TRUSTED), 'message_too_large');
  });

  it('accepts a message of exactly 4096 characters', () => {
    const line = markerLine();
    const text = `${'x'.repeat(4096 - line.length - 1)}\n${line}`;
    expect(text.length).toBe(4096);
    expect(classifyIncidentRequest(botEvent({ text }), TRUSTED).kind).toBe('accepted');
  });
});

describe('classifyIncidentRequest — v1 schema', () => {
  it('rejects unknown keys without echoing the key name', () => {
    // Break: tolerating extra keys is how url / command / permission fields get in.
    const result = classifyIncidentRequest(
      botEvent({ text: markerLine(payload({ run_command: 'rm -rf /' })) }),
      TRUSTED,
    );
    expectRejected(result, 'unknown_field');
    expect(JSON.stringify(result)).not.toContain('run_command');
  });

  it('rejects an options-style key', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ options: { autoApprove: true } })) }), TRUSTED),
      'unknown_field',
    );
  });

  it('rejects a __proto__ key', () => {
    const text = `EAGLE_INCIDENT_REQUEST: {"__proto__":{"admin":true},${JSON.stringify(payload()).slice(1)}`;
    expectRejected(classifyIncidentRequest(botEvent({ text }), TRUSTED), 'unknown_field');
  });

  it('rejects a missing required field', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ incident_id: undefined })) }), TRUSTED),
      'missing_field',
      'incident_id',
    );
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ summary: undefined })) }), TRUSTED),
      'missing_field',
      'summary',
    );
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ version: undefined })) }), TRUSTED),
      'missing_field',
      'version',
    );
  });

  it('rejects any version other than the number 1', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ version: 2 })) }), TRUSTED),
      'unsupported_version',
      'version',
    );
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ version: '1' })) }), TRUSTED),
      'unsupported_version',
      'version',
    );
  });

  it('rejects a non-string field', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ summary: 42 })) }), TRUSTED),
      'invalid_field_type',
      'summary',
    );
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ incident_id: { id: 'x' } })) }), TRUSTED),
      'invalid_field_type',
      'incident_id',
    );
  });

  it('rejects an empty id or env', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ lifecycle_id: '' })) }), TRUSTED),
      'invalid_field_value',
      'lifecycle_id',
    );
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ env: '' })) }), TRUSTED),
      'invalid_field_value',
      'env',
    );
  });

  it('rejects control characters inside an opaque id', () => {
    // Break: an id carrying \n forges extra lines in whatever log or Slack post
    // renders it later.
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ attempt_id: 'att\n2' })) }), TRUSTED),
      'invalid_field_value',
      'attempt_id',
    );
  });

  it('accepts a 256-character incident_id but rejects 257', () => {
    // incident_id carries the producer's TriageIssue identity, which can run past
    // 128 chars; it is still bounded on this side.
    expect(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ incident_id: 'i'.repeat(256) })) }), TRUSTED).kind,
    ).toBe('accepted');
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ incident_id: 'i'.repeat(257) })) }), TRUSTED),
      'field_too_long',
      'incident_id',
    );
  });

  it('accepts a 128-character lifecycle/attempt id but rejects 129', () => {
    expect(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ lifecycle_id: 'l'.repeat(128) })) }), TRUSTED).kind,
    ).toBe('accepted');
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ attempt_id: 'a'.repeat(129) })) }), TRUSTED),
      'field_too_long',
      'attempt_id',
    );
  });

  it('accepts a lifecycle_id that is the parent Slack timestamp', () => {
    // Protocol reality: the producer sets lifecycle_id = parent_ts. The parser
    // keeps ids opaque, so a ts-shaped id must pass unchanged.
    const result = classifyIncidentRequest(
      botEvent({ text: markerLine(payload({ lifecycle_id: PARENT_TS })) }),
      TRUSTED,
    );
    expect(result).toEqual({
      kind: 'accepted',
      request: {
        version: 1,
        incident_id: 'inc-2026-09-11-001',
        lifecycle_id: '1757500000.000100',
        attempt_id: 'att-2',
        channel_id: 'C01INCIDENTS',
        parent_ts: '1757500000.000100',
        env: 'stage2',
        summary: 'proj stage2 deploy failed on the migration step',
      },
    });
  });

  it('accepts a 500-character summary but rejects 501', () => {
    expect(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ summary: 's'.repeat(500) })) }), TRUSTED).kind,
    ).toBe('accepted');
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ summary: 's'.repeat(501) })) }), TRUSTED),
      'field_too_long',
      'summary',
    );
  });

  it('rejects an over-long env', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ env: 'e'.repeat(65) })) }), TRUSTED),
      'field_too_long',
      'env',
    );
  });

  it('rejects a channel_id that is not a Slack channel id', () => {
    expectRejected(
      classifyIncidentRequest(
        botEvent({ text: markerLine(payload({ channel_id: 'https://evil.example/hook' })) }),
        TRUSTED,
      ),
      'invalid_field_format',
      'channel_id',
    );
  });

  it('rejects a parent_ts that is not a Slack timestamp', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ parent_ts: 'yesterday' })) }), TRUSTED),
      'invalid_field_format',
      'parent_ts',
    );
  });
});

describe('classifyIncidentRequest — envelope binding of the payload', () => {
  it('rejects a payload pointing at another trusted channel', () => {
    // Break: cross-posting — a request posted in C01 must not act on C02.
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ channel_id: 'C02INCIDENTS' })) }), TRUSTED),
      'envelope_channel_mismatch',
      'channel_id',
    );
  });

  it('rejects a payload pointing at another thread parent', () => {
    expectRejected(
      classifyIncidentRequest(botEvent({ text: markerLine(payload({ parent_ts: '1757400000.000999' })) }), TRUSTED),
      'envelope_parent_mismatch',
      'parent_ts',
    );
  });
});

describe('classifyIncidentRequest — accepted result', () => {
  it('returns exactly the eight schema fields, hand-checked', () => {
    const result = classifyIncidentRequest(botEvent(), TRUSTED);
    expect(result).toEqual({
      kind: 'accepted',
      request: {
        version: 1,
        incident_id: 'inc-2026-09-11-001',
        lifecycle_id: 'lc-7f3a',
        attempt_id: 'att-2',
        channel_id: 'C01INCIDENTS',
        parent_ts: PARENT_TS,
        env: 'stage2',
        summary: 'proj stage2 deploy failed on the migration step',
      },
    });
    if (result.kind !== 'accepted') throw new Error('expected accepted');
    expect(Object.keys(result.request).sort()).toEqual([
      'attempt_id',
      'channel_id',
      'env',
      'incident_id',
      'lifecycle_id',
      'parent_ts',
      'summary',
      'version',
    ]);
  });

  it('keeps payload content out of the rejection result', () => {
    // Break: putting the offending value in the reason turns every rejection into
    // a log-injection / secret-leak channel.
    const secret = 'SUPER-SECRET-TOKEN-9d2f';
    const result = classifyIncidentRequest(
      botEvent({ text: markerLine(payload({ env: '', summary: secret })) }),
      TRUSTED,
    );
    expect(result.kind).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('isUntrustedSenderRejection', () => {
  it('separates sender-trust rejections from malformed-payload rejections', () => {
    // The policy layer alerts on a trusted bot sending garbage; an untrusted
    // sender is dropped quietly.
    expect(isUntrustedSenderRejection('untrusted_channel')).toBe(true);
    expect(isUntrustedSenderRejection('untrusted_team')).toBe(true);
    expect(isUntrustedSenderRejection('missing_sender_identity')).toBe(true);
    expect(isUntrustedSenderRejection('invalid_json')).toBe(false);
    expect(isUntrustedSenderRejection('unknown_field')).toBe(false);
    expect(isUntrustedSenderRejection('envelope_parent_mismatch')).toBe(false);
    expect(isUntrustedSenderRejection('receiver_disabled')).toBe(false);
  });
});
