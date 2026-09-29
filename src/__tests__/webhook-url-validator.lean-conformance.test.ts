/**
 * Conformance of `src/webhook-url-validator.ts` with its Lean model.
 *
 * `verification/lean/SomaVerify/WebhookSsrf/` models the validator on address numbers, proves the
 * model blocks exactly what its rules say (the IANA special-purpose registries, IPv4 multicast,
 * IPv6 outside 2000::/3 except NAT64 of an allowed IPv4), and writes
 * `verification/vectors/webhook-ssrf.json`. This suite replays every vector against the real
 * exports:
 *
 * - `ip` cases: `isBlockedIp(input)`. They cover the first and last address of every registry
 *   row and every other block the rules name, and the neighbour on each side.
 * - `url` cases: `validateWebhookUrl(input)`, and `validateWebhookUrlWithDns(input)` with the
 *   resolvers stubbed to each scenario's answers. Nothing reaches the network.
 *
 * The exported registry tables are also compared, row for row, with the vendored IANA files in
 * `verification/iana/`, so a TS row that is extra, missing or changed fails even where no vector
 * lands in it.
 *
 * The model does not parse URLs or print addresses by itself being right: the vectors carry what
 * it assumes `new URL` returns and how the engine writes canonical addresses, and the premise
 * tests below check those assumptions against the engine.
 *
 * The vector file is regenerated and drift-checked by the "Lean Verify" workflow
 * (`scripts/verification/lean-verify.sh --check`).
 */

import * as dns from 'node:dns';
import * as fs from 'node:fs';
import net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IPV4_SPECIAL_PURPOSE,
  IPV6_SPECIAL_PURPOSE,
  isBlockedIp,
  validateWebhookUrl,
  validateWebhookUrlWithDns,
} from '../webhook-url-validator';

const repoRoot = path.resolve(__dirname, '../..');

/**
 * RFC 4180 records: `,` between fields, CRLF or LF between records, `"` quoting with `""` for a
 * literal quote; a quoted field may span lines.
 */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length > 0) records.push([...record, field]);
  return records;
}

/**
 * `[block, "Globally Reachable"]` for every block of a vendored registry file, in file order:
 * footnote markers (`N/A [2]`) dropped, a cell listing two blocks split into two rows.
 */
function registryRows(file: string): Array<[string, string]> {
  const [header, ...rows] = parseCsv(fs.readFileSync(path.join(repoRoot, 'verification/iana', file), 'utf8'));
  const blockColumn = header.indexOf('Address Block');
  const reachColumn = header.indexOf('Globally Reachable');
  const dropFootnote = (cell: string) => cell.split(' [')[0].trim();
  return rows.flatMap((row) =>
    row[blockColumn].split(',').map((block): [string, string] => [dropFootnote(block), dropFootnote(row[reachColumn])]),
  );
}

interface Validation {
  valid: boolean;
  error?: string;
}

interface IpCase {
  kind: 'ip';
  input: string;
  canonical: boolean;
  expect: { blocked: boolean };
}

interface DnsScenario {
  resolve4: string[];
  resolve6: string[];
  queried: string | null;
  result: Validation;
}

interface UrlCase {
  kind: 'url';
  input: string;
  url: { protocol: string; hostname: string } | null;
  dnsHost?: string;
  ipLiteral?: boolean;
  expect: { static: Validation; dns: DnsScenario[] };
}

interface VectorFile {
  module: string;
  generator: string;
  lean: string;
  count: number;
  cases: Array<IpCase | UrlCase>;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'verification/vectors/webhook-ssrf.json'), 'utf8'),
) as VectorFile;

const ipCases = vectors.cases.filter((c): c is IpCase => c.kind === 'ip');
const urlCases = vectors.cases.filter((c): c is UrlCase => c.kind === 'url');

function sameValidation(actual: Validation, expected: Validation): boolean {
  return actual.valid === expected.valid && actual.error === expected.error;
}

function parsedUrl(input: string): { protocol: string; hostname: string } | null {
  try {
    const { protocol, hostname } = new URL(input);
    return { protocol, hostname };
  } catch {
    return null;
  }
}

describe('webhook-ssrf Lean conformance vectors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carry exactly the cases they declare, enough of them, and no duplicates', () => {
    expect(vectors.module).toBe('webhook-ssrf');
    expect(vectors.count).toBe(vectors.cases.length);
    expect(ipCases.length + urlCases.length).toBe(vectors.count);
    expect(vectors.count).toBeGreaterThan(200);
    expect(new Set(ipCases.map((c) => c.input)).size).toBe(ipCases.length);
    expect(new Set(urlCases.map((c) => c.input)).size).toBe(urlCases.length);
  });

  it('come with TS registry tables that equal the vendored IANA files, row for row', () => {
    const ipv4 = registryRows('iana-ipv4-special-registry-1.csv');
    const ipv6 = registryRows('iana-ipv6-special-registry-1.csv');
    expect([ipv4.length, ipv6.length]).toEqual([26, 25]);
    expect(IPV4_SPECIAL_PURPOSE.map(([block, reach]) => [block, reach])).toEqual(ipv4);
    expect(IPV6_SPECIAL_PURPOSE.map(([block, reach]) => [block, reach])).toEqual(ipv6);
  });

  it('were generated by the pinned Lean toolchain', () => {
    const toolchain = fs.readFileSync(path.join(repoRoot, 'verification/lean/lean-toolchain'), 'utf8').trim();
    expect(toolchain).toBe(`leanprover/lean4:v${vectors.lean}`);
  });

  it('write canonical addresses the way the URL parser serializes them (premise)', () => {
    const mismatches = ipCases
      .filter((c) => c.canonical)
      .map((c) => ({ c, host: c.input.includes(':') ? `[${c.input}]` : c.input }))
      .filter(({ host }) => parsedUrl(`https://${host}/`)?.hostname !== host)
      .map(({ c }) => c.input);
    expect(mismatches).toEqual([]);
  });

  it('isBlockedIp agrees with the model on every hostname', () => {
    const mismatches = ipCases
      .filter((c) => isBlockedIp(c.input) !== c.expect.blocked)
      .map((c) => `${JSON.stringify(c.input)}: model ${c.expect.blocked}`);
    expect(mismatches).toEqual([]);
  });

  it('assume the protocol and hostname new URL returns (premise)', () => {
    const mismatches = urlCases
      .filter((c) => JSON.stringify(parsedUrl(c.input)) !== JSON.stringify(c.url))
      .map((c) => `${JSON.stringify(c.input)}: engine ${JSON.stringify(parsedUrl(c.input))}`);
    expect(mismatches).toEqual([]);
  });

  it('agree with net.isIP on which hostnames are IP literals (premise)', () => {
    const mismatches = urlCases
      .filter((c) => c.dnsHost !== undefined && (net.isIP(c.dnsHost) !== 0) !== c.ipLiteral)
      .map((c) => `${JSON.stringify(c.dnsHost)}: model ${c.ipLiteral}`);
    expect(mismatches).toEqual([]);
  });

  it('validateWebhookUrl agrees with the model on every URL', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mismatches = urlCases
      .filter((c) => !sameValidation(validateWebhookUrl(c.input), c.expect.static))
      .map((c) => `${JSON.stringify(c.input)}: model ${JSON.stringify(c.expect.static)}`);
    expect(mismatches).toEqual([]);
  });

  it('validateWebhookUrlWithDns agrees with the model for every URL and resolver answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mismatches: string[] = [];
    let scenarios = 0;
    for (const c of urlCases) {
      for (const s of c.expect.dns) {
        scenarios++;
        const resolve4 = vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(s.resolve4);
        const resolve6 = vi.spyOn(dns.promises, 'resolve6').mockResolvedValue(s.resolve6);
        const result = await validateWebhookUrlWithDns(c.input);
        const expectedCalls = s.queried === null ? [] : [[s.queried]];
        const where = `${JSON.stringify(c.input)} with ${JSON.stringify([s.resolve4, s.resolve6])}`;
        if (!sameValidation(result, s.result)) {
          mismatches.push(`${where}: model ${JSON.stringify(s.result)}, TS ${JSON.stringify(result)}`);
        }
        if (JSON.stringify(resolve4.mock.calls) !== JSON.stringify(expectedCalls)) {
          mismatches.push(`${where}: resolve4 calls ${JSON.stringify(resolve4.mock.calls)}`);
        }
        if (JSON.stringify(resolve6.mock.calls) !== JSON.stringify(expectedCalls)) {
          mismatches.push(`${where}: resolve6 calls ${JSON.stringify(resolve6.mock.calls)}`);
        }
        resolve4.mockRestore();
        resolve6.mockRestore();
      }
    }
    expect(mismatches).toEqual([]);
    expect(scenarios).toBe(urlCases.reduce((n, c) => n + c.expect.dns.length, 0));
  });
});
