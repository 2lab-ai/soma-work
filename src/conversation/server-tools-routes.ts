/**
 * The settings page 서버 도구 tab's HTTP surface (secret-access WU3, #1339, `.prd/32-secret-access-spec.md` §4.3).
 *
 *   GET    /api/server-tools                          every tool, every server, the grants — no secret value
 *   PUT    /api/server-tools/permission/:tool         { level: 'read' | 'write' | null } — one tool's level
 *   POST   /api/server-tools/permission               make a map where there is none (#1170), catalog defaults
 *   POST   /api/server-tools/grants                   { userId, level, duration } — a server-tools grant
 *   DELETE /api/server-tools/grants/:userId/:level
 *   POST   /api/server-tools/environments/:envId/users { userId, allow } — an environment grant
 *
 * The same door as the 비밀 tab (`namedAdmin`): an admin signed in with Slack reads; a change also needs admin
 * mode and CSRF. Each store stays the one it is — the levels in `config.json` `server-tools.permission`, the
 * server-tools grants in `mcp-tool-grants.json`, the environment grants in `env-skill-grants.json` — and every
 * change is a line in the audit ledger. Admin-only tools are defined in code (`server-tools-admin/catalog.ts`)
 * and have no level here.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG_FILE, DATA_DIR, SECRETS_DIR } from '../env-paths';
import { isEnvironmentId, loadEnvironments } from '../env-users';
import { Logger } from '../logger';
import { MAX_GRANT_DURATION_MS, mcpToolGrantStore, parseDuration } from '../mcp-tool-grant-store';
import { listSecrets } from '../secrets/secret-admin-store';
import { appendSecretAudit, type SecretAuditRecord } from '../secrets/secret-audit';
import { loadServerToolsSection, secretUsages } from '../secrets/secret-usage';
import {
  defaultLevel,
  SERVER_TOOLS_CATALOG,
  type ServerToolEntry,
  type ServerToolSection,
} from '../server-tools-admin/catalog';
import {
  createPermissionMap,
  PermissionMapError,
  readPermissionMap,
  setToolLevel,
  type ToolLevel,
} from '../server-tools-admin/permission-map';
import { environmentGrantees, grantEnvironment, revokeEnvironment } from '../user-skill-grants-store';
import { knownUsers, namedAdmin } from './secrets-routes';

const logger = new Logger('ServerToolsRoutes');

/** The MCP server the levels and grants are about. */
const SERVER = 'server-tools';
const PERMISSION_KEY = 'permission';
/** The order a server's sections are shown in. */
const SECTION_ORDER: readonly ServerToolSection[] = ['ssh', 'databases', 'github', 'web', 'cloudflare', 'phone'];

const REFUSAL = {
  read: '서버 도구 권한은 Slack 계정으로 로그인한 관리자만 보고 바꿉니다',
  change: '관리자 모드를 켜야 서버 도구 권한을 바꿀 수 있습니다',
};

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface Paths {
  secretsDir: string;
  dataDir: string;
  configFile: string;
}

let _paths: Paths | null = null;

/** Tests: the secret store (for "is it there"), the data directory (ledger) and the config file. */
export function setServerToolsPathsForTests(paths: Paths | null): void {
  _paths = paths;
}

function paths(): Paths {
  return _paths ?? { secretsDir: SECRETS_DIR, dataDir: DATA_DIR, configFile: CONFIG_FILE };
}

function present(entry: Record<string, unknown>, section: ServerToolSection): boolean {
  const value = entry[section];
  return !!value && typeof value === 'object';
}

/** A tool can run on a server that has every section it needs (`list` needs none). */
function runsOn(tool: ServerToolEntry, entry: Record<string, unknown>): boolean {
  return tool.sections.every((s) => present(entry, s));
}

function servers(section: Record<string, unknown> | null, secretsDir: string) {
  if (!section) return [];
  const stored = new Set(listSecrets(secretsDir).map((s) => s.name));
  const usages = secretUsages(section);
  const out = [];
  for (const [name, value] of Object.entries(section)) {
    if (name === PERMISSION_KEY || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const envUser = isEnvironmentId(entry.envUser) ? entry.envUser : undefined;
    const secrets: Array<{ name: string; path: string; exists: boolean }> = [];
    for (const [secret, where] of usages) {
      for (const use of where) {
        if (use.server === name) secrets.push({ name: secret, path: use.path, exists: stored.has(secret) });
      }
    }
    out.push({
      name,
      ...(envUser ? { envUser } : {}),
      sections: SECTION_ORDER.filter((s) => present(entry, s)),
      tools: SERVER_TOOLS_CATALOG.filter((t) => runsOn(t, entry)).map((t) => t.name),
      secrets,
      environmentUsers: envUser ? environmentGrantees(envUser) : [],
    });
  }
  return out;
}

function toolGrants() {
  return mcpToolGrantStore.listServerGrants(SERVER).map((g) => ({
    userId: g.userId,
    level: g.level,
    expiresAt: g.entry.expiresAt,
    grantedBy: g.entry.grantedBy,
  }));
}

function refuse(reply: FastifyReply, what: string, error: unknown): void {
  if (error instanceof PermissionMapError) {
    reply.status(error.statusCode).send({ error: error.message });
    return;
  }
  logger.error(`Error ${what}`, { error: (error as Error)?.name, code: (error as NodeJS.ErrnoException)?.code });
  reply.status(500).send({ error: 'Internal Server Error' });
}

/**
 * The change is made; write it down. A ledger that fails is logged and named in the answer — the change itself
 * stands (a permission rewritten twice would be worse than a missing line).
 */
function audit(record: SecretAuditRecord): boolean {
  try {
    appendSecretAudit(record, paths().dataDir);
    return true;
  } catch (error) {
    logger.error('Server-tools permission changed but the audit ledger could not be written', {
      action: record.action,
      name: record.name,
      code: (error as NodeJS.ErrnoException)?.code,
    });
    return false;
  }
}

const AUDIT_FAILED = '바뀌었지만 감사 기록을 남기지 못했습니다 — 호스트의 데이터 디렉터리를 확인하세요';

function isLevel(value: unknown): value is ToolLevel {
  return value === 'read' || value === 'write';
}

export function registerServerToolsRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/server-tools', read, async (request, reply) => {
    if (!namedAdmin(request, reply, false, REFUSAL)) return;
    try {
      const { secretsDir, configFile } = paths();
      const map = readPermissionMap(configFile);
      reply.header('Cache-Control', 'no-store').send({
        permissionMap: map.present ? 'present' : 'missing',
        tools: SERVER_TOOLS_CATALOG.map((t) => ({
          name: t.name,
          summary: t.summary,
          access: t.access,
          sections: t.sections,
          ...(t.optionalSections ? { optionalSections: t.optionalSections } : {}),
          usesSecrets: t.usesSecrets,
          level: t.adminOnly ? null : (map.levels[t.name] ?? null),
          adminOnly: !!t.adminOnly,
        })),
        servers: servers(loadServerToolsSection(configFile), secretsDir),
        toolGrants: toolGrants(),
        users: knownUsers(),
        maxGrant: '4w',
      });
    } catch (error) {
      refuse(reply, 'listing server tools', error);
    }
  });

  server.put<{ Params: { tool: string }; Body: { level?: unknown } }>(
    '/api/server-tools/permission/:tool',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true, REFUSAL);
      if (!actor) return;
      const tool = SERVER_TOOLS_CATALOG.find((t) => t.name === request.params.tool);
      if (!tool) {
        reply.status(404).send({ error: '그런 서버 도구가 없습니다' });
        return;
      }
      if (tool.adminOnly) {
        reply.status(400).send({ error: '관리자 전용 도구라 수준을 바꿀 수 없습니다(코드에 정해져 있음)' });
        return;
      }
      const level = (request.body || {}).level;
      if (level !== null && !isLevel(level)) {
        reply.status(400).send({ error: '수준은 read · write · 없음 중 하나입니다' });
        return;
      }
      try {
        const { from, to } = setToolLevel(paths().configFile, tool.name, level);
        const audited = audit({ actor, action: 'tool.level', name: tool.name, from: from ?? 'none', to: to ?? 'none' });
        logger.info('Server-tools level changed from the settings page', { tool: tool.name, from, to, actor });
        reply.send({ ok: true, from, to, ...(audited ? {} : { warning: AUDIT_FAILED }) });
      } catch (error) {
        refuse(reply, 'changing a server-tools level', error);
      }
    },
  );

  server.post('/api/server-tools/permission', write, async (request, reply) => {
    const actor = namedAdmin(request, reply, true, REFUSAL);
    if (!actor) return;
    try {
      const levels = Object.fromEntries(
        SERVER_TOOLS_CATALOG.filter((t) => !t.adminOnly).map((t) => [t.name, defaultLevel(t)]),
      );
      createPermissionMap(paths().configFile, levels);
      const audited = audit({ actor, action: 'tool.map.create', name: PERMISSION_KEY });
      logger.info('Server-tools permission map created from the settings page', { actor });
      reply.send({ ok: true, levels, ...(audited ? {} : { warning: AUDIT_FAILED }) });
    } catch (error) {
      refuse(reply, 'creating the server-tools permission map', error);
    }
  });

  server.post<{ Body: { userId?: unknown; level?: unknown; duration?: unknown } }>(
    '/api/server-tools/grants',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true, REFUSAL);
      if (!actor) return;
      const { userId, level, duration } = request.body || {};
      if (typeof userId !== 'string' || !isLevel(level) || typeof duration !== 'string') {
        reply.status(400).send({ error: 'userId, level(read · write), duration이 필요합니다' });
        return;
      }
      const ms = parseDuration(duration);
      if (ms === null || ms > MAX_GRANT_DURATION_MS) {
        reply.status(400).send({ error: '기간은 24h · 7d · 4w 꼴로, 최대 4주입니다' });
        return;
      }
      try {
        if (!knownUsers().some((u) => u.id === userId)) {
          reply.status(400).send({ error: '승인된 사용자가 아닙니다' });
          return;
        }
        const expiresAt = new Date(Date.now() + ms).toISOString();
        mcpToolGrantStore.setGrant(userId, SERVER, level, expiresAt, actor);
        const audited = audit({ actor, action: 'tool.grant.add', name: SERVER, userId, level, expiresAt });
        logger.info('Server-tools grant added from the settings page', { userId, level, expiresAt, actor });
        reply.send({ ok: true, toolGrants: toolGrants(), ...(audited ? {} : { warning: AUDIT_FAILED }) });
      } catch (error) {
        refuse(reply, 'adding a server-tools grant', error);
      }
    },
  );

  server.delete<{ Params: { userId: string; level: string } }>(
    '/api/server-tools/grants/:userId/:level',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true, REFUSAL);
      if (!actor) return;
      const { userId, level } = request.params;
      if (!isLevel(level)) {
        reply.status(400).send({ error: '수준은 read · write 중 하나입니다' });
        return;
      }
      try {
        mcpToolGrantStore.revokeGrant(userId, SERVER, level);
        const audited = audit({ actor, action: 'tool.grant.remove', name: SERVER, userId, level });
        logger.info('Server-tools grant revoked from the settings page', { userId, level, actor });
        reply.send({ ok: true, toolGrants: toolGrants(), ...(audited ? {} : { warning: AUDIT_FAILED }) });
      } catch (error) {
        refuse(reply, 'revoking a server-tools grant', error);
      }
    },
  );

  server.post<{ Params: { envId: string }; Body: { userId?: unknown; allow?: unknown } }>(
    '/api/server-tools/environments/:envId/users',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true, REFUSAL);
      if (!actor) return;
      const { envId } = request.params;
      const { userId, allow } = request.body || {};
      if (typeof userId !== 'string' || typeof allow !== 'boolean') {
        reply.status(400).send({ error: 'userId와 allow가 필요합니다' });
        return;
      }
      try {
        if (!loadEnvironments(paths().configFile).some((e) => e.id === envId)) {
          reply.status(404).send({ error: '그런 환경이 없습니다' });
          return;
        }
        if (allow && !knownUsers().some((u) => u.id === userId)) {
          reply.status(400).send({ error: '승인된 사용자가 아닙니다' });
          return;
        }
        if (allow) grantEnvironment(envId, userId);
        else revokeEnvironment(envId, userId);
        const audited = audit({ actor, action: allow ? 'env.grant.add' : 'env.grant.remove', name: envId, userId });
        logger.info('Environment grant changed from the settings page', { envId, userId, allow, actor });
        reply.send({
          ok: true,
          environmentUsers: environmentGrantees(envId),
          ...(audited ? {} : { warning: AUDIT_FAILED }),
        });
      } catch (error) {
        refuse(reply, 'changing an environment grant', error);
      }
    },
  );
}
