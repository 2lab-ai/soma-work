/**
 * Skills over HTTP — the settings page "스킬" tab (#1079).
 *
 *   GET  /api/skills                       the three lists: 내 스킬 · 환경 스킬 · 시스템 스킬, and the user picker
 *   GET  /api/skills/mine/:name            one of my skills: SKILL.md and its hash
 *   PUT  /api/skills/mine/:name            { content, hash } — save SKILL.md verbatim (409 when it changed meanwhile)
 *   GET  /api/skills/env/:key              an environment skill's SKILL.md (admin, or a user granted it)
 *   GET  /api/skills/system/:source/:name  an installed skill's SKILL.md
 *   POST /api/skills/grants                { scope: 'mine'|'env', skill: name|null, userId, allow } — who may run
 *
 * Who sees and changes what, enforced here (the page only mirrors it):
 *   - 내 스킬 are the signed-in user's own (`authContext.userId`, never a body field). The owner reads and
 *     saves SKILL.md and says who else may run one skill or all of them — the same grant store the Slack
 *     permission flow writes (`user-skill-grants-store.ts`). A viewer-token session has no Slack user: no 내 스킬.
 *   - 환경 스킬 carry the host's environment values (test accounts, targets) — the sandbox hides their files
 *     from a non-admin's shell unless an admin granted all environment skills. Everyone signed in sees their
 *     names and their own access; the description and the content only an admin or a user granted that skill
 *     (who may run it, so the model reads it anyway); who has access only an admin. Changing access
 *     takes the dashboard's admin gate (admin mode, or the viewer token) and an identified caller: a
 *     dashboard without credentials reads them as a non-admin and cannot change them. The content is not
 *     editable — environment plugins are fetched again from their repo on restart, so an edit would vanish.
 *   - 시스템 스킬 are every installed skill but the environment plugins', read-only for everyone.
 *
 * A file is only ever read from an entry of a directory listing — never from a path built out of the URL.
 */

import * as fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type EnvSkillRegistry, envSkillExists, envSkillRegistry } from '../env-skill-registry';
import { Logger } from '../logger';
import { isSafePathSegment } from '../path-utils';
import { type InstalledSkill, listInstalledSkills } from '../skill-locator';
import { userSettingsStore } from '../user-settings-store';
import {
  ENV_SKILL_GRANT_OWNER,
  grantAllSkills,
  grantSkill,
  isEnvSkillUseAllowed,
  loadGrants,
  revokeAllSkills,
  revokeSkill,
} from '../user-skill-grants-store';
import {
  computeContentHash,
  getUserSkill,
  isSingleFileSkill,
  listUserSkills,
  MAX_SKILL_SIZE,
  updateUserSkill,
  userSkillExists,
} from '../user-skill-store';
import { shortDescription, skillDescriptionOf } from './composer-menus';

const logger = new Logger('SkillsRoutes');

type Middleware = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
/** Sends the 403 and returns false when the caller may not write. */
type AdminGate = (request: FastifyRequest, reply: FastifyReply) => boolean;

/** A user of the picker's source (the user settings store's rows). */
export interface SkillsUserRow {
  userId: string;
  slackName?: string;
  slackDisplayName?: string;
  accepted?: boolean;
}

let _envRegistry: (() => EnvSkillRegistry) | null = null;
let _users: (() => SkillsUserRow[]) | null = null;
let _localDirs: string[] | null = null;

/** The running plugin manager's registry (`src/index.ts`); unwired, `config.json`'s list. */
export function setSkillsEnvRegistrySource(fn: (() => EnvSkillRegistry) | null): void {
  _envRegistry = fn;
}

/** Tests: the users the picker offers. */
export function setSkillsUserSource(fn: (() => SkillsUserRow[]) | null): void {
  _users = fn;
}

/** Tests: the bundled `local` skill directories (default: the build's own). */
export function setSkillsLocalDirsForTests(dirs: string[] | null): void {
  _localDirs = dirs;
}

function envRegistry(): EnvSkillRegistry {
  return _envRegistry ? _envRegistry() : envSkillRegistry(undefined);
}

interface Viewer {
  userId?: string;
  /** An admin principal: an ADMIN_USERS member or the viewer token — never a dashboard without credentials. */
  isAdmin: boolean;
  anonymous: boolean;
  actor: string;
}

function viewerOf(request: FastifyRequest): Viewer {
  const auth = (request as { authContext?: { userId?: string; isAdmin?: boolean; mode?: string } }).authContext ?? {};
  const anonymous = auth.mode === 'none';
  const bearer = auth.mode === 'bearer_header' || auth.mode === 'bearer_cookie';
  return {
    userId: auth.userId,
    isAdmin: !!auth.isAdmin && !anonymous,
    anonymous,
    actor: auth.userId || (bearer ? 'viewer-token' : 'unknown'),
  };
}

/** The signed-in Slack user, or null after sending the refusal (a viewer token has no skills of its own). */
function selfUser(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = viewerOf(request).userId;
  if (!userId) {
    reply.status(400).send({ error: 'Slack 계정으로 로그인한 사용자만 내 스킬을 볼 수 있습니다' });
    return null;
  }
  return userId;
}

/** Accepted users, as the picker shows them. */
function knownUsers(): Array<{ id: string; name: string }> {
  const rows = _users ? _users() : userSettingsStore.getAllUsers();
  return rows
    .filter((u) => u.accepted === true && !!u.userId)
    .map((u) => ({ id: u.userId, name: u.slackDisplayName || u.slackName || u.userId }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function readDescription(file: string): string {
  try {
    return shortDescription(skillDescriptionOf(fs.readFileSync(file, 'utf-8')));
  } catch {
    return '';
  }
}

function envSkills(registry: EnvSkillRegistry): InstalledSkill[] {
  return listInstalledSkills({ localDirs: [], pluginsDir: registry.pluginsDir }).filter((s) =>
    registry.pluginNames.has(s.source),
  );
}

function systemSkills(registry: EnvSkillRegistry): InstalledSkill[] {
  return listInstalledSkills({
    excludePlugins: registry.pluginNames,
    pluginsDir: registry.pluginsDir,
    ...(_localDirs ? { localDirs: _localDirs } : {}),
  });
}

const idsOf = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);

function mineView(userId: string) {
  const grants = loadGrants(userId);
  return {
    allowAll: idsOf(grants.allowAll),
    skills: listUserSkills(userId).map((s) => ({
      name: s.name,
      description: s.description,
      isSingleFile: s.isSingleFile,
      allowed: idsOf(grants.perSkill[s.name]),
    })),
  };
}

type EnvAccess = 'admin' | 'granted' | 'none';

function envAccess(key: string, viewer: Viewer): EnvAccess {
  if (viewer.isAdmin) return 'admin';
  // No thread scope: a thread grant ("1회") opens one Slack thread, not this page.
  return viewer.userId && isEnvSkillUseAllowed(key, viewer.userId) ? 'granted' : 'none';
}

function envView(registry: EnvSkillRegistry, viewer: Viewer) {
  const grants = viewer.isAdmin ? loadGrants(ENV_SKILL_GRANT_OWNER) : null;
  const skills = envSkills(registry).map((s) => {
    const key = `${s.source}:${s.name}`;
    const access = envAccess(key, viewer);
    const row: Record<string, unknown> = { key, plugin: s.source, name: s.name, access };
    if (access !== 'none') row.description = readDescription(s.file);
    if (grants) row.allowed = idsOf(grants.perSkill[key]);
    return row;
  });
  return grants ? { allowAll: idsOf(grants.allowAll), skills } : { skills };
}

function mineDetail(userId: string, name: string) {
  const skill = getUserSkill(userId, name);
  if (!skill) return null;
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    isSingleFile: isSingleFileSkill(userId, name),
    hash: computeContentHash(skill.content),
  };
}

function applyGrant(ownerId: string, skill: string | null, requesterId: string, allow: boolean): void {
  if (skill === null) {
    if (allow) grantAllSkills(ownerId, requesterId);
    else revokeAllSkills(ownerId, requesterId);
  } else if (allow) grantSkill(ownerId, skill, requesterId);
  else revokeSkill(ownerId, skill, requesterId);
}

function failed(reply: FastifyReply, what: string, error: unknown): void {
  logger.error(`Error ${what}`, error);
  reply.status(500).send({ error: 'Internal Server Error' });
}

export function registerSkillsRoutes(
  server: FastifyInstance,
  authMiddleware: Middleware,
  csrfMiddleware: Middleware | undefined,
  requireAdminWrite: AdminGate,
): void {
  const read = { preHandler: [authMiddleware] };
  const write = { preHandler: [authMiddleware, ...(csrfMiddleware ? [csrfMiddleware] : [])] };

  server.get('/api/skills', read, async (request, reply) => {
    try {
      const viewer = viewerOf(request);
      const registry = envRegistry();
      reply.header('Cache-Control', 'no-store').send({
        me: viewer.userId ?? null,
        isAdmin: viewer.isAdmin,
        users: knownUsers(),
        mine: viewer.userId ? mineView(viewer.userId) : null,
        env: envView(registry, viewer),
        system: systemSkills(registry).map((s) => ({
          source: s.source,
          name: s.name,
          description: readDescription(s.file),
        })),
      });
    } catch (error) {
      failed(reply, 'listing skills', error);
    }
  });

  server.get<{ Params: { name: string } }>('/api/skills/mine/:name', read, async (request, reply) => {
    const userId = selfUser(request, reply);
    if (!userId) return;
    try {
      const detail = mineDetail(userId, request.params.name);
      if (!detail) {
        reply.status(404).send({ error: '그런 스킬이 없습니다' });
        return;
      }
      reply.header('Cache-Control', 'no-store').send(detail);
    } catch (error) {
      failed(reply, 'reading a skill', error);
    }
  });

  server.put<{ Params: { name: string }; Body: { content?: unknown; hash?: unknown } }>(
    '/api/skills/mine/:name',
    write,
    async (request, reply) => {
      const userId = selfUser(request, reply);
      if (!userId) return;
      const { content, hash } = request.body || {};
      if (typeof content !== 'string' || typeof hash !== 'string') {
        reply.status(400).send({ error: 'content and hash are required' });
        return;
      }
      try {
        const name = request.params.name;
        const current = getUserSkill(userId, name);
        if (!current) {
          reply.status(404).send({ error: '그런 스킬이 없습니다' });
          return;
        }
        // Slack, or a session's MANAGE_SKILL, may have changed it since the page read it: never overwrite that blind.
        if (computeContentHash(current.content) !== hash) {
          reply.status(409).send({ error: '그사이 다른 곳에서 이 스킬이 바뀌어 저장하지 않았습니다' });
          return;
        }
        if (!content.trim()) {
          reply.status(400).send({ error: '스킬 내용이 비어 있습니다' });
          return;
        }
        if (Buffer.byteLength(content.trim(), 'utf-8') > MAX_SKILL_SIZE) {
          reply.status(400).send({ error: `스킬이 최대 크기(${MAX_SKILL_SIZE / 1024}KB)를 넘습니다` });
          return;
        }
        const result = updateUserSkill(userId, name, content);
        if (!result.ok) {
          reply.status(400).send({ error: result.message });
          return;
        }
        reply.send({ ok: true, skill: mineDetail(userId, name) });
      } catch (error) {
        failed(reply, 'saving a skill', error);
      }
    },
  );

  server.get<{ Params: { key: string } }>('/api/skills/env/:key', read, async (request, reply) => {
    try {
      const viewer = viewerOf(request);
      const key = request.params.key;
      const skill = envSkills(envRegistry()).find((s) => `${s.source}:${s.name}` === key);
      if (!skill) {
        reply.status(404).send({ error: '그런 환경 스킬이 없습니다' });
        return;
      }
      if (envAccess(key, viewer) === 'none') {
        reply.status(403).send({ error: '이 환경 스킬을 볼 권한이 없습니다' });
        return;
      }
      reply.header('Cache-Control', 'no-store').send({
        key,
        plugin: skill.source,
        name: skill.name,
        description: readDescription(skill.file),
        content: fs.readFileSync(skill.file, 'utf-8'),
      });
    } catch (error) {
      failed(reply, 'reading an environment skill', error);
    }
  });

  server.get<{ Params: { source: string; name: string } }>(
    '/api/skills/system/:source/:name',
    read,
    async (request, reply) => {
      const { source, name } = request.params;
      try {
        const skill =
          isSafePathSegment(source) && isSafePathSegment(name)
            ? systemSkills(envRegistry()).find((s) => s.source === source && s.name === name)
            : undefined;
        if (!skill) {
          reply.status(404).send({ error: '그런 스킬이 없습니다' });
          return;
        }
        reply.send({
          source,
          name,
          description: readDescription(skill.file),
          content: fs.readFileSync(skill.file, 'utf-8'),
        });
      } catch (error) {
        failed(reply, 'reading a system skill', error);
      }
    },
  );

  server.post<{ Body: { scope?: unknown; skill?: unknown; userId?: unknown; allow?: unknown } }>(
    '/api/skills/grants',
    write,
    async (request, reply) => {
      const body = request.body || {};
      const scope = body.scope;
      if (scope !== 'mine' && scope !== 'env') {
        reply.status(400).send({ error: 'scope must be mine or env' });
        return;
      }
      const viewer = viewerOf(request);
      // Who may change these grants comes first: the owner for 내 스킬, an identified admin for 환경 스킬.
      let owner: string;
      if (scope === 'mine') {
        const self = selfUser(request, reply);
        if (!self) return;
        owner = self;
      } else {
        if (viewer.anonymous) {
          reply.status(403).send({
            error: '환경 스킬 권한은 로그인한 관리자만 바꿉니다 — 이 대시보드는 인증이 설정되지 않았습니다',
          });
          return;
        }
        if (!requireAdminWrite(request, reply)) return;
        owner = ENV_SKILL_GRANT_OWNER;
      }
      const { skill, userId: target, allow } = body;
      if (skill !== null && typeof skill !== 'string') {
        reply.status(400).send({ error: 'skill must be a skill name, or null for all skills' });
        return;
      }
      if (typeof target !== 'string' || typeof allow !== 'boolean') {
        reply.status(400).send({ error: 'userId and allow are required' });
        return;
      }
      try {
        if (!knownUsers().some((u) => u.id === target)) {
          reply.status(400).send({ error: '승인된 사용자가 아닙니다' });
          return;
        }
        const apply = () => {
          applyGrant(owner, skill, target, allow);
          logger.info('Skill grant changed from the settings page', {
            scope,
            owner,
            skill: skill ?? '(all)',
            userId: target,
            allow,
            actor: viewer.actor,
          });
        };
        if (scope === 'mine') {
          if (target === owner) {
            reply.status(400).send({ error: '내 스킬은 나는 언제나 실행할 수 있습니다 — 다른 사람을 고르세요' });
            return;
          }
          if (skill !== null && !userSkillExists(owner, skill)) {
            reply.status(404).send({ error: '그런 스킬이 없습니다' });
            return;
          }
          apply();
          reply.send({ ok: true, mine: mineView(owner) });
          return;
        }
        const registry = envRegistry();
        if (skill !== null && !envSkillExists(skill, registry)) {
          reply.status(404).send({ error: '그런 환경 스킬이 없습니다' });
          return;
        }
        apply();
        reply.send({ ok: true, env: envView(registry, viewer) });
      } catch (error) {
        failed(reply, 'changing a skill grant', error);
      }
    },
  );
}
