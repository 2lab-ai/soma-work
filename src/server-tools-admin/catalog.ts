/**
 * The server-tools tools as the bot knows them (secret-access WU3, #1339, `.prd/33-secret-access-architecture.md`
 * §2.1) — one table read by the policy hook (which tools are an admin's), the secret-use gate (which tools use no
 * secret) and the dashboard's 서버 도구 tab (what each tool is). A contract test holds it to the names server-tools
 * registers (`packages/mcp-servers/server-tools/server-tools-mcp-server.ts` `defineTools`), so a tool added there
 * and not here fails CI instead of being shown nowhere.
 */

/** What a call does: only reads, writes, or either by its arguments (`gh_pr` view vs merge). */
export type ServerToolAccess = 'read' | 'write' | 'mixed';

/** The server section a tool needs (`config.json` `server-tools.<server>.<section>`). */
export type ServerToolSection = 'ssh' | 'databases' | 'github' | 'web' | 'cloudflare' | 'phone';

export interface ServerToolEntry {
  /** The tool's name as server-tools registers it (without `mcp__server-tools__`). */
  name: string;
  /** One line for the dashboard. */
  summary: string;
  access: ServerToolAccess;
  sections: readonly ServerToolSection[];
  /** Sections the tool reads when present (`cf_api` reads `github` for an account that deploys from a repository). */
  optionalSections?: readonly ServerToolSection[];
  /** Whether a call can read a `{"$secret"}` of its server (`src/secrets/secret-access.ts`). */
  usesSecrets: boolean;
  /**
   * The tool is an admin's whatever the server-tools grants say — or, on an environment's server, a user's that
   * environment's admin granted it (env-access WU2–WU6), or one whose secrets are all granted (secret-access WU2).
   * The text is what the model is told when it is denied.
   */
  adminOnly?: string;
}

export const SERVER_TOOLS_PREFIX = 'mcp__server-tools__';

export const SERVER_TOOLS_CATALOG: readonly ServerToolEntry[] = [
  {
    name: 'list',
    summary: '서버 목록 — 각 서버의 호스트 · DB · 계정 · 저장소 이름(비밀 없음)',
    access: 'read',
    sections: [],
    usesSecrets: false,
  },
  {
    name: 'list_service',
    summary: '호스트의 docker 서비스 목록',
    access: 'read',
    sections: ['ssh'],
    usesSecrets: false,
  },
  { name: 'list_stack', summary: '호스트의 docker stack 목록', access: 'read', sections: ['ssh'], usesSecrets: false },
  { name: 'logs', summary: '컨테이너 · 서비스 로그 읽기', access: 'read', sections: ['ssh'], usesSecrets: false },
  {
    name: 'ssh_exec',
    summary: '호스트에서 셸 명령 실행(봇의 키로, 모델은 키를 못 읽음)',
    access: 'write',
    sections: ['ssh'],
    usesSecrets: false,
    adminOnly: 'ssh_exec runs a command on a host and is for admins only.',
  },
  {
    name: 'db_query',
    summary: 'MySQL 읽기 전용 쿼리',
    access: 'read',
    sections: ['ssh', 'databases'],
    usesSecrets: true,
  },
  {
    name: 'redis_query',
    summary: 'Redis 읽기 전용 명령',
    access: 'read',
    sections: ['ssh', 'databases'],
    usesSecrets: true,
  },
  {
    name: 'mongodb_query',
    summary: 'MongoDB 읽기 전용 조회',
    access: 'read',
    sections: ['ssh', 'databases'],
    usesSecrets: true,
  },
  {
    name: 'clickhouse_query',
    summary: 'ClickHouse 읽기 전용 쿼리',
    access: 'read',
    sections: ['ssh', 'databases'],
    usesSecrets: true,
  },
  {
    name: 'gh_read',
    summary: '환경 저장소의 허용된 경로 GET(환경 토큰)',
    access: 'read',
    sections: ['github'],
    usesSecrets: true,
    adminOnly: "gh_read reads a repository with an environment's own token and is for admins only.",
  },
  {
    name: 'gh_pr',
    summary: 'PR 보기 · 승인 · 머지(조건표 · 감사 원장)',
    access: 'mixed',
    sections: ['github'],
    usesSecrets: true,
    adminOnly: "gh_pr acts on a PR with an environment's own token and is for admins only.",
  },
  {
    name: 'login',
    summary: '환경 웹 앱에 계정으로 로그인해 세션만 돌려줌',
    access: 'write',
    sections: ['web'],
    usesSecrets: true,
    adminOnly: "login signs in with an environment's own account and is for admins only.",
  },
  {
    name: 'cf_api',
    summary: 'Cloudflare API(쓰기는 계정이 write일 때만)',
    access: 'mixed',
    sections: ['cloudflare'],
    optionalSections: ['github'],
    usesSecrets: true,
    adminOnly: "cf_api calls Cloudflare with an environment's own token and is for admins only.",
  },
  {
    name: 'phone_call',
    summary: '환경 번호로 실제 전화 걸기',
    access: 'write',
    sections: ['phone'],
    usesSecrets: true,
    adminOnly: "phone_call dials a real number from an environment's own line and is for admins only.",
  },
  { name: 'phone_calls', summary: '통화 목록 · 기록 읽기', access: 'read', sections: ['phone'], usesSecrets: false },
];

/** Full tool name (`mcp__server-tools__ssh_exec`) → the message an admin-only tool's denial carries. */
export const ADMIN_ONLY_SERVER_TOOLS: ReadonlyMap<string, string> = new Map(
  SERVER_TOOLS_CATALOG.filter((t) => t.adminOnly).map((t) => [
    `${SERVER_TOOLS_PREFIX}${t.name}`,
    t.adminOnly as string,
  ]),
);

/** Short tool names whose calls never read a secret. */
export const NO_SECRET_SERVER_TOOLS: ReadonlySet<string> = new Set(
  SERVER_TOOLS_CATALOG.filter((t) => !t.usesSecrets).map((t) => t.name),
);

/** The level a new permission map gives a tool ("표 만들기"): reads need read, anything that writes needs write. */
export function defaultLevel(tool: ServerToolEntry): 'read' | 'write' {
  return tool.access === 'read' ? 'read' : 'write';
}
