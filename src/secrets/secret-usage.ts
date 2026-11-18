/**
 * Where configuration names each secret (secret-access, `.prd/33-secret-access-architecture.md` §2.1) — read from
 * the raw `server-tools` section of `config.json`, before any `{"$secret"}` is resolved. The 비밀 tab shows it as
 * "쓰는 곳", so an admin sees what a delete takes away.
 *
 * `server-tools` is the only section whose references the bot resolves (server-tools itself, and the phone
 * daemon for `phone.apiKey`), so it is the only one read.
 */

import * as fs from 'node:fs';
import { CONFIG_FILE } from '../env-paths';
import { Logger } from '../logger';

// biome-ignore lint/style/noCommonJs: @soma/process-shared sub-path types are not visible under moduleResolution node
const { isSecretRef } = require('@soma/process-shared/secret-ref.js') as {
  isSecretRef(value: unknown): value is { $secret: string };
};

const logger = new Logger('SecretUsage');

/** The reserved key of the section: tool levels, not a server (`mcp-tool-permission-config.ts`). */
const PERMISSION_KEY = 'permission';
const MAX_DEPTH = 32;

export interface SecretUsage {
  /** The server-tools server (environment) whose section names the secret. */
  server: string;
  /** Where in that server's section, dot-separated (`github.token`, `databases.app.password`). */
  path: string;
}

/** Every secret name the `server-tools` section refers to → where. */
export function secretUsages(section: unknown): Map<string, SecretUsage[]> {
  const out = new Map<string, SecretUsage[]>();
  if (!section || typeof section !== 'object' || Array.isArray(section)) return out;
  for (const [server, entry] of Object.entries(section as Record<string, unknown>)) {
    if (server === PERMISSION_KEY) continue;
    walk(entry, [], 0, (name, at) => {
      const list = out.get(name) ?? [];
      list.push({ server, path: at.join('.') });
      out.set(name, list);
    });
  }
  return out;
}

function walk(value: unknown, at: string[], depth: number, found: (name: string, at: string[]) => void): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  if (isSecretRef(value)) {
    found(value.$secret, at);
    return;
  }
  // A `$secret` key in another shape is a reference written wrong; server-tools refuses it, nothing to list.
  if (!Array.isArray(value) && Object.keys(value).includes('$secret')) return;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  for (const [key, child] of entries) walk(child, [...at, key], depth + 1, found);
}

let cache: { file: string; mtimeMs: number; size: number; section: Record<string, unknown> | null } | undefined;

/**
 * The raw `server-tools` section of `configFile`, re-read when the file changes. Null without a file or a section.
 * A file that stops parsing (a half-written edit) keeps the last section read — as server-tools does.
 */
export function loadServerToolsSection(configFile: string = CONFIG_FILE): Record<string, unknown> | null {
  if (!configFile) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configFile);
  } catch (error) {
    // Gone for a moment (an editor's rename): keep the last section read, as server-tools keeps its servers.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') logger.warn('config.json cannot be checked while listing secret usages', { code });
    return cache && cache.file === configFile ? cache.section : null;
  }
  if (cache && cache.file === configFile && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.section;
  }
  let section: Record<string, unknown> | null;
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown> | null;
    const value = raw?.['server-tools'];
    section = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch (error) {
    // Never the message: a JSON parse error quotes the text around the fault — a literal credential in a bad edit.
    logger.warn('config.json unreadable while listing secret usages — keeping the last section read', {
      error: (error as Error)?.name ?? 'Error',
      code: (error as NodeJS.ErrnoException)?.code,
    });
    return cache && cache.file === configFile ? cache.section : null;
  }
  cache = { file: configFile, mtimeMs: stat.mtimeMs, size: stat.size, section };
  return section;
}
