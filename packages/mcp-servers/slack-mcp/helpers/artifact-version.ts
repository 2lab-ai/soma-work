/**
 * #1074 — the version an upload is, said in the upload itself.
 *
 * The daemon records versions in the session's artifact index (`DATA_DIR/artifacts/<conversation>/index.json`)
 * after an upload's result arrives. Before the upload, this reads that index (path from SOMA_ARTIFACT_INDEX)
 * and applies the same rule (somalib/artifacts/artifact-version.ts), so the comment posted with the file and
 * the tool's result say the version the daemon will record.
 */

import {
  type ArtifactVersionRow,
  artifactKeyFor,
  assignArtifactVersions,
  planArtifactVersion,
} from '@soma/process-shared/artifacts/artifact-version.js';
import { createHash } from 'crypto';
import { createReadStream, readFileSync } from 'fs';

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
}): Promise<UploadVersion | null> {
  if (!input.indexPath) return null;
  const sha256 = await sha256File(input.filePath);
  const key = artifactKeyFor({ key: input.artifactKey, name: input.displayName });
  const plan = planArtifactVersion(readArtifactRows(input.indexPath), key, sha256);
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
  return {
    artifact_key: v.artifact_key,
    version: v.version,
    changed: v.changed,
    previous_version: v.previous_version,
    sha256: v.sha256,
  };
}
