import { describe, expect, it } from 'vitest';
import {
  type ArtifactVersionRow,
  artifactKeyFor,
  assignArtifactVersions,
  isSha256Hex,
  latestOfKey,
  planArtifactVersion,
  stripNameTimestamps,
} from './artifact-version';

/**
 * #1074 — the same artifact uploaded again is a new version of it, not an unrelated new file.
 *
 * The key rule (one function, used by the daemon's artifact store and by slack-mcp's upload comment):
 *   1. the key the model gave (`artifact_key`)
 *   2. else the file name with only its time stamps removed — an exact match, nothing fuzzier
 *   3. a link's own URL
 */

describe('#1074 T1 — what counts as the same artifact', () => {
  it('the key the model gave wins over the file name', () => {
    expect(artifactKeyFor({ key: 'weekly-report', name: 'html-a-20261109-184715.html' })).toBe('key:weekly-report');
    expect(artifactKeyFor({ key: '  weekly   report ', name: 'x.html' })).toBe('key:weekly report');
    expect(artifactKeyFor({ key: '', name: 'x.html' })).toBe('name:x.html');
    expect(artifactKeyFor({ key: 42, name: 'x.html' })).toBe('name:x.html');
  });

  it('without a key: the file name with only its time stamps removed', () => {
    expect(stripNameTimestamps('html-weekly-report-20261109-184715.html')).toBe('html-weekly-report.html');
    expect(stripNameTimestamps('html-weekly-report-20261110-090102.html')).toBe('html-weekly-report.html');
    expect(stripNameTimestamps('report_20261109T184715.md')).toBe('report.md');
    expect(stripNameTimestamps('report-20261109184715.md')).toBe('report.md');
    expect(stripNameTimestamps('2026-11-09_notes.md')).toBe('notes.md');
    expect(stripNameTimestamps('notes-2026-11-09T18-47-15.md')).toBe('notes.md');
    expect(stripNameTimestamps('chart-1794217450511.png')).toBe('chart.png');
    expect(stripNameTimestamps('a-20261109-b.txt')).toBe('a-b.txt');
  });

  it('keeps every other digit: versions, ids, years, numbers that are not a valid date or time', () => {
    expect(stripNameTimestamps('report-v2.html')).toBe('report-v2.html');
    expect(stripNameTimestamps('invoice-12345678.pdf')).toBe('invoice-12345678.pdf');
    expect(stripNameTimestamps('plan-2026.md')).toBe('plan-2026.md');
    expect(stripNameTimestamps('pr-1074-body.md')).toBe('pr-1074-body.md');
    expect(stripNameTimestamps('20261399-999999.txt')).toBe('20261399-999999.txt');
  });

  it('a name that is only a time stamp stays whole — two screenshots are not one artifact', () => {
    expect(stripNameTimestamps('20261109-184715.png')).toBe('20261109-184715.png');
    expect(artifactKeyFor({ name: '20261109-184715.png' })).not.toBe(artifactKeyFor({ name: '20261110-090000.png' }));
  });

  it('different names are different artifacts; a link is keyed by its URL', () => {
    expect(artifactKeyFor({ name: 'a.html' })).not.toBe(artifactKeyFor({ name: 'b.html' }));
    expect(artifactKeyFor({ name: 'Report.html' })).not.toBe(artifactKeyFor({ name: 'report.html' }));
    expect(artifactKeyFor({ url: 'https://x.test/a', name: 'x.test' })).toBe('url:https://x.test/a');
  });
});

const H = (c: string) => c.repeat(64);

describe('#1074 T2/T3 — the version an upload becomes', () => {
  const rows: ArtifactVersionRow[] = [
    { id: 'a1', key: 'name:r.html', version: 1, sha256: H('a') },
    { id: 'b1', key: 'name:other.html', version: 1, sha256: H('b') },
  ];

  it('first upload of a key → version 1, nothing to compare', () => {
    expect(planArtifactVersion([], 'name:r.html', H('a'))).toMatchObject({
      version: 1,
      changed: null,
      unchanged: false,
    });
  });

  it('different content under the same key → version 2, changed since version 1', () => {
    const p = planArtifactVersion(rows, 'name:r.html', H('c'));
    expect(p).toMatchObject({ version: 2, changed: true, unchanged: false });
    expect(p.previous?.id).toBe('a1');
  });

  it('the same content as the latest version → no new version ("no changes")', () => {
    expect(planArtifactVersion(rows, 'name:r.html', H('a'))).toMatchObject({
      version: 1,
      changed: false,
      unchanged: true,
    });
  });

  it('content that cannot be hashed is a new version whose change is unknown', () => {
    expect(planArtifactVersion(rows, 'name:r.html', undefined)).toMatchObject({
      version: 2,
      changed: null,
      unchanged: false,
    });
  });

  it('compares with the latest version only', () => {
    const more = [...rows, { id: 'a2', key: 'name:r.html', version: 2, sha256: H('c') }];
    expect(latestOfKey(more, 'name:r.html')?.id).toBe('a2');
    expect(planArtifactVersion(more, 'name:r.html', H('a'))).toMatchObject({ version: 3, changed: true });
  });
});

describe('#1074 — rows recorded before versions existed', () => {
  it('get a key from their name and versions in recording order; a hidden final answer gets none', () => {
    const rows: ArtifactVersionRow[] = [
      { id: '1', name: 'html-r-20261101-100000.html' },
      { id: '2', name: 'chart.png' },
      { id: '3', name: 'answer.md', source: 'final_answer' },
      { id: '4', name: 'html-r-20261102-100000.html' },
      { id: '5', name: 'html-r-20261103-100000.html', key: 'name:html-r.html', version: 7 },
      { id: '6', name: 'html-r-20261104-100000.html' },
    ];
    assignArtifactVersions(rows);
    expect(rows.map((r) => [r.id, r.key, r.version])).toEqual([
      ['1', 'name:html-r.html', 1],
      ['2', 'name:chart.png', 1],
      ['3', undefined, undefined],
      ['4', 'name:html-r.html', 2],
      ['5', 'name:html-r.html', 7],
      ['6', 'name:html-r.html', 8],
    ]);
  });

  it('isSha256Hex accepts only a lowercase 64-hex digest', () => {
    expect(isSha256Hex(H('a'))).toBe(true);
    expect(isSha256Hex(H('A'))).toBe(false);
    expect(isSha256Hex('abc')).toBe(false);
    expect(isSha256Hex(undefined)).toBe(false);
  });
});
