/**
 * #1074 — the version an upload is, said in the upload itself (slack-mcp send_file / send_media).
 *
 * The daemon records versions in the session's artifact index (`DATA_DIR/artifacts/<conversation>/index.json`)
 * after an upload's result arrives. Before the upload, this reads that index (path from SOMA_ARTIFACT_INDEX)
 * and applies the same rule (./artifact-version.ts), so the comment posted with the file and
 * the tool's result say the version the daemon will record.
 *
 * The daemon records an upload only when its result reaches the work log, so the index lags this process's own
 * uploads. `UploadVersions` closes that gap for one slack-mcp process: uploads of one key run one at a time, and
 * the ones it already sent count until the index has them (matched by Slack file id). Two processes uploading one
 * key at the same moment (not one session's turn) can still announce the same version; the daemon's record wins.
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import {
  type ArtifactVersionRow,
  artifactKeyFor,
  assignArtifactVersions,
  planArtifactVersion,
} from './artifact-version';

export type VersionLang = 'ko' | 'en';

/** The comment line, per display language (the slack-mcp process has no text catalog). */
const NOTE: Record<
  VersionLang,
  { changed(v: number): string; unchanged(v: number): string; plain(v: number): string }
> = {
  ko: {
    changed: (v) => `판 ${v} · 이전 판 이후 바뀜`,
    unchanged: (v) => `판 ${v} · 바뀐 것 없음`,
    plain: (v) => `판 ${v}`,
  },
  en: {
    changed: (v) => `Version ${v} · changed since the previous version`,
    unchanged: (v) => `Version ${v} · no changes`,
    plain: (v) => `Version ${v}`,
  },
};

/** The daemon cuts a display name to this length before keying it (artifacts.ts `recordSlackUpload`). */
const MAX_NAME = 200;

export interface UploadVersion {
  artifact_key: string;
  version: number;
  /** true: differs from the previous version; false: the same content; null: none to compare. */
  changed: boolean | null;
  previous_version: number | null;
  sha256: string;
  /** The comment line; '' for a first version. */
  note: string;
}

function rowsOf(file: string): ArtifactVersionRow[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { artifacts?: unknown };
    if (!parsed || !Array.isArray(parsed.artifacts)) return null;
    return parsed.artifacts.filter(
      (a): a is ArtifactVersionRow =>
        !!a && typeof (a as ArtifactVersionRow).id === 'string' && typeof (a as ArtifactVersionRow).name === 'string',
    );
  } catch {
    return null;
  }
}

/** The session's recorded artifacts with keys and versions (the index, else its `.bak`, else none). */
export function readArtifactRows(indexPath: string): ArtifactVersionRow[] {
  const rows = rowsOf(indexPath) ?? rowsOf(`${indexPath}.bak`) ?? [];
  return assignArtifactVersions(rows).filter((r) => r.source !== 'final_answer');
}

/** A row this process sent, by Slack file id: counted until the daemon's index lists that file. */
export interface SentRow extends ArtifactVersionRow {
  slackFileId: string;
}

/** Index rows plus this process's sent uploads the index does not list yet. */
function withSent(rows: ArtifactVersionRow[], sent: readonly SentRow[] | undefined): ArtifactVersionRow[] {
  if (!sent?.length) return rows;
  const known = new Set<string>();
  for (const r of rows as Array<ArtifactVersionRow & { slackFileId?: string; resentFileIds?: string[] }>) {
    if (r.slackFileId) known.add(r.slackFileId);
    for (const id of r.resentFileIds ?? []) known.add(id);
  }
  return [...rows, ...sent.filter((s) => !known.has(s.slackFileId))];
}

/** Per slack-mcp process: one upload of a key at a time, and the versions it sent (see the header). */
export class UploadVersions {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly rows: SentRow[] = [];

  /** Run `fn` after every earlier `serialize` of the same key has settled. */
  serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** A version this process uploaded (Slack file id), until the index lists it. */
  remember(slackFileId: string, v: UploadVersion): void {
    this.rows.push({ id: slackFileId, slackFileId, key: v.artifact_key, version: v.version, sha256: v.sha256 });
    if (this.rows.length > 100) this.rows.shift();
  }

  sent(): readonly SentRow[] {
    return this.rows;
  }
}

/** The key an upload is grouped by — what `serialize` takes. */
export function uploadKey(displayName: string, artifactKey: unknown): string {
  return artifactKeyFor({ key: artifactKey, name: displayName.slice(0, MAX_NAME) });
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** null when no index is configured: nothing is claimed about versions. */
export async function planUploadVersion(input: {
  indexPath?: string;
  filePath: string;
  displayName: string;
  artifactKey?: unknown;
  lang: VersionLang;
  /** This process's uploads the index may not list yet (`UploadVersions.sent()`). */
  sent?: readonly SentRow[];
}): Promise<UploadVersion | null> {
  if (!input.indexPath) return null;
  const sha256 = await sha256File(input.filePath);
  const key = uploadKey(input.displayName, input.artifactKey);
  const plan = planArtifactVersion(withSent(readArtifactRows(input.indexPath), input.sent), key, sha256);
  const t = NOTE[input.lang] ?? NOTE.ko;
  const note = !plan.previous
    ? ''
    : plan.unchanged
      ? t.unchanged(plan.version)
      : plan.changed
        ? t.changed(plan.version)
        : t.plain(plan.version);
  return {
    artifact_key: key,
    version: plan.version,
    changed: plan.changed,
    previous_version: plan.previous ? (plan.previous.version ?? 1) : null,
    sha256,
    note,
  };
}

/** The comment posted with the file: the version line first, then the model's comment. */
export function commentWithVersion(note: string, comment: string | undefined): string | undefined {
  if (!note) return comment;
  return comment ? `${note}\n${comment}` : note;
}

/** The fields a send_file / send_media reply carries about the version. */
export function versionFields(v: UploadVersion | null): Record<string, unknown> {
  if (!v) return {};
  // The derived key (`name:…`, `key:…`) is `version_key`: `artifact_key` is only ever the model's own.
  return {
    version_key: v.artifact_key,
    version: v.version,
    changed: v.changed,
    previous_version: v.previous_version,
    sha256: v.sha256,
  };
}
