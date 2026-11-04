/**
 * The dashboard composers' trigger menus (2026-11-04): `/` lists the commands a person can type, `$` the skills
 * this user can invoke. Both feed `data.triggers` of @2lab.ai/ui <ui-composer> (0.27.0) — the new-task composer
 * and the open session's composer (inside <ui-agent-steering>).
 *
 * What the menu inserts is the same text a Slack thread takes: the dashboard posts it to the same router
 * (`POST /api/dashboard/session/:key/command` → `injectDashboardMessage` → `slackHandler.handleMessage`, and the
 * new task's first message through `launchNewTask` → `handleMessage`). So every command example below must be
 * claimed by a real handler — `composer-menus.test.ts` routes each one through the production `CommandRouter`.
 *
 * Words are Korean source strings; English comes from the text catalog (`t`, en-text.json) in the request's
 * display language.
 */

import * as fs from 'node:fs';
import { t } from '@soma/common/i18n';
import { CONFIG_FILE } from '../env-paths';
import { envPluginNamesFromConfig } from '../env-skill-registry';
import { Logger } from '../logger';
import { type AvailableSkill, listAvailableSkills, skillMdFile } from '../skill-locator';
import { isEnvSkillUseAllowed } from '../user-skill-grants-store';
import { listUserSkills } from '../user-skill-store';

const logger = new Logger('ComposerMenus');

/** Which composer the menu is for: the new task's (a fresh thread, no session yet) or an open session's. */
export type ComposerMenuWhere = 'new-task' | 'session';

/** One command row (the <ui-composer> suggestion shape, plus who and where it is offered). */
export interface ComposerCommand {
  /** What the menu inserts (`/model`). */
  value: string;
  /** One line on what it does (Korean source string). */
  description: string;
  /** A typical use, drawn in grey. Claimed by a real command handler (composer-menus.test.ts). */
  example: string;
  /** Section (Korean source string). Rows of one group are adjacent. */
  group: string;
  /** Needs the thread's session: not offered in the new-task composer. */
  session?: true;
  /**
   * Its example starts (or stops) a turn — the work shows on the board. Without it the command only answers, and
   * the answer is posted in the Slack thread (the router's `control` kind; composer-menus.test.ts holds the two
   * equal). A new task whose first message only answers is launched answer-only (its answer in the new thread).
   */
  turn?: true;
  /** Admins only. */
  admin?: true;
}

/** The <ui-composer> suggestion row as sent to the page. */
export interface ComposerSuggestionRow {
  value: string;
  label?: string;
  description?: string;
  example?: string;
  group?: string;
}

/** The <ui-composer> trigger as sent to the page. */
export interface ComposerTriggerRow {
  char: string;
  at?: 'start' | 'word';
  label?: string;
  items: ComposerSuggestionRow[];
}

const SESSION = '세션';
const SETTINGS = '설정';
const TOOLS = '도구';
const ADMIN = '관리자';

/**
 * Every command a person can type in a composer, grouped. Kept in step with the router
 * (`src/slack/commands/command-router.ts`) and `CommandParser.getHelpMessage()`.
 */
export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  // ── 세션 — this thread's session ──
  {
    value: '/new',
    description: '이 스레드의 세션을 비우고 새로 시작 (뒤에 지시를 붙이면 바로 실행)',
    example: '/new 로그인 버그부터 고쳐줘',
    group: SESSION,
    session: true,
    turn: true,
  },
  {
    value: '/goal',
    description: '세션 목표를 정하거나 보기 — 목표를 이룰 때까지 이어서 작업',
    example: '/goal 대시보드 E2E 테스트 전부 통과',
    group: SESSION,
    turn: true,
  },
  {
    value: '!',
    description: '실행 중인 작업 중지 (뒤에 지시를 붙이면 중지하고 그 지시를 실행)',
    example: '! 이거 말고 테스트부터 고쳐줘',
    group: SESSION,
    session: true,
    turn: true,
  },
  {
    value: '%model',
    description: '이 세션에서만 모델 바꾸기 (뒤에 지시를 붙이면 바꾼 뒤 실행)',
    example: '%model opus 이 PR 리뷰해줘',
    group: SESSION,
    turn: true,
  },
  {
    value: '%nogoal',
    description: '자동 목표 없이 이 지시만 실행',
    example: '%nogoal 이 함수 이름만 바꿔줘',
    group: SESSION,
    turn: true,
  },
  {
    value: '%effort',
    description: '이 세션에서만 effort 바꾸기',
    example: '%effort high',
    group: SESSION,
    session: true,
  },
  {
    value: '%verbosity',
    description: '이 세션에서만 출력 상세도 바꾸기',
    example: '%verbosity detail',
    group: SESSION,
    session: true,
  },
  {
    value: '%thinking',
    description: '이 세션의 확장 사고 켜기·끄기',
    example: '%thinking off',
    group: SESSION,
    session: true,
  },
  {
    value: '%thinking_summary',
    description: '이 세션의 사고 요약 표시 켜기·끄기',
    example: '%thinking_summary on',
    group: SESSION,
    session: true,
  },
  {
    value: '%',
    description: '이 세션의 설정 보기 (모델 · effort · 상세도 · 컨텍스트)',
    example: '%',
    group: SESSION,
    session: true,
  },
  {
    value: '/compact --yes',
    description: '대화를 요약해 컨텍스트 비우기 (확인 없이 바로)',
    example: '/compact --yes',
    group: SESSION,
    session: true,
    turn: true,
  },
  {
    value: '/context',
    description: '이 세션의 토큰 사용량과 비용',
    example: '/context',
    group: SESSION,
    session: true,
  },
  {
    value: '/renew',
    description: '컨텍스트를 저장하고 세션을 새로 불러오기 (긴 세션용)',
    example: '/renew',
    group: SESSION,
    session: true,
    turn: true,
  },
  {
    value: '/rollback',
    description: '모델의 컨텍스트를 몇 입력 전으로 되돌리기',
    example: '/rollback 2',
    group: SESSION,
    session: true,
  },
  {
    value: '/autocompact',
    description: '자동 압축 기준 토큰 보기·설정',
    example: '/autocompact 800k',
    group: SESSION,
    session: true,
  },
  {
    value: '/link',
    description: '이 세션에 이슈 · PR · 문서 링크 붙이기',
    example: '/link pr https://github.com/2lab-ai/soma-work/pull/1',
    group: SESSION,
    session: true,
  },
  {
    value: '/queue',
    description: '대기 중인 후속 지시 보기',
    example: '/queue',
    group: SESSION,
    session: true,
  },
  {
    value: '/close',
    description: '이 스레드의 세션 끝내기',
    example: '/close',
    group: SESSION,
    session: true,
  },
  {
    value: '/sessions',
    description: '내 활성 세션 목록',
    example: '/sessions',
    group: SESSION,
  },
  {
    value: '/onboarding',
    description: '온보딩 워크플로 실행',
    example: '/onboarding',
    group: SESSION,
    turn: true,
  },
  // ── 설정 — yours, for every session ──
  {
    value: '/model',
    description: '기본 모델 보기·바꾸기 (다음 세션부터)',
    example: '/model opus',
    group: SETTINGS,
  },
  {
    value: '/effort',
    description: '기본 effort 보기·바꾸기',
    example: '/effort high',
    group: SETTINGS,
  },
  {
    value: '/verbosity',
    description: '기본 출력 상세도 (minimal · compact · detail · verbose)',
    example: '/verbosity compact',
    group: SETTINGS,
  },
  {
    value: '/persona',
    description: '페르소나 보기·바꾸기',
    example: '/persona list',
    group: SETTINGS,
  },
  {
    value: '/lang',
    description: '표시 언어 (대시보드 · 스레드 · 답변)',
    example: '/lang en',
    group: SETTINGS,
  },
  {
    value: '/set email',
    description: '커밋의 Co-Authored-By에 쓸 이메일 설정',
    example: '/set email me@example.com',
    group: SETTINGS,
  },
  {
    value: '/show email',
    description: '설정한 이메일 보기',
    example: '/show email',
    group: SETTINGS,
  },
  {
    value: '/autoskill',
    description: '매 턴 자동으로 붙는 스킬 보기 (clear로 비우기)',
    example: '/autoskill',
    group: SETTINGS,
  },
  {
    value: '/set autoskill',
    description: '매 턴 자동으로 붙일 스킬 정하기',
    example: '/set autoskill autoz, zcheck',
    group: SETTINGS,
  },
  {
    value: '/bypass',
    description: '권한 확인 생략 켜기·끄기',
    example: '/bypass on',
    group: SETTINGS,
  },
  {
    value: '/sandbox',
    description: '샌드박스 상태 (켜고 끄기는 관리자)',
    example: '/sandbox network',
    group: SETTINGS,
  },
  {
    value: '/notify',
    description: '작업 알림 켜기·끄기, 텔레그램 연결',
    example: '/notify on',
    group: SETTINGS,
  },
  {
    value: '/webhook',
    description: '웹훅 등록 · 삭제 · 테스트',
    example: '/webhook register https://example.com/hook',
    group: SETTINGS,
  },
  {
    value: '/epictasks',
    description: '대시보드에서 에픽 작업 만들기 허용',
    example: '/epictasks on',
    group: SETTINGS,
  },
  {
    value: '/memory',
    description: '내 메모리 보기 · 검색 · 관리',
    example: '/memory search 배포',
    group: SETTINGS,
  },
  {
    value: '/rate',
    description: '모델 평가 보기 · 올리기 · 내리기',
    example: '/rate +',
    group: SETTINGS,
  },
  {
    value: '/cwd',
    description: '작업 폴더 보기',
    example: '/cwd',
    group: SETTINGS,
  },
  // ── 도구 ──
  {
    value: '/cron',
    description: '크론 작업 목록과 관리 (모델 · 결과 위치 · 삭제)',
    example: '/cron model daily-report fast',
    group: TOOLS,
  },
  {
    value: '/skills list',
    description: '내 스킬 목록',
    example: '/skills list',
    group: TOOLS,
  },
  {
    value: '/mcp',
    description: 'MCP 서버 상태 (reload로 다시 읽기)',
    example: '/mcp reload',
    group: TOOLS,
  },
  {
    value: '/plugins',
    description: '설치된 플러그인 보기 · 추가 · 삭제',
    example: '/plugins add my-plugin@my-marketplace',
    group: TOOLS,
  },
  {
    value: '/marketplace',
    description: '플러그인 마켓플레이스 보기 · 추가 · 삭제',
    example: '/marketplace add owner/repo',
    group: TOOLS,
  },
  {
    value: '/auth',
    description: '인증 백엔드와 llmux 사용량',
    example: '/auth',
    group: TOOLS,
  },
  {
    value: '/usage',
    description: '토큰 사용량과 순위 (today · week · month)',
    example: '/usage week',
    group: TOOLS,
  },
  {
    value: '/report',
    description: '사용 리포트 (today · daily · weekly)',
    example: '/report weekly',
    group: TOOLS,
  },
  {
    value: '/dashboard',
    description: '대시보드 링크',
    example: '/dashboard',
    group: TOOLS,
  },
  {
    value: '/z',
    description: '설정 카드 메뉴 (주제를 붙이면 그 카드)',
    example: '/z model',
    group: TOOLS,
  },
  {
    value: '/help',
    description: '모든 명령어와 설명',
    example: '/help',
    group: TOOLS,
  },
  // ── 관리자 ──
  {
    value: '/admin',
    description: '관리자 명령 전체',
    example: '/admin users',
    group: ADMIN,
    admin: true,
  },
  {
    value: '/cct',
    description: 'OAuth 토큰 풀 상태 · 전환',
    example: '/cct usage',
    group: ADMIN,
    admin: true,
  },
  {
    value: '/all_sessions',
    description: '모든 사용자의 활성 세션',
    example: '/all_sessions',
    group: ADMIN,
    admin: true,
  },
  {
    value: '/terminate',
    description: '세션 하나 끝내기 (세션 키)',
    example: '/terminate C0123456789:1700000000.000100',
    group: ADMIN,
    admin: true,
  },
  {
    value: '/show prompt',
    description: '이 세션의 시스템 프롬프트 보기',
    example: '/show prompt',
    group: ADMIN,
    admin: true,
    session: true,
  },
  {
    value: '/show instructions',
    description: '이 세션에 저장된 사용자 지시 보기',
    example: '/show instructions',
    group: ADMIN,
    admin: true,
    session: true,
  },
  {
    value: '/restore',
    description: 'Claude 자격 증명을 백업에서 되살리기',
    example: '/restore status',
    group: ADMIN,
    admin: true,
  },
  {
    value: '/ui-test',
    description: 'Slack UI 렌더링 시험',
    example: '/ui-test plan',
    group: ADMIN,
    admin: true,
  },
];

/**
 * The commands offered in one composer, in the viewer's language: an open session every command, a new task every
 * command that works without the thread's session. One that only answers says its answer is in the Slack thread.
 */
export function composerCommandItems(opts: { where: ComposerMenuWhere; admin: boolean }): ComposerSuggestionRow[] {
  const inThread = t('답은 Slack 스레드에');
  return COMPOSER_COMMANDS.filter((c) => (opts.admin || !c.admin) && (opts.where === 'session' || !c.session)).map(
    (c) => ({
      value: c.value,
      description: c.turn ? t(c.description) : `${t(c.description)} · ${inThread}`,
      example: c.example,
      group: t(c.group),
    }),
  );
}

// ── Skills ──

/** The description line of a SKILL.md's frontmatter (`description: …`, quoted or plain; `|` / `>` blocks), or ''. */
export function skillDescriptionOf(content: string): string {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return '';
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^description\s*:/.test(l));
  if (at < 0) return '';
  let value = lines[at].replace(/^description\s*:\s*/, '').trim();
  if (/^[|>][-+]?$/.test(value)) {
    const block: string[] = [];
    for (let i = at + 1; i < lines.length && (/^\s+\S/.test(lines[i]) || lines[i].trim() === ''); i++)
      block.push(lines[i].trim());
    value = block.filter(Boolean).join(' ');
  } else if (/^["']/.test(value)) {
    const q = value[0];
    const end = value.lastIndexOf(q);
    value = end > 0 ? value.slice(1, end) : value.slice(1);
    if (q === '"') value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    else value = value.replace(/''/g, "'");
  }
  return value.replace(/\s+/g, ' ').trim();
}

/** A one-line description, cut at a word near `max` characters. */
export function shortDescription(text: string, max = 140): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The token that invokes a skill with no ambiguity: `$user:x`, `$local:x`, `$<plugin>:x`. */
export function skillToken(skill: AvailableSkill): string {
  return `$${skill.source}:${skill.name}`;
}

/** Section of a skill row (Korean source string, or the plugin's own name). */
function skillGroup(source: string): string {
  if (source === 'user') return '내 스킬';
  if (source === 'local') return '기본 스킬';
  return source;
}

const SKILL_TTL_MS = 60_000;
const skillCache = new Map<string, { at: number; rows: Array<ComposerSuggestionRow & { needsApproval?: true }> }>();
/** Shared SKILL.md description lines (plugin files are the same for everyone), read again after SKILL_TTL_MS. */
const descriptionCache = new Map<string, { at: number; text: string }>();

function readDescription(file: string | null, reader: SkillFs, now: number): string {
  if (!file) return '';
  const hit = descriptionCache.get(file);
  if (hit && now - hit.at < SKILL_TTL_MS) return hit.text;
  let text = '';
  try {
    text = shortDescription(skillDescriptionOf(reader.readFileSync(file, 'utf-8')));
  } catch (err) {
    logger.debug('skill description unreadable', { file, error: (err as Error).message });
  }
  descriptionCache.set(file, { at: now, text });
  return text;
}

/** What the skill listing reads (tests swap it). */
export interface SkillFs {
  readFileSync(file: string, enc: 'utf-8'): string;
}

export interface ComposerSkillDeps {
  listSkills(userId?: string): AvailableSkill[];
  /** The user's own skills with their descriptions (the user-skill store's reader). */
  listOwnSkills(userId: string): Array<{ name: string; description: string }>;
  skillFile(skill: AvailableSkill, userId?: string): string | null;
  envPluginNames(): ReadonlySet<string>;
  envSkillAllowed(key: string, userId: string): boolean;
  fs: SkillFs;
  now(): number;
}

const defaultDeps: ComposerSkillDeps = {
  listSkills: listAvailableSkills,
  listOwnSkills: (userId) => listUserSkills(userId),
  skillFile: (skill, userId) => skillMdFile(skill, userId),
  envPluginNames: () => envPluginNamesFromConfig(CONFIG_FILE ?? ''),
  envSkillAllowed: (key, userId) => isEnvSkillUseAllowed(key, userId),
  fs,
  now: () => Date.now(),
};

/**
 * Every skill `userId` can invoke (theirs, the built-in `local` ones, the plugins'), one row each, sorted by name,
 * with the token that names it unambiguously. An environment plugin's skill this user holds no grant for stays in
 * the list — invoking it asks an admin — and says so instead of its description. No user (a viewer-token session):
 * no personal skills, and no environment skill's description.
 */
export function composerSkillItems(
  opts: { userId?: string; admin: boolean },
  deps: ComposerSkillDeps = defaultDeps,
): ComposerSuggestionRow[] {
  const key = `${opts.userId ?? ''}|${opts.admin ? 1 : 0}`;
  const cached = skillCache.get(key);
  let rows = cached && deps.now() - cached.at < SKILL_TTL_MS ? cached.rows : null;
  if (!rows) {
    const own = new Map<string, string>();
    if (opts.userId) for (const s of deps.listOwnSkills(opts.userId)) own.set(s.name, s.description);
    const env = deps.envPluginNames();
    rows = deps.listSkills(opts.userId).map((skill) => {
      const description =
        skill.source === 'user'
          ? shortDescription(own.get(skill.name) ?? '')
          : readDescription(deps.skillFile(skill, opts.userId), deps.fs, deps.now());
      const row: ComposerSuggestionRow & { needsApproval?: true } = {
        value: skillToken(skill),
        group: skillGroup(skill.source),
      };
      if (description) row.description = description;
      const envKey = `${skill.source}:${skill.name}`;
      if (env.has(skill.source) && !opts.admin && !(opts.userId && deps.envSkillAllowed(envKey, opts.userId)))
        row.needsApproval = true;
      return row;
    });
    // Own skills first, then the built-in ones, then each plugin — a group's rows together, by name inside.
    const rank = (r: ComposerSuggestionRow) => (r.group === '내 스킬' ? 0 : r.group === '기본 스킬' ? 1 : 2);
    rows.sort(
      (a, b) => rank(a) - rank(b) || (a.group ?? '').localeCompare(b.group ?? '') || a.value.localeCompare(b.value),
    );
    skillCache.set(key, { at: deps.now(), rows });
  }
  const approval = t('관리자 승인 필요');
  return rows.map(({ needsApproval, ...r }) => {
    const out: ComposerSuggestionRow = { ...r, group: r.group ? t(r.group) : r.group };
    // Not granted yet: the name stays (invoking it asks an admin), the SKILL.md words are not shown.
    if (needsApproval) out.description = approval;
    return out;
  });
}

/** @internal tests — forget the cached lists. */
export function resetComposerMenuCache(): void {
  skillCache.clear();
  descriptionCache.clear();
}

/**
 * The triggers for one composer: `/` every command (the `%` session settings and `!` stop among them), `%` the
 * session settings alone, `$` the skills — `$user` (your skills, as a card) leads that menu.
 */
export function composerTriggers(
  opts: { where: ComposerMenuWhere; userId?: string; admin: boolean },
  deps?: ComposerSkillDeps,
): ComposerTriggerRow[] {
  // `$user` alone answers with the skills card (in the thread; a new task's is launched answer-only).
  const skills: ComposerSuggestionRow[] = [
    { value: '$user', description: t('내 스킬 목록 카드 (보기 · 편집 · 공유)'), group: t('내 스킬') },
    ...composerSkillItems({ userId: opts.userId, admin: opts.admin }, deps),
  ];
  return [
    { char: '/', at: 'start', label: t('명령어'), items: composerCommandItems(opts) },
    {
      char: '%',
      at: 'start',
      label: t('세션 설정'),
      items: composerCommandItems(opts).filter((c) => c.value.startsWith('%')),
    },
    { char: '$', at: 'word', label: t('스킬'), items: skills },
  ].filter((tr) => tr.items.length > 0) as ComposerTriggerRow[];
}
