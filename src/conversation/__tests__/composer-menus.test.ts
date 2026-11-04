/**
 * The dashboard composers' `/` and `$` menus (2026-11-04).
 *
 * The question under test is not "is the list pretty" but "does what the menu inserts do what its row says":
 * every command row's example is routed through the PRODUCTION handler chain (`CommandRouter`'s handlers,
 * the `/z` rewrite, the inline `%` directives, the `!` stop marker) and must be claimed by a real command —
 * a row that would fall through to the model as plain chat is a lie in the menu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripZPrefix } from '@soma/slack/z/normalize';
import { translateToLegacy } from '@soma/slack/z/router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({ userSettingsStore: {} }));
vi.mock('../../metrics', () => ({
  getReportDeps: () => ({
    claudeMetricsStore: { getUserStats: vi.fn(), getDailyStats: vi.fn(), getMonthlyStats: vi.fn() },
    userSettingsStore: { getUserModel: vi.fn() },
    tokenFormatter: { format: (n: number) => String(n) },
  }),
}));

import { CommandParser } from '../../slack/command-parser';
import { CommandRouter } from '../../slack/commands/command-router';
import { WorkingDirectoryManager } from '../../working-directory-manager';
import {
  COMPOSER_COMMANDS,
  type ComposerSkillDeps,
  composerCommandItems,
  composerSkillItems,
  composerTriggers,
  resetComposerMenuCache,
  shortDescription,
  skillDescriptionOf,
  skillToken,
} from '../composer-menus';

type Claimer = { canHandle(text: string, user?: string): boolean };

function productionRouter(): CommandRouter {
  return new CommandRouter({
    workingDirManager: {
      parseSetCommand: WorkingDirectoryManager.prototype.parseSetCommand,
      isGetCommand: WorkingDirectoryManager.prototype.isGetCommand,
    },
    mcpManager: { getPluginManager: () => undefined },
    claudeHandler: { getSession: () => null },
    slackApi: {},
  } as never);
}
function productionHandlers(router = productionRouter()): Claimer[] {
  return (router as unknown as { handlers: Claimer[] }).handlers;
}

/** Would the host treat `text` as this command (not as chat for the model)? */
function claimedByACommand(handlers: Claimer[], text: string): boolean {
  // `!` / `!<prompt>` is the stop marker slack-handler reads before any routing.
  if (text.startsWith('!')) return true;
  // `%model <v> <instruction>` / `%nogoal <instruction>` — inline directives, parsed before routing.
  if (CommandParser.parseInlineSessionDirectives(text)) return true;
  const z = stripZPrefix(text);
  if (z !== null && !z) return true; // bare `/z` → the help card
  const routed = z !== null ? translateToLegacy(z) : text;
  return handlers.some((h) => h.canHandle(routed, 'U_ADMIN'));
}

describe('command rows — what the menu inserts is a real command', () => {
  const handlers = productionHandlers();

  it.each(COMPOSER_COMMANDS.map((c) => [c.value, c.example]))('%s — its example “%s” is claimed', (_value, example) => {
    expect(claimedByACommand(handlers, example)).toBe(true);
  });

  it('every row starts with what the menu inserts', () => {
    for (const c of COMPOSER_COMMANDS) expect(c.example.startsWith(c.value)).toBe(true);
  });

  it('report, skills list and ui-test take the leading / like every other command', () => {
    expect(claimedByACommand(handlers, '/report')).toBe(true);
    expect(claimedByACommand(handlers, '/skills list')).toBe(true);
    expect(claimedByACommand(handlers, '/ui-test')).toBe(true);
  });

  it('plain chat is not claimed (the check can fail)', () => {
    expect(claimedByACommand(handlers, '로그인 버그 좀 고쳐줘')).toBe(false);
    expect(claimedByACommand(handlers, '/modelzzz opus')).toBe(false);
  });

  it('values are unique and every group is contiguous', () => {
    const values = COMPOSER_COMMANDS.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
    const seen: string[] = [];
    for (const c of COMPOSER_COMMANDS) {
      if (seen[seen.length - 1] !== c.group) {
        expect(seen).not.toContain(c.group);
        seen.push(c.group);
      }
    }
  });
});

describe('composerCommandItems — who sees what, where', () => {
  const router = productionRouter();

  it('the new-task composer offers every command that works without a session; one that only answers says where', () => {
    // A new task's first message that only answers (`/help`, `/model opus`) is launched answer-only: the command
    // answers in the new Slack thread and the dashboard links it (no task card). Rows that need the thread's
    // session (`/compact`, `!`, `%effort` …) are not possible in a new thread.
    const suffix = ' · 답은 Slack 스레드에';
    for (const admin of [false, true]) {
      const rows = composerCommandItems({ where: 'new-task', admin });
      const values = rows.map((r) => r.value);
      const expected = COMPOSER_COMMANDS.filter((c) => !c.session && (admin || !c.admin)).map((c) => c.value);
      expect(values).toEqual(expected);
      for (const v of ['/goal', '%model', '/onboarding', '/help', '/model', '/lang', '/cron', '/usage', '/z'])
        expect(values).toContain(v);
      for (const v of ['/compact --yes', '!', '/close', '%effort', '/rollback']) expect(values).not.toContain(v);
      for (const r of rows) {
        const control = router.classifyText(r.example ?? '', 'U_ADMIN') === 'control';
        expect(r.description?.endsWith(suffix), `${r.value}: ${r.example}`).toBe(control);
      }
    }
    expect(composerCommandItems({ where: 'new-task', admin: false }).length).toBeGreaterThan(30);
  });

  it('an open session lists every command; admins also see the admin rows', () => {
    const session = composerCommandItems({ where: 'session', admin: false }).map((i) => i.value);
    const admin = composerCommandItems({ where: 'session', admin: true }).map((i) => i.value);
    expect(session).toContain('/compact --yes');
    expect(session).toContain('/help');
    expect(session).not.toContain('/cct');
    expect(admin).toContain('/cct');
    expect(admin.length).toBeGreaterThan(session.length);
  });

  it('a command that only answers says the answer is in the Slack thread — exactly the router’s controls', () => {
    const suffix = ' · 답은 Slack 스레드에';
    for (const r of composerCommandItems({ where: 'session', admin: true })) {
      if (r.value === '!') continue; // the stop marker is read before routing; the turn it stops is on the board
      const control = router.classifyText(r.example ?? '', 'U_ADMIN') === 'control';
      expect(r.description?.endsWith(suffix), `${r.value}: ${r.example}`).toBe(control);
    }
  });

  it('/compact goes with --yes: its confirmation is a Slack-only button', () => {
    const row = composerCommandItems({ where: 'session', admin: false }).find((r) => r.value.startsWith('/compact'));
    expect(row?.value).toBe('/compact --yes');
  });

  it('rows carry the description, the grey example and the group', () => {
    const model = composerCommandItems({ where: 'session', admin: false }).find((i) => i.value === '/model');
    expect(model).toEqual({
      value: '/model',
      description: '기본 모델 보기·바꾸기 (다음 세션부터) · 답은 Slack 스레드에',
      example: '/model opus',
      group: '설정',
    });
  });
});

describe('skill descriptions', () => {
  it('reads the frontmatter description in every shape SKILL.md files use', () => {
    expect(skillDescriptionOf('---\nname: a\ndescription: Plain words here\n---\nbody')).toBe('Plain words here');
    expect(skillDescriptionOf('---\nname: a\ndescription: "Quoted: with colon \\"x\\""\n---')).toBe(
      'Quoted: with colon "x"',
    );
    expect(skillDescriptionOf("---\ndescription: 'It''s single'\n---")).toBe("It's single");
    expect(skillDescriptionOf('---\ndescription: >\n  folded\n  lines\nname: a\n---')).toBe('folded lines');
    expect(skillDescriptionOf('---\nname: a\n---')).toBe('');
    expect(skillDescriptionOf('no frontmatter')).toBe('');
  });

  it('cuts a long description at a word', () => {
    const long = `${'word '.repeat(60)}end`;
    const out = shortDescription(long, 40);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out.endsWith('…')).toBe(true);
    expect(shortDescription('short')).toBe('short');
  });

  it('names a skill so the resolver never has to guess', () => {
    expect(skillToken({ name: 'autoz', source: 'local' })).toBe('$local:autoz');
    expect(skillToken({ name: 'dev', source: 'user' })).toBe('$user:dev');
    expect(skillToken({ name: 'debug', source: 'stv' })).toBe('$stv:debug');
  });
});

function skillDeps(over: Partial<ComposerSkillDeps> = {}): ComposerSkillDeps {
  const files: Record<string, string> = {
    '/l/autoz': '---\nname: autoz\ndescription: "Autonomous z-pipeline driver."\n---',
    '/p/stv/debug': '---\nname: debug\ndescription: Follow the callstack\n---',
    '/p/envp/secret': '---\nname: secret\ndescription: Env-only skill\n---',
  };
  return {
    listSkills: () => [
      { name: 'autoz', source: 'local' },
      { name: 'debug', source: 'stv' },
      { name: 'dev', source: 'user' },
      { name: 'secret', source: 'envp' },
    ],
    listOwnSkills: () => [{ name: 'dev', description: 'Deploy to dev' }],
    skillFile: (s) => (s.source === 'local' ? `/l/${s.name}` : s.source === 'user' ? null : `/p/${s.source}/${s.name}`),
    envPluginNames: () => new Set(['envp']),
    envSkillAllowed: () => false,
    fs: {
      readFileSync: (f: string) => {
        if (!(f in files)) throw new Error('ENOENT');
        return files[f];
      },
    },
    now: () => 0,
    ...over,
  };
}

describe('composerSkillItems — every skill this user can invoke', () => {
  it('own skills first, then the built-in ones, then each plugin; each with its token and description', () => {
    resetComposerMenuCache();
    const rows = composerSkillItems({ userId: 'U1', admin: false }, skillDeps());
    expect(rows).toEqual([
      { value: '$user:dev', group: '내 스킬', description: 'Deploy to dev' },
      { value: '$local:autoz', group: '기본 스킬', description: 'Autonomous z-pipeline driver.' },
      // An environment skill this user holds no grant for: named (invoking it asks an admin), its words not shown.
      { value: '$envp:secret', group: 'envp', description: '관리자 승인 필요' },
      { value: '$stv:debug', group: 'stv', description: 'Follow the callstack' },
    ]);
  });

  it('an environment skill is plain for an admin or a granted user', () => {
    resetComposerMenuCache();
    const admin = composerSkillItems({ userId: 'U1', admin: true }, skillDeps());
    expect(admin.find((r) => r.value === '$envp:secret')?.description).toBe('Env-only skill');
    resetComposerMenuCache();
    const granted = composerSkillItems({ userId: 'U2', admin: false }, skillDeps({ envSkillAllowed: () => true }));
    expect(granted.find((r) => r.value === '$envp:secret')?.description).toBe('Env-only skill');
  });

  it('an edited SKILL.md description shows once the minute is up', () => {
    resetComposerMenuCache();
    let now = 0;
    let text = '---\ndescription: Old words\n---';
    const deps = skillDeps({
      listSkills: () => [{ name: 'autoz', source: 'local' }],
      skillFile: () => '/l/autoz',
      fs: { readFileSync: () => text },
      now: () => now,
    });
    expect(composerSkillItems({ userId: 'U1', admin: false }, deps)[0].description).toBe('Old words');
    text = '---\ndescription: New words\n---';
    now = 61_000;
    expect(composerSkillItems({ userId: 'U1', admin: false }, deps)[0].description).toBe('New words');
  });

  it('caches the listing for a minute per user', () => {
    resetComposerMenuCache();
    let now = 0;
    const listSkills = vi.fn(skillDeps().listSkills);
    const deps = skillDeps({ listSkills, now: () => now });
    composerSkillItems({ userId: 'U1', admin: false }, deps);
    composerSkillItems({ userId: 'U1', admin: false }, deps);
    expect(listSkills).toHaveBeenCalledTimes(1);
    now = 61_000;
    composerSkillItems({ userId: 'U1', admin: false }, deps);
    expect(listSkills).toHaveBeenCalledTimes(2);
  });
});

describe('composerTriggers', () => {
  it('the new task lists every skill too, $user (the skills card, answered in the thread) first', () => {
    resetComposerMenuCache();
    const newTask = composerTriggers({ where: 'new-task', userId: 'U1', admin: false }, skillDeps());
    const dollar = newTask.find((t) => t.char === '$');
    expect(dollar?.items[0].value).toBe('$user');
    expect(dollar?.items.map((i) => i.value)).toContain('$local:autoz');
  });

  it('/ every command, % the session settings, $ the skills led by $user', () => {
    resetComposerMenuCache();
    const triggers = composerTriggers({ where: 'session', userId: 'U1', admin: false }, skillDeps());
    expect(triggers.map((t) => [t.char, t.at])).toEqual([
      ['/', 'start'],
      ['%', 'start'],
      ['$', 'word'],
    ]);
    const [slash, pct, dollar] = triggers;
    expect(slash.items.length).toBe(composerCommandItems({ where: 'session', admin: false }).length);
    expect(pct.items.every((i) => i.value.startsWith('%'))).toBe(true);
    expect(dollar.items[0].value).toBe('$user');
    expect(dollar.items.map((i) => i.value)).toContain('$local:autoz');
  });
});

describe('display language — every word of the menus has English', () => {
  it('descriptions, groups and menu labels translate (en-text.json)', async () => {
    // The English catalog src/index.ts loads (`@soma/common/i18n-en`), read from source as task-plan-html.test.ts does.
    const { hasDisplayText, registerDisplayCatalog, runWithDisplayLang } = await import('@soma/common/i18n');
    const catalog = join(__dirname, '..', '..', '..', 'packages', 'common', 'src', 'i18n-catalog', 'en-text.json');
    registerDisplayCatalog('en', JSON.parse(readFileSync(catalog, 'utf8')));
    const hangul = /[가-힣]/;
    const sources = new Set<string>();
    for (const c of COMPOSER_COMMANDS) {
      sources.add(c.description);
      sources.add(c.group);
    }
    for (const s of [
      '명령어',
      '세션 설정',
      '스킬',
      '내 스킬',
      '기본 스킬',
      '관리자 승인 필요',
      '답은 Slack 스레드에',
      '내 스킬 목록 카드 (보기 · 편집 · 공유)',
    ])
      sources.add(s);
    const missing = [...sources].filter((s) => !hasDisplayText(s, 'en'));
    expect(missing).toEqual([]);
    resetComposerMenuCache();
    const en = runWithDisplayLang('en', () =>
      composerTriggers({ where: 'session', userId: 'U1', admin: true }, skillDeps()),
    );
    const words = en.flatMap((t) => [t.label ?? '', ...t.items.flatMap((i) => [i.description ?? '', i.group ?? ''])]);
    expect(words.filter((w) => hangul.test(w))).toEqual([]);
  });
});
