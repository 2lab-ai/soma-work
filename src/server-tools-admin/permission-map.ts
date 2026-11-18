/**
 * The server-tools tool levels, edited where they live (secret-access WU3, #1339, `.prd/32-secret-access-spec.md`
 * D10): `config.json` `server-tools.permission` — `{ <tool>: "read" | "write" }`, read by the policy hook on every
 * turn and by the MCP config builder at query start. No second store.
 *
 * A change rewrites that one key: the file is parsed raw (no `${VAR}` substitution, `{"$secret"}` untouched),
 * the key is set, the whole document is written back atomically with the same key order. Just before writing the
 * file is read again; when it differs from what was parsed, another writer got there first and nothing is written
 * (409) — never a silent overwrite of someone's edit.
 */

import * as fs from 'node:fs';
import { writeConfigFileAtomically } from '../config-loader';

export type ToolLevel = 'read' | 'write';

export class PermissionMapError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 | 500,
  ) {
    super(message);
    this.name = 'PermissionMapError';
  }
}

type Doc = Record<string, unknown>;

function parse(configFile: string): { text: string; doc: Doc; section: Doc } {
  let text: string;
  try {
    text = fs.readFileSync(configFile, 'utf-8');
  } catch {
    throw new PermissionMapError('설정 파일을 읽지 못했습니다', 409);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PermissionMapError('설정 파일이 올바른 JSON이 아닙니다 — 호스트에서 확인하세요', 409);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PermissionMapError('설정 파일이 올바른 JSON 객체가 아닙니다', 409);
  }
  const section = (doc as Doc)['server-tools'];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new PermissionMapError('설정에 server-tools 절이 없습니다', 409);
  }
  return { text, doc: doc as Doc, section: section as Doc };
}

function levelsOf(section: Doc): { present: boolean; levels: Record<string, ToolLevel> } {
  const map = section.permission;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { present: false, levels: {} };
  const levels: Record<string, ToolLevel> = {};
  for (const [tool, level] of Object.entries(map as Doc)) {
    if (level === 'read' || level === 'write') levels[tool] = level;
  }
  // A map without one valid level counts as missing — the loader drops it (mcp-tool-permission-config.ts, #1170).
  return { present: Object.keys(levels).length > 0, levels };
}

/** The map as the loader sees it, or `present: false` when there is none (or no `server-tools` section). */
export function readPermissionMap(configFile: string): { present: boolean; levels: Record<string, ToolLevel> } {
  try {
    return levelsOf(parse(configFile).section);
  } catch {
    return { present: false, levels: {} };
  }
}

interface WriteHooks {
  /** Tests: runs between the parse and the re-read that guards the write. */
  beforeWrite?: () => void;
}

function writeBack(configFile: string, original: string, doc: Doc, hooks?: WriteHooks): void {
  hooks?.beforeWrite?.();
  let now: string;
  try {
    now = fs.readFileSync(configFile, 'utf-8');
  } catch {
    throw new PermissionMapError('설정 파일을 다시 읽지 못했습니다', 409);
  }
  if (now !== original) {
    throw new PermissionMapError('그사이 설정 파일이 바뀌었습니다 — 새로 불러온 뒤 다시 하세요', 409);
  }
  try {
    writeConfigFileAtomically(configFile, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (error) {
    throw new PermissionMapError(
      `설정 파일을 쓰지 못했습니다 (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`,
      500,
    );
  }
}

/** Set (or with `null`, remove) one tool's level. Returns the level before and after. */
export function setToolLevel(
  configFile: string,
  tool: string,
  level: ToolLevel | null,
  hooks?: WriteHooks,
): { from: ToolLevel | null; to: ToolLevel | null } {
  if (level !== null && level !== 'read' && level !== 'write') {
    throw new PermissionMapError('수준은 read · write · 없음 중 하나입니다', 400);
  }
  const { text, doc, section } = parse(configFile);
  const current = section.permission;
  const map: Doc = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Doc) } : {};
  const before = map[tool];
  const from: ToolLevel | null = before === 'read' || before === 'write' ? before : null;
  if (level === null) delete map[tool];
  else map[tool] = level;
  // Same key order: `permission` stays where it was (first, when new — the documented shape).
  doc['server-tools'] = 'permission' in section ? { ...section, permission: map } : { permission: map, ...section };
  writeBack(configFile, text, doc, hooks);
  return { from, to: level };
}

/** "표 만들기": write a whole map where there is none (409 when one exists). */
export function createPermissionMap(configFile: string, levels: Record<string, ToolLevel>, hooks?: WriteHooks): void {
  const { text, doc, section } = parse(configFile);
  if (levelsOf(section).present) throw new PermissionMapError('권한 표가 이미 있습니다', 409);
  const { permission: _empty, ...rest } = section;
  doc['server-tools'] = { permission: { ...levels }, ...rest };
  writeBack(configFile, text, doc, hooks);
}
