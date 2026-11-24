/**
 * What changed on THIS host — the range a release notice announces.
 *
 * Dev tags are global: every deploy to any host makes one, so the version.json a bundle carries describes "since the
 * last deploy anywhere". A host deployed once a day skips many of them, and a host that gets a commit another host got
 * an hour earlier sees an empty range (its notes read "Initial release" — 2026-11-21, v0.3.102-dev and v0.3.103-dev
 * on one commit). The deploy keeps the version.json it replaced on this host (scripts/deploy/sync-bundle.sh →
 * dist/previous-version.json) and the build ships main's recent first-parent history (scripts/release-notes.mjs →
 * dist/release-history.json); the notice is the slice between the two.
 */

/** One first-parent commit of main: a merged PR, or a direct commit. */
export interface ReleaseHistoryEntry {
  readonly sha: string;
  readonly title: string;
  readonly pr: number | null;
}

/** dist/release-history.json: main's newest first-parent commits up to the shipped commit, newest first. */
export interface ReleaseHistory {
  readonly head: string;
  readonly entries: readonly ReleaseHistoryEntry[];
}

/** The fields of a version.json this module reads. */
export interface ReleaseVersion {
  readonly version: string;
  readonly tag: string;
  readonly commitHash: string;
  readonly previousVersion: string;
  readonly previousTag: string;
  readonly releaseNotes: string;
}

/** What one host announces. */
export interface HostRelease {
  /** The version this host ran before (the bundle's global previous when the host's own is unknown). */
  readonly fromVersion: string;
  readonly fromTag: string;
  readonly notes: string;
  /** True when the notes are this host's own range; false when they are the bundle's default. */
  readonly hostRelative: boolean;
}

export const MAX_NOTES = 30;

/** Slack mrkdwn control characters (`&`, `<`, `>`) in a commit title would read as markup. */
function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One bullet per entry, newest first; past `max`, one line says how many more. Same shape as release-notes.mjs. */
export function formatReleaseNotes(entries: readonly ReleaseHistoryEntry[], max = MAX_NOTES): string {
  const lines = entries.slice(0, max).map((e) => `• ${escapeMrkdwn(e.title)}${e.pr ? ` (#${e.pr})` : ''}`);
  if (entries.length > max) lines.push(`… 외 ${entries.length - max}건`);
  return lines.join('\n');
}

const sameCommit = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 40);
  return n >= 7 && a.slice(0, n) === b.slice(0, n);
};

/**
 * The notice for `current` on a host that ran `previous` until this deploy (`null`: unknown — a first deploy, or one
 * made by an older deploy script). `history` is the shipped first-parent history (`null`: not in the bundle).
 */
export function hostReleaseNotes(
  current: ReleaseVersion,
  previous: Pick<ReleaseVersion, 'version' | 'tag' | 'commitHash'> | null,
  history: ReleaseHistory | null,
): HostRelease {
  const bundleDefault: HostRelease = {
    fromVersion: current.previousVersion,
    fromTag: current.previousTag,
    notes: current.releaseNotes,
    hostRelative: false,
  };
  if (!previous?.commitHash) return bundleDefault;

  const from = { fromVersion: previous.version, fromTag: previous.tag };
  if (sameCommit(previous.commitHash, current.commitHash)) {
    return { ...from, notes: `• 코드 변경 없음 — ${previous.tag}와 같은 커밋 재배포`, hostRelative: true };
  }

  if (history && sameCommit(history.head, current.commitHash)) {
    const index = history.entries.findIndex((e) => sameCommit(e.sha, previous.commitHash));
    if (index > 0) {
      return { ...from, notes: formatReleaseNotes(history.entries.slice(0, index)), hostRelative: true };
    }
  }

  // The host's previous commit is not on the shipped history (older than its window, or a rollback): the versions
  // are still this host's, the list is the bundle's.
  return {
    ...from,
    notes: `${current.releaseNotes}\n_(이 호스트가 돌던 ${previous.tag} 이후 전체 목록은 이력 범위 밖이라 직전 배포 이후만 표시)_`,
    hostRelative: false,
  };
}
