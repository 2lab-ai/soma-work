/**
 * The settings page 비밀 tab's HTTP surface (secret-access WU1, #1337, `.prd/33-secret-access-architecture.md` §5).
 *
 *   GET    /api/secrets          names · last change · who changed it · where configuration uses it — no values
 *   PUT    /api/secrets/:name    { value, overwrite? } — add, or replace with overwrite
 *   DELETE /api/secrets/:name
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
import { isEnvironmentId } from '../env-users';
import { Logger } from '../logger';
import { deleteSecret, listSecrets, SecretAdminError, writeSecret } from '../secrets/secret-admin-store';
import { appendSecretAudit, lastSecretChanges, type SecretAuditAction } from '../secrets/secret-audit';
import { loadServerToolsSection, secretUsages } from '../secrets/secret-usage';
import { userSettingsStore } from '../user-settings-store';

const logger = new Logger('SecretsRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface Paths {
  secretsDir: string;
  dataDir: string;
  configFile: string;
}

let _paths: Paths | null = null;

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
export function namedAdmin(request: FastifyRequest, reply: FastifyReply, change: boolean): string | null {
  const auth = (request as { authContext?: { mode?: string; userId?: string } }).authContext;
  const userId = auth?.mode === 'oauth_jwt' ? auth.userId : undefined;
  if (!userId || isEnvironmentId(userId) || !isAdminUser(userId)) {
    reply.status(403).send({ error: '비밀은 Slack 계정으로 로그인한 관리자만 보고 바꿉니다' });
    return null;
  }
  if (change && request.headers['x-admin-mode'] !== 'on') {
    reply.status(403).send({ error: '관리자 모드를 켜야 비밀을 바꿀 수 있습니다' });
    return null;
  }
  return userId;
}

/** The name the dashboard shows for a Slack id (the id itself when the store has none). */
function displayName(userId: string): string {
  try {
    const row = userSettingsStore.getUserSettings(userId) as { slackDisplayName?: string; slackName?: string } | undefined;
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
          };
        }),
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
