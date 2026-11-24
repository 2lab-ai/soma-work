import { describe, expect, it } from 'vitest';
import { formatReleaseNotes, hostReleaseNotes, type ReleaseHistory, type ReleaseVersion } from '../release-notes';

const sha = (n: number) => `${String(n).padStart(4, '0')}${'a'.repeat(36)}`;

/** main's first-parent chain, newest first: PR #110 (head) … PR #101. */
const history: ReleaseHistory = {
  head: sha(10),
  entries: Array.from({ length: 10 }, (_, i) => ({ sha: sha(10 - i), title: `change ${10 - i}`, pr: 110 - i })),
};

/** The bundle: tagged v0.3.108-dev; the last deploy anywhere (another host) was v0.3.107-dev on commit 9. */
const current: ReleaseVersion = {
  version: '0.3.108',
  tag: 'v0.3.108-dev',
  commitHash: sha(10),
  previousVersion: '0.3.107',
  previousTag: 'v0.3.107-dev',
  releaseNotes: '• change 10 (#110)',
};

describe('hostReleaseNotes — what changed on this host', () => {
  it('a host that ran commit 3 announces every PR merged since then, with its own previous version', () => {
    const out = hostReleaseNotes(current, { version: '0.3.103', tag: 'v0.3.103-dev', commitHash: sha(3) }, history);
    expect(out).toEqual({
      fromVersion: '0.3.103',
      fromTag: 'v0.3.103-dev',
      notes: [
        '• change 10 (#110)',
        '• change 9 (#109)',
        '• change 8 (#108)',
        '• change 7 (#107)',
        '• change 6 (#106)',
        '• change 5 (#105)',
        '• change 4 (#104)',
      ].join('\n'),
      hostRelative: true,
    });
  });

  it('the same commit deployed again says so — never "Initial release"', () => {
    const out = hostReleaseNotes(current, { version: '0.3.107', tag: 'v0.3.107-dev', commitHash: sha(10) }, history);
    expect(out.notes).toBe('• 코드 변경 없음 — v0.3.107-dev와 같은 커밋 재배포');
    expect(out.fromTag).toBe('v0.3.107-dev');
  });

  it('a short sha (7+) on either side still matches', () => {
    const out = hostReleaseNotes(
      current,
      { version: '0.3.105', tag: 'v0.3.105-dev', commitHash: sha(8).slice(0, 8) },
      history,
    );
    expect(out.notes.split('\n')).toEqual(['• change 10 (#110)', '• change 9 (#109)']);
  });

  it('no previous version on this host (first deploy, older deploy script): the bundle default', () => {
    expect(hostReleaseNotes(current, null, history)).toEqual({
      fromVersion: '0.3.107',
      fromTag: 'v0.3.107-dev',
      notes: '• change 10 (#110)',
      hostRelative: false,
    });
  });

  it('the bundle default names the tag its notes actually start at', () => {
    const out = hostReleaseNotes({ ...current, releaseNotesBase: 'v0.3.106-dev' }, null, history);
    expect(out.fromTag).toBe('v0.3.106-dev');
  });

  it('a previous commit outside the shipped history keeps the host versions and says the list is partial', () => {
    const out = hostReleaseNotes(current, { version: '0.2.9', tag: 'v0.2.9-dev', commitHash: 'f'.repeat(40) }, history);
    expect(out.fromTag).toBe('v0.2.9-dev');
    expect(out.hostRelative).toBe(false);
    expect(out.notes).toContain('• change 10 (#110)');
    expect(out.notes).toContain('v0.2.9-dev 이후 전체 목록은 이력 범위 밖');
  });

  it('a history for another commit is not used', () => {
    const other = { ...history, head: sha(9) };
    const out = hostReleaseNotes(current, { version: '0.3.103', tag: 'v0.3.103-dev', commitHash: sha(3) }, other);
    expect(out.hostRelative).toBe(false);
  });
});

describe('formatReleaseNotes', () => {
  it('caps the list and escapes Slack markup', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ sha: sha(i), title: `t${i} <b> & co`, pr: i % 2 ? i : null }));
    const lines = formatReleaseNotes(many).split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe('• t0 &lt;b&gt; &amp; co');
    expect(lines[1]).toBe('• t1 &lt;b&gt; &amp; co (#1)');
    expect(lines[30]).toBe('… 외 3건');
  });
});
