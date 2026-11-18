/**
 * The settings page 비밀 tab's HTTP surface (secret-access WU1, #1337, `.prd/33-secret-access-architecture.md` §5).
 *
 *   GET    /api/secrets          names · last change · who changed it · where configuration uses it — no values
 *   PUT    /api/secrets/:name    { value, overwrite? } — add, or replace with overwrite
 *   DELETE /api/secrets/:name
 *   POST   /api/secrets/:name/grants   { userId, allow } — who may have their tools use it (secret-access WU2)
 *
 * Only an admin signed in with Slack (`oauth_jwt`, `ADMIN_USERS`, not an environment user) reads or changes it;
 * a change needs admin mode (`X-Admin-Mode: on`) and CSRF. The viewer token and a dashboard without sign-in are
 * refused even for reading: every change is written to the audit ledger under a person's id (.prd/32 D9).
 *
 * A value travels one way — in the PUT body, to the file. No answer, log line or ledger line carries it; the
 * web server's logger is off, and nothing here logs a body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAdminUser } from '../admin-utils';
import { CONFIG_FILE, DATA_DIR, SECRETS_DIR } from '../env-paths';
import { isEnvironmentId, loadEnvironments } from '../env-users';
import { Logger } from '../logger';
import { deleteSecret, listSecrets, SecretAdminError, writeSecret } from '../secrets/secret-admin-store';
import { appendSecretAudit, lastSecretChanges, type SecretAuditAction } from '../secrets/secret-audit';
import { loadServerToolsSection, secretUsages } from '../secrets/secret-usage';
import { userSettingsStore } from '../user-settings-store';
import { environmentGrantees, grantSecret, revokeSecret, secretGrantees } from '../user-skill-grants-store';

const logger = new Logger('SecretsRoutes');

// biome-ignore lint/style/noCommonJs: @soma/process-shared sub-path types are not visible under moduleResolution node
const { isSecretName } = require('@soma/process-shared/secret-ref.js') as { isSecretName(name: unknown): boolean };

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface Paths {
  secretsDir: string;
  dataDir: string;
  configFile: string;
}

let _paths: Paths | null = null;

/** A user of the picker (the user settings store's rows). */
export interface SecretsUserRow {
  userId: string;
  slackName?: string;
  slackDisplayName?: string;
  accepted?: boolean;
}

let _users: (() => SecretsUserRow[]) | null = null;

/** Tests: the users the picker offers. */
export function setSecretsUserSourceForTests(fn: (() => SecretsUserRow[]) | null): void {
  _users = fn;
}

/** Accepted users, as the picker shows them (the 서버 도구 tab's picker too). */
export function knownUsers(): Array<{ id: string; name: string }> {
  const rows: SecretsUserRow[] = _users ? _users() : userSettingsStore.getAllUsers();
  return rows
    .filter((u) => u.accepted === true && !!u.userId)
    .map((u) => ({ id: u.userId, name: u.slackDisplayName || u.slackName || u.userId }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Who may have their tools use secret `name`, beyond admins and environment users (who always may): the direct
 * grants (the 3-answer card's "always", or this tab), and — derived, edited on the environment — the holders of
 * the environment grant of each environment server that uses it.
 */
function accessOf(name: string, usages: ReadonlyArray<{ server: string }>, configFile: string) {
  const environments = loadEnvironments(configFile);
  const seen = new Set<string>();
  const viaEnvironment: Array<{ id: string; server: string; users: string[] }> = [];
  for (const { server } of usages) {
    const env = environments.find((e) => e.servers.includes(server));
    if (!env || seen.has(env.id)) continue;
    seen.add(env.id);
    viaEnvironment.push({ id: env.id, server, users: environmentGrantees(env.id) });
  }
  return { direct: secretGrantees(name), environments: viaEnvironment };
}

/** Tests: the store, the data directory (ledger) and the config file to read usages from. */
export function setSecretsPathsForTests(paths: Paths | null): void {
  _paths = paths;
}

function paths(): Paths {
  return _paths ?? { secretsDir: SECRETS_DIR, dataDir: DATA_DIR, configFile: CONFIG_FILE };
}

/**
 * The admin behind this request, or null after sending the refusal. A person signed in with Slack who is an
 * admin; for a change, with admin mode on.
 */
export function namedAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
  change: boolean,
  refusal: { read: string; change: string } = SECRETS_REFUSAL,
): string | null {
  const auth = (request as { authContext?: { mode?: string; userId?: string } }).authContext;
  const userId = auth?.mode === 'oauth_jwt' ? auth.userId : undefined;
  if (!userId || isEnvironmentId(userId) || !isAdminUser(userId)) {
    reply.status(403).send({ error: refusal.read });
    return null;
  }
  if (change && request.headers['x-admin-mode'] !== 'on') {
    reply.status(403).send({ error: refusal.change });
    return null;
  }
  return userId;
}

const SECRETS_REFUSAL = {
  read: '비밀은 Slack 계정으로 로그인한 관리자만 보고 바꿉니다',
  change: '관리자 모드를 켜야 비밀을 바꿀 수 있습니다',
};

/** The name the dashboard shows for a Slack id (the id itself when the store has none). */
function displayName(userId: string): string {
  try {
    const row = userSettingsStore.getUserSettings(userId);
    return row?.slackDisplayName || row?.slackName || userId;
  } catch {
    return userId;
  }
}

function refuse(reply: FastifyReply, what: string, error: unknown): void {
  if (error instanceof SecretAdminError) {
    reply.status(error.statusCode).send({ error: error.message });
    return;
  }
  // The error may carry a path; never a value (nothing here puts one in an error).
  logger.error(`Error ${what}`, { error: (error as Error)?.name, code: (error as NodeJS.ErrnoException)?.code });
  reply.status(500).send({ error: 'Internal Server Error' });
}

/** The change is made; write it down. A ledger that fails is reported, not hidden. */
function audit(reply: FastifyReply, actor: string, action: SecretAuditAction, name: string): boolean {
  try {
    appendSecretAudit({ actor, action, name }, paths().dataDir);
    return true;
  } catch (error) {
    logger.error('Secret changed but the audit ledger could not be written', {
      action,
      name,
      code: (error as NodeJS.ErrnoException)?.code,
    });
    reply
      .status(500)
      .send({ error: '비밀은 바뀌었지만 감사 기록을 남기지 못했습니다 — 호스트의 데이터 디렉터리를 확인하세요' });
    return false;
  }
}

export function registerSecretsRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware?: Middleware,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/secrets', read, async (request, reply) => {
    if (!namedAdmin(request, reply, false)) return;
    try {
      const { secretsDir, dataDir, configFile } = paths();
      const usages = secretUsages(loadServerToolsSection(configFile));
      const changes = lastSecretChanges(dataDir);
      const stored = listSecrets(secretsDir);
      const names = new Set(stored.map((s) => s.name));
      reply.header('Cache-Control', 'no-store').send({
        secrets: stored.map((s) => {
          const change = changes.get(s.name);
          return {
            name: s.name,
            updatedAt: s.updatedAt,
            ...(change && change.action !== 'secret.delete'
              ? { updatedBy: change.actor, updatedByName: displayName(change.actor) }
              : {}),
            usages: usages.get(s.name) ?? [],
            access: accessOf(s.name, usages.get(s.name) ?? [], configFile),
          };
        }),
        users: knownUsers(),
        missing: [...usages.entries()]
          .filter(([name]) => !names.has(name))
          .map(([name, where]) => ({ name, usages: where }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    } catch (error) {
      refuse(reply, 'listing secrets', error);
    }
  });

  server.put<{ Params: { name: string }; Body: { value?: unknown; overwrite?: unknown } }>(
    '/api/secrets/:name',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true);
      if (!actor) return;
      const body = request.body || {};
      try {
        const { entry, created } = writeSecret(
          request.params.name,
          body.value as string,
          { overwrite: body.overwrite === true },
          paths().secretsDir,
        );
        if (!audit(reply, actor, created ? 'secret.create' : 'secret.overwrite', entry.name)) return;
        logger.info('Secret written from the settings page', { name: entry.name, created, actor });
        reply.send({ ok: true, created, secret: entry });
      } catch (error) {
        refuse(reply, 'writing a secret', error);
      }
    },
  );

  server.post<{ Params: { name: string }; Body: { userId?: unknown; allow?: unknown } }>(
    '/api/secrets/:name/grants',
    write,
    async (request, reply) => {
      const actor = namedAdmin(request, reply, true);
      if (!actor) return;
      const { name } = request.params;
      const { userId, allow } = request.body || {};
      if (!isSecretName(name)) {
        reply.status(400).send({ error: '비밀 이름이 올바르지 않습니다' });
        return;
      }
      if (typeof userId !== 'string' || typeof allow !== 'boolean') {
        reply.status(400).send({ error: 'userId와 allow가 필요합니다' });
        return;
      }
      try {
        if (allow && !knownUsers().some((u) => u.id === userId)) {
          reply.status(400).send({ error: '승인된 사용자가 아닙니다' });
          return;
        }
        if (allow) grantSecret(name, userId);
        else revokeSecret(name, userId);
        try {
          appendSecretAudit({ actor, action: allow ? 'grant.add' : 'grant.remove', name, userId }, paths().dataDir);
        } catch (error) {
          logger.error('Secret grant changed but the audit ledger could not be written', {
            name,
            code: (error as NodeJS.ErrnoException)?.code,
          });
        }
        logger.info('Secret grant changed from the settings page', { name, userId, allow, actor });
        const { configFile } = paths();
        const usages = secretUsages(loadServerToolsSection(configFile)).get(name) ?? [];
        reply.send({ ok: true, access: accessOf(name, usages, configFile) });
      } catch (error) {
        refuse(reply, 'changing a secret grant', error);
      }
    },
  );

  server.delete<{ Params: { name: string } }>('/api/secrets/:name', write, async (request, reply) => {
    const actor = namedAdmin(request, reply, true);
    if (!actor) return;
    try {
      deleteSecret(request.params.name, paths().secretsDir);
      if (!audit(reply, actor, 'secret.delete', request.params.name)) return;
      logger.info('Secret deleted from the settings page', { name: request.params.name, actor });
      reply.send({ ok: true });
    } catch (error) {
      refuse(reply, 'deleting a secret', error);
    }
  });
}
