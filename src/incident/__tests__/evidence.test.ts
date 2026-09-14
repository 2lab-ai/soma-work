/**
 * Eagle-eye incident evidence collector — behavior tests.
 *
 * These drive the REAL collector against a REAL loopback HTTP server, because
 * every interesting break lives at the HTTP boundary (redirect refusal, byte
 * cap, abort-based timeout, non-JSON body). A hand-written transport double
 * would assert our own imagination of `fetch`, not `fetch`.
 *
 * Fixtures mirror the eagle-eye payloads field-for-field:
 *   - `GET /api/triage`   → src/triage.rs `TriageReport` / `TriageIssue`
 *   - `GET /api/snapshot` → src/collect/mod.rs `Snapshot` / `Host`,
 *     src/collect/http.rs `Check`, src/collect/external.rs `ExternalService`
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectIncidentEvidence, IncidentEvidenceConfigError, resolveIncidentEvidenceOrigin } from '../evidence.js';

// ---------------------------------------------------------------- fixtures

/** One `TriageIssue` as the server serializes it (src/triage.rs). */
function triageIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sev: 3,
    cat: 'HOST',
    key: 'host:dev2',
    text: 'dev2 DOWN',
    detail: 'ssh probe: connection refused',
    id: 'HOST|host:dev2|dev2 DOWN',
    envs: ['dev2'],
    ...over,
  };
}

/** `TriageReport` (src/triage.rs). */
function triageReport(issues: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    generated_at: '2026-09-11T09:00:00.000Z',
    issues,
    waits: ['aws_inventory'],
  };
}

/** One `Host` row (src/collect/mod.rs). */
function host(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev2',
    env: 'dev2',
    kind: 'linux',
    reachable: false,
    best_effort: false,
    load1: null,
    load5: null,
    cpu_cores: 8,
    mem_used_mb: null,
    mem_total_mb: 16384,
    disk_used_pct: null,
    disk_total: '200G',
    containers: [],
    services: [],
    probed_at: '2026-09-11T08:59:30.000Z',
    latency_ms: null,
    error: 'ssh: connect to host dev2 port 22: Connection refused',
    ...over,
  };
}

/** One `ExternalService` row (src/collect/external.rs). */
function externalService(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'github',
    label: 'GitHub',
    tier: 'critical',
    status: 'outage',
    source: 'both',
    status_url: 'https://www.githubstatus.com',
    detail: 'Actions: major_outage',
    components: [{ name: 'Actions', status: 'major_outage' }],
    probe_ms: 812,
    checked_at: '2026-09-11T08:58:00.000Z',
    ...over,
  };
}

/** One http `Check` row (src/collect/http.rs). */
function httpCheck(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'gucci-dev2-api',
    url: 'https://api.dev2.example.com/health?apikey=Ab3kQz9mLp2Xq7Rt4Vw8',
    ok: false,
    status: 503,
    latency_ms: 91,
    checked_at: '2026-09-11T08:59:45.000Z',
    error: 'HTTP 503',
    host_id: 'dev2',
    ...over,
  };
}

/** `Snapshot` (src/collect/mod.rs). */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generated_at: '2026-09-11T09:00:00.000Z',
    observed_at: {
      hosts: '2026-09-11T08:59:30.000Z',
      http_checks: '2026-09-11T08:59:45.000Z',
      service_metrics: '2026-09-11T08:58:00.000Z',
      placements: '2026-09-11T08:57:00.000Z',
      external_status: '2026-09-11T08:58:00.000Z',
    },
    hosts: [host(), host({ id: 'stage2-vm4', env: 'stage2', reachable: true, best_effort: true, error: null })],
    products: [],
    inhouse: [],
    http_checks: [
      httpCheck(),
      httpCheck({ name: 'office-kuma', host_id: 'office', ok: true, status: 200, error: null }),
    ],
    placements: [],
    service_metrics: [],
    external_status: {
      fetched_at: '2026-09-11T08:58:00.000Z',
      services: [
        externalService({ id: 'anthropic', label: 'Anthropic', status: 'ok', detail: null }),
        externalService(),
      ],
    },
    collect_errors: [],
    ...over,
  };
}

// ------------------------------------------------------------ test server

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let routes: Record<string, Handler>;
let requestedPaths: string[];
let receivedHeaders: Array<http.IncomingHttpHeaders>;

/** Answer `path` with `body` serialized as JSON, HTTP 200. */
function json(body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '';
    requestedPaths.push(url);
    receivedHeaders.push(req.headers);
    const handler = routes[url.split('?')[0]];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no route');
      return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes = {};
  requestedPaths = [];
  receivedHeaders = [];
});

/** Collector clock pinned 30s after the newest fixture observation. */
const NOW = new Date('2026-09-11T09:00:30.000Z');
const deps = { now: () => NOW };

function collect(over: { incident_id?: string; env?: string; signal?: AbortSignal } = {}, configOver = {}) {
  return collectIncidentEvidence(
    { baseUrl, ...configOver },
    { incident_id: 'HOST|host:dev2|dev2 DOWN', env: 'dev2', ...over },
    deps,
  );
}

// ---------------------------------------------------------------- tests

describe('collectIncidentEvidence — triage matching', () => {
  it('projects only safelisted issue fields for an exact id+env match', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('reported');
    expect(evidence.triage?.issue).toEqual({
      ref: 'eagle:/api/triage#issues[id=HOST|host:dev2|dev2 DOWN]',
      id: 'HOST|host:dev2|dev2 DOWN',
      cat: 'HOST',
      key: 'host:dev2',
      text: { text: 'dev2 DOWN', redacted: false, truncated: false },
      detail: { text: 'ssh probe: connection refused', redacted: false, truncated: false },
      envs: ['dev2'],
    });
    // sev/ack are outside the safelist: a widened projection must fail here
    expect(JSON.stringify(evidence)).not.toContain('"sev"');
  });

  it('matches the incident id exactly, never by prefix or substring', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue({ id: 'HOST|host:dev2|dev2 DOWN AGAIN' })]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('not_currently_reported');
    expect(evidence.triage?.issue).toBeNull();
  });

  it('a missing incident is not_currently_reported and pulls no snapshot at all', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue({ id: 'EXT|ext:github|GITHUB OUTAGE', cat: 'EXT' })]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('not_currently_reported');
    expect(evidence.snapshot).toBeNull();
    expect(evidence.errors).toEqual([]);
    // absence is not recovery, and it must not cost an estate-wide fetch
    expect(requestedPaths).toEqual(['/api/triage']);
    // the triage report's own assembly time still rides along as evidence
    expect(evidence.triage?.generated_at).toBe('2026-09-11T09:00:00.000Z');
  });

  it('reports env_mismatch for an id match in another env, without fetching the snapshot', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue({ envs: ['stage2'] })]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('env_mismatch');
    expect(evidence.snapshot).toBeNull();
    expect(requestedPaths).toEqual(['/api/triage']);
  });

  it('treats an issue with no env attribution as an env mismatch, not a match', async () => {
    const { envs: _dropped, ...noEnvs } = triageIssue();
    routes['/api/triage'] = json(triageReport([noEnvs]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('env_mismatch');
    expect(evidence.triage?.issue?.envs).toEqual([]);
  });
});

describe('collectIncidentEvidence — provenance framing', () => {
  it('labels every outcome as a collector snapshot and carries its own caveat', async () => {
    // A consumer (the later SDK tool) renders these verbatim; a status that
    // ships without a caveat is a status free to be re-framed as "fixed".
    const cases: Array<[string, () => void]> = [
      [
        'reported',
        () => {
          routes['/api/triage'] = json(triageReport([triageIssue()]));
          routes['/api/snapshot'] = json(snapshot());
        },
      ],
      [
        'env_mismatch',
        () => {
          routes['/api/triage'] = json(triageReport([triageIssue({ envs: ['stage2'] })]));
        },
      ],
      [
        'not_currently_reported',
        () => {
          routes['/api/triage'] = json(triageReport([]));
        },
      ],
      [
        'evidence_unavailable',
        () => {
          routes['/api/triage'] = (_req, res) => {
            res.writeHead(500);
            res.end();
          };
        },
      ],
    ];

    for (const [expected, arrange] of cases) {
      routes = {};
      arrange();
      const evidence = await collect();
      expect(evidence.status).toBe(expected);
      expect(evidence.provenance).toBe('eagle_eye_collector_snapshot');
      expect(evidence.caveat.length).toBeGreaterThan(0);
    }
  });

  it('says the absence of an active issue does not prove recovery', async () => {
    routes['/api/triage'] = json(triageReport([]));

    const evidence = await collect();

    expect(evidence.status).toBe('not_currently_reported');
    expect(evidence.caveat).toMatch(/cannot prove recovery/i);
  });
});

describe('collectIncidentEvidence — snapshot record selection', () => {
  it('selects only the host named by the issue key; other envs never enter the payload', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.snapshot?.host).toEqual({
      ref: 'eagle:/api/snapshot#hosts[id=dev2]',
      id: 'dev2',
      env: 'dev2',
      reachable: false,
      best_effort: false,
      error: {
        text: 'ssh: connect to host dev2 port 22: Connection refused',
        redacted: false,
        truncated: false,
      },
      freshness: { state: 'fresh', observed_at: '2026-09-11T08:59:30.000Z', age_seconds: 60 },
    });
    expect(evidence.snapshot?.external).toBeNull();
    expect(evidence.snapshot?.check).toBeNull();
    // the unrelated env's host row must not leak anywhere in the evidence
    expect(JSON.stringify(evidence)).not.toContain('stage2-vm4');
  });

  it('selects the ext: service by id and carries the service’s own observation time', async () => {
    routes['/api/triage'] = json(
      triageReport([
        triageIssue({
          cat: 'EXT',
          key: 'ext:github',
          text: 'GITHUB OUTAGE',
          detail: 'Actions: major_outage',
          id: 'EXT|ext:github|GITHUB OUTAGE',
        }),
      ]),
    );
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect({ incident_id: 'EXT|ext:github|GITHUB OUTAGE' });

    expect(evidence.snapshot?.external).toEqual({
      ref: 'eagle:/api/snapshot#external_status.services[id=github]',
      id: 'github',
      name: 'GitHub',
      status: 'outage',
      source: 'both',
      detail: { text: 'Actions: major_outage', redacted: false, truncated: false },
      probe_ms: 812,
      checked_at: '2026-09-11T08:58:00.000Z',
      freshness: { state: 'fresh', observed_at: '2026-09-11T08:58:00.000Z', age_seconds: 150 },
    });
    // the collector's own clock must never masquerade as an observation
    expect(evidence.collected_at).toBe('2026-09-11T09:00:30.000Z');
    expect(evidence.snapshot?.external?.checked_at).not.toBe(evidence.collected_at);
    expect(evidence.snapshot?.host).toBeNull();
    // the sibling service is a different incident: it stays out
    expect(JSON.stringify(evidence)).not.toContain('anthropic');
  });

  it('joins a CHECK issue on the exact check name and never exposes the check url', async () => {
    routes['/api/triage'] = json(
      triageReport([
        triageIssue({
          cat: 'CHECK',
          key: undefined,
          text: 'gucci-dev2-api',
          detail: 'HTTP 503',
          id: 'CHECK|gucci-dev2-api',
        }),
      ]),
    );
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect({ incident_id: 'CHECK|gucci-dev2-api' });

    expect(evidence.snapshot?.check).toEqual({
      ref: 'eagle:/api/snapshot#http_checks[name=gucci-dev2-api]',
      name: 'gucci-dev2-api',
      ok: false,
      status: 503,
      latency_ms: 91,
      checked_at: '2026-09-11T08:59:45.000Z',
      error: { text: 'HTTP 503', redacted: false, truncated: false },
      freshness: { state: 'fresh', observed_at: '2026-09-11T08:59:45.000Z', age_seconds: 45 },
    });
    // the check url carries a query credential — it is never projected
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain('Ab3kQz9mLp2Xq7Rt4Vw8');
    expect(serialized).not.toContain('api.dev2.example.com');
  });

  it('reports a keyed host that is absent from the snapshot as null, not as a fabricated record', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue({ key: 'host:ghost-box' })]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.status).toBe('reported');
    expect(evidence.snapshot?.host).toBeNull();
  });
});

describe('collectIncidentEvidence — observation freshness', () => {
  it('marks a row whose own probe is older than the window as stale', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    routes['/api/snapshot'] = json(snapshot({ hosts: [host({ probed_at: '2026-09-11T08:50:30.000Z' })] }));

    const evidence = await collect();

    expect(evidence.snapshot?.host?.freshness).toEqual({
      state: 'stale',
      observed_at: '2026-09-11T08:50:30.000Z',
      age_seconds: 600,
    });
  });

  it('a stale row stays stale under a freshly collected batch clock', async () => {
    // THE break: `observed_at.*` is the batch's newest observation across the
    // whole source. A host that failed to probe this cycle keeps its old
    // `probed_at` while the batch clock moves on — reading the batch clock
    // would dress a 10-minute-old row as current.
    routes['/api/triage'] = json(
      triageReport([
        triageIssue(),
        triageIssue({ cat: 'EXT', key: 'ext:github', text: 'GITHUB OUTAGE', id: 'ext-id' }),
        triageIssue({ cat: 'CHECK', key: undefined, text: 'gucci-dev2-api', id: 'check-id' }),
      ]),
    );
    const freshBatch = {
      hosts: '2026-09-11T09:00:25.000Z',
      http_checks: '2026-09-11T09:00:25.000Z',
      external_status: '2026-09-11T09:00:25.000Z',
    };
    routes['/api/snapshot'] = json(
      snapshot({
        observed_at: freshBatch,
        hosts: [host({ probed_at: '2026-09-11T08:50:30.000Z' })],
        http_checks: [httpCheck({ checked_at: '2026-09-11T08:50:30.000Z' })],
        external_status: {
          fetched_at: freshBatch.external_status,
          services: [externalService({ checked_at: '2026-09-11T08:50:30.000Z' })],
        },
      }),
    );

    const hostEvidence = await collect();
    expect(hostEvidence.snapshot?.host?.freshness).toEqual({
      state: 'stale',
      observed_at: '2026-09-11T08:50:30.000Z',
      age_seconds: 600,
    });

    const extEvidence = await collect({ incident_id: 'ext-id' });
    expect(extEvidence.snapshot?.external?.freshness.state).toBe('stale');
    expect(extEvidence.snapshot?.external?.freshness.observed_at).toBe('2026-09-11T08:50:30.000Z');

    const checkEvidence = await collect({ incident_id: 'check-id' });
    expect(checkEvidence.snapshot?.check?.freshness.state).toBe('stale');
    expect(checkEvidence.snapshot?.check?.freshness.observed_at).toBe('2026-09-11T08:50:30.000Z');
  });

  it('honors a configured freshness window', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    routes['/api/snapshot'] = json(snapshot());

    // the host row probed 60s ago: stale at a 30s window, fresh at the default
    const tight = await collect({}, { maxObservationAgeSeconds: 30 });
    expect(tight.snapshot?.host?.freshness.state).toBe('stale');
  });

  it('marks a row with no timestamp of its own as absent, never borrowing the batch clock', async () => {
    routes['/api/triage'] = json(
      triageReport([
        triageIssue(),
        triageIssue({ cat: 'EXT', key: 'ext:github', text: 'GITHUB OUTAGE', id: 'ext-id' }),
        triageIssue({ cat: 'CHECK', key: undefined, text: 'gucci-dev2-api', id: 'check-id' }),
      ]),
    );
    const absent = { state: 'absent', observed_at: null, age_seconds: null };
    routes['/api/snapshot'] = json(
      snapshot({
        hosts: [host({ probed_at: null })],
        http_checks: [httpCheck({ checked_at: null })],
        external_status: {
          fetched_at: '2026-09-11T09:00:25.000Z',
          services: [externalService({ checked_at: null })],
        },
      }),
    );

    expect((await collect()).snapshot?.host?.freshness).toEqual(absent);
    expect((await collect({ incident_id: 'ext-id' })).snapshot?.external?.freshness).toEqual(absent);
    expect((await collect({ incident_id: 'check-id' })).snapshot?.check?.freshness).toEqual(absent);
  });

  it('marks a triage report with no generated_at as absent freshness', async () => {
    const report = triageReport([triageIssue()]);
    delete report.generated_at;
    routes['/api/triage'] = json(report);
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.triage?.generated_at).toBeNull();
    expect(evidence.triage?.freshness.state).toBe('absent');
  });
});

describe('collectIncidentEvidence — sanitization', () => {
  it('redacts url credentials and query values while keeping the reachable identity', async () => {
    routes['/api/triage'] = json(
      triageReport([
        triageIssue({
          detail: 'probe failed: https://ops:hunter2@api.example.com/v1/ping?token=s3cr3tvalue&mode=live',
        }),
      ]),
    );
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();
    const detail = evidence.triage?.issue?.detail;

    expect(detail?.redacted).toBe(true);
    expect(detail?.text).toBe('probe failed: https://api.example.com/v1/ping?token=[redacted]&mode=[redacted]');
  });

  it('omits a detail that still carries a token-shaped secret after redaction', async () => {
    routes['/api/triage'] = json(
      triageReport([triageIssue({ detail: 'auth rejected for Ab3kQz9mLp2Xq7Rt4Vw8 on retry' })]),
    );
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();

    expect(evidence.triage?.issue?.detail).toEqual({
      text: null,
      redacted: true,
      truncated: false,
      omitted: 'unsafe_to_sanitize',
    });
    // the whole string goes, not just the token
    expect(JSON.stringify(evidence)).not.toContain('auth rejected');
  });

  it('redacts a labelled secret without omitting the whole line', async () => {
    routes['/api/triage'] = json(
      triageReport([triageIssue({ detail: 'slack api_key=xoxb-123456789012-abcdef rejected' })]),
    );
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();
    const detail = evidence.triage?.issue?.detail;

    expect(detail?.text).toBe('slack api_key=[redacted] rejected');
    expect(detail?.redacted).toBe(true);
  });

  it('truncates an unbounded detail string and says so', async () => {
    const long = `stack overflow: ${'a'.repeat(5000)}`;
    routes['/api/triage'] = json(triageReport([triageIssue({ detail: long })]));
    routes['/api/snapshot'] = json(snapshot());

    const evidence = await collect();
    const detail = evidence.triage?.issue?.detail;

    expect(detail?.truncated).toBe(true);
    expect((detail?.text ?? '').length).toBeLessThanOrEqual(241);
    expect(detail?.text?.startsWith('stack overflow: aaa')).toBe(true);
  });
});

describe('collectIncidentEvidence — transport failures', () => {
  it('reports a non-200 triage response as an explicit http_status error', async () => {
    routes['/api/triage'] = (_req, res) => {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream down');
    };

    const evidence = await collect();

    expect(evidence.status).toBe('evidence_unavailable');
    expect(evidence.errors).toEqual([
      { ref: 'eagle:/api/triage', kind: 'http_status', status: 503, message: 'HTTP 503 from /api/triage' },
    ]);
    expect(evidence.triage).toBeNull();
  });

  it('reports a non-JSON body as malformed_json rather than throwing', async () => {
    routes['/api/triage'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>proxy error</html>');
    };

    const evidence = await collect();

    expect(evidence.status).toBe('evidence_unavailable');
    expect(evidence.errors[0].kind).toBe('malformed_json');
    expect(evidence.errors[0].ref).toBe('eagle:/api/triage');
  });

  it('refuses to follow a redirect', async () => {
    routes['/api/triage'] = (_req, res) => {
      res.writeHead(302, { location: '/api/elsewhere' });
      res.end();
    };
    routes['/api/elsewhere'] = json(triageReport([triageIssue()]));

    const evidence = await collect();

    expect(evidence.errors[0].kind).toBe('redirect');
    expect(requestedPaths).toEqual(['/api/triage']);
  });

  it('aborts a response that exceeds the byte cap instead of buffering it', async () => {
    routes['/api/triage'] = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // > 2MB of body, streamed: the cap must trip before the parse
      res.write(`{"generated_at":"2026-09-11T09:00:00.000Z","issues":[],"pad":"`);
      for (let i = 0; i < 22; i++) res.write('x'.repeat(100_000));
      res.end('"}');
    };

    const evidence = await collect();

    expect(evidence.status).toBe('evidence_unavailable');
    expect(evidence.errors[0].kind).toBe('oversize');
  });

  it('times out on a slow endpoint using a real abort', async () => {
    routes['/api/triage'] = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(triageReport([])));
      }, 400);
    };

    const evidence = await collect({}, { timeoutMs: 60 });

    expect(evidence.status).toBe('evidence_unavailable');
    expect(evidence.errors[0].kind).toBe('timeout');
  });

  it('clamps a configured timeout to the 10s ceiling', async () => {
    // A caller asking for 10 minutes must not pin a Slack session for 10
    // minutes: the abort has to fire at the ceiling. Driven on fake timers
    // against a fetch that only settles when its signal aborts.
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const hangingFetch = (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
        });

      const pending = collectIncidentEvidence(
        { baseUrl: 'https://eagle.example.com', timeoutMs: 600_000 },
        { incident_id: 'x', env: 'dev2' },
        { fetch: hangingFetch as unknown as typeof fetch, now: () => NOW },
      );

      await vi.advanceTimersByTimeAsync(9_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(signal?.aborted).toBe(true);

      const evidence = await pending;
      expect(evidence.errors[0].kind).toBe('timeout');
      // B-2: a bare `.abort()` leaves DOMException("aborted"), which the
      // turn-end surface treats as "no reason" and drops silently.
      expect(signal?.reason).toBe('incident-evidence-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a caller abort signal', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    const controller = new AbortController();
    controller.abort();

    const evidence = await collect({ signal: controller.signal });

    expect(evidence.status).toBe('evidence_unavailable');
    expect(evidence.errors[0].kind).toBe('aborted');
    expect(requestedPaths).toEqual([]);
  });

  it('passes the caller’s own abort reason down to the in-flight fetch', async () => {
    // A caller that aborts mid-flight (session teardown) must keep its
    // identity on the wire signal — otherwise the downstream failure is
    // indistinguishable from an untagged, silently-dropped abort.
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const hangingFetch = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
        setTimeout(() => controller.abort('session-teardown'), 5);
      });

    const evidence = await collectIncidentEvidence(
      { baseUrl: 'https://eagle.example.com' },
      { incident_id: 'x', env: 'dev2', signal: controller.signal },
      { fetch: hangingFetch as unknown as typeof fetch, now: () => NOW },
    );

    expect(signal?.reason).toBe('session-teardown');
    expect(evidence.errors[0].kind).toBe('aborted');
  });

  it('keeps the triage finding when only the snapshot fetch fails', async () => {
    routes['/api/triage'] = json(triageReport([triageIssue()]));
    routes['/api/snapshot'] = (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
    };

    const evidence = await collect();

    expect(evidence.status).toBe('reported');
    expect(evidence.triage?.issue?.id).toBe('HOST|host:dev2|dev2 DOWN');
    expect(evidence.snapshot).toBeNull();
    expect(evidence.errors).toEqual([
      { ref: 'eagle:/api/snapshot', kind: 'http_status', status: 500, message: 'HTTP 500 from /api/snapshot' },
    ]);
  });

  it('sends a bare read-only GET — no credentials, no cookies', async () => {
    routes['/api/triage'] = json(triageReport([]));

    await collect();

    expect(receivedHeaders).toHaveLength(1);
    expect(receivedHeaders[0].authorization).toBeUndefined();
    expect(receivedHeaders[0].cookie).toBeUndefined();
    expect(receivedHeaders[0].accept).toBe('application/json');
  });
});

describe('collectIncidentEvidence — base url policy', () => {
  const rejected: Array<[string, string]> = [
    ['credentials in the authority', 'https://ops:hunter2@eagle.example.com'],
    ['a query string', 'https://eagle.example.com/?token=abc'],
    ['a fragment', 'https://eagle.example.com/#frag'],
    ['a path beyond root', 'https://eagle.example.com/eagle'],
    ['plain http to a non-loopback host', 'http://eagle.example.com'],
    ['an unsupported scheme', 'file:///etc/passwd'],
    ['a non-url string', 'eagle-eye'],
  ];

  it.each(rejected)('rejects %s before any request leaves the process', async (_why, url) => {
    let called = 0;
    const fetchSpy = async () => {
      called += 1;
      return new Response('{}');
    };

    await expect(
      collectIncidentEvidence({ baseUrl: url }, { incident_id: 'x', env: 'dev2' }, { fetch: fetchSpy, now: () => NOW }),
    ).rejects.toBeInstanceOf(IncidentEvidenceConfigError);
    expect(called).toBe(0);
  });

  it('never echoes the configured value back in a rejection message', async () => {
    // A misconfigured origin is the one most likely to hold a pasted
    // credential, and this error text reaches logs and Slack. Planted secret
    // must survive in none of the rejection paths.
    const planted = 'Sup3rSecretPlantedToken';
    const poisoned = [
      `ht!tp://ops:${planted}@eagle.example.com`, // unparseable
      `https://ops:${planted}@eagle.example.com`, // credentials
      `https://eagle.example.com/?apikey=${planted}`, // query
      `https://eagle.example.com/#${planted}`, // fragment
      `https://eagle.example.com/${planted}`, // path
      `ftp://${planted}.example.com`, // scheme
    ];

    for (const baseUrl of poisoned) {
      let thrown: unknown;
      try {
        await collectIncidentEvidence({ baseUrl }, { incident_id: 'x', env: 'dev2' }, deps);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(IncidentEvidenceConfigError);
      const error = thrown as Error;
      expect(`${error.message}${error.stack ?? ''}`).not.toContain(planted);
    }
  });

  it('accepts https and loopback http origins', async () => {
    routes['/api/triage'] = json(triageReport([]));

    // loopback http: the live test server
    await expect(collect()).resolves.toMatchObject({ status: 'not_currently_reported' });

    // https: no server needed — the policy check must pass and the request go out
    let requested = '';
    const fetchSpy = async (url: string) => {
      requested = url;
      return new Response(JSON.stringify(triageReport([])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await collectIncidentEvidence(
      { baseUrl: 'https://eagle.example.com/' },
      { incident_id: 'x', env: 'dev2' },
      { fetch: fetchSpy as unknown as typeof fetch, now: () => NOW },
    );
    expect(requested).toBe('https://eagle.example.com/api/triage');
  });

  it('resolveIncidentEvidenceOrigin normalizes an accepted origin for the config layer', async () => {
    // The config loader validates at wiring time and keeps the return value;
    // it must be the bare origin, with the default port folded away.
    expect(resolveIncidentEvidenceOrigin('https://eagle.example.com:443/')).toBe('https://eagle.example.com');
    expect(resolveIncidentEvidenceOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => resolveIncidentEvidenceOrigin('https://eagle.example.com/api')).toThrow(IncidentEvidenceConfigError);
  });

  it('rejects an empty incident id or env before any request', async () => {
    let called = 0;
    const fetchSpy = async () => {
      called += 1;
      return new Response('{}');
    };
    const dep = { fetch: fetchSpy as unknown as typeof fetch, now: () => NOW };

    await expect(
      collectIncidentEvidence({ baseUrl: 'https://eagle.example.com' }, { incident_id: '', env: 'dev2' }, dep),
    ).rejects.toBeInstanceOf(IncidentEvidenceConfigError);
    await expect(
      collectIncidentEvidence({ baseUrl: 'https://eagle.example.com' }, { incident_id: 'x', env: '' }, dep),
    ).rejects.toBeInstanceOf(IncidentEvidenceConfigError);
    expect(called).toBe(0);
  });
});
