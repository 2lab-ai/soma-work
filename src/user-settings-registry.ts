/**
 * Personal settings registry (SSOT 2026-10-23 T2).
 *
 * Every per-user setting a user can see or change with a Slack command, in one
 * table the dashboard reads and writes. Writes go through the SAME mutation
 * path Slack uses: the `/z` card's `apply*` function where the setting has a
 * card (model, persona, theme, verbosity, permission mode, sandbox, notify,
 * email), otherwise the same validator + store setter the Slack command calls
 * (effort, autogoal, goal max, autoskills, rating, Telegram, webhook). So the
 * dashboard cannot accept a value Slack would refuse, and side effects (prompt
 * invalidation, the pending-rating note) are shared.
 *
 * Coverage is pinned by `SLACK_SETTER_COVERAGE`: every `UserSettingsStore`
 * mutator a Slack surface calls is mapped to a registry key or to a reason it
 * is not a personal setting. The contract test fails when a Slack command
 * starts calling a mutator this table does not know about.
 */

import type { LogVerbosity } from '@soma/slack/output-flags';
import type { PermissionMode } from './agent-runtime/policy/permission-mode';
import type { EffortLevel, NotificationSettings, SessionTheme } from './user-settings-store';

export type SettingKey =
  | 'defaultModel'
  | 'defaultEffort'
  | 'logVerbosity'
  | 'sessionTheme'
  | 'persona'
  | 'notifySlackDm'
  | 'notifyTelegram'
  | 'notifyWebhook'
  | 'autoGoal'
  | 'goalMaxContinuations'
  | 'autoskills'
  | 'email'
  | 'rating'
  | 'workingDirectory'
  | 'permissionMode'
  | 'sandbox'
  | 'sandboxNetwork';

export type SettingGroup = 'model' | 'output' | 'notify' | 'goal' | 'skills' | 'account' | 'permissions';

export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string; description: string }> = [
  { id: 'model', label: '모델 · effort', description: '새 세션이 시작할 때 쓰는 기본값입니다.' },
  { id: 'output', label: '출력', description: 'Slack 스레드에 보이는 양과 모양, 말투입니다.' },
  { id: 'notify', label: '알림', description: '턴이 끝났을 때 어디로 알릴지 정합니다.' },
  { id: 'goal', label: '목표', description: '목표가 자동으로 이어지는 방식입니다.' },
  { id: 'skills', label: '자동 스킬', description: '모든 세션에 자동으로 넣을 스킬입니다.' },
  { id: 'account', label: '계정', description: '연락처와 작업 위치입니다.' },
  {
    id: 'permissions',
    label: '권한',
    description: '에이전트가 도구를 얼마나 자유롭게 쓰는지 정합니다. 바꾸기 전에 설명을 읽으세요.',
  },
];

export type SettingKind = 'choice' | 'toggle' | 'text' | 'number' | 'list' | 'readonly';

export interface SettingOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingView {
  key: SettingKey;
  group: SettingGroup;
  label: string;
  description: string;
  kind: SettingKind;
  value: unknown;
  defaultValue?: unknown;
  /** The value differs from the default (the page marks the row). */
  modified: boolean;
  options?: SettingOption[];
  /** For `choice`: a value outside `options` may be typed (default model). */
  allowCustom?: boolean;
  min?: number;
  max?: number;
  maxItems?: number;
  editable: boolean;
  /** Writes need an admin (the Slack command has the same gate). */
  adminOnly?: boolean;
  /** Why the row cannot be edited by this user. */
  lockedReason?: string;
  /** Consequential setting — shown in the danger zone, confirmed before saving. */
  danger?: boolean;
  /** The equivalent Slack command. */
  slackCommand: string;
}

export interface SettingsSnapshot {
  userId: string;
  isAdmin: boolean;
  /** Admin acceptance — without it the page is read-only. */
  accepted: boolean;
  groups: typeof SETTING_GROUPS;
  settings: SettingView[];
}

export class SettingsError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** What an `apply*` function of a `/z` topic returns. */
export interface ApplyResultLike {
  ok: boolean;
  summary: string;
  description?: string;
}
type ApplyFn = (args: { userId: string; value: string }) => Promise<ApplyResultLike>;

/** The store surface the registry reads and writes (the real one is `userSettingsStore`). */
export interface SettingsStoreLike {
  getUserDefaultModel(userId: string): string;
  setUserDefaultModel(userId: string, model: string): void;
  getModelDisplayName(model: string): string;
  getUserDefaultEffort(userId: string): EffortLevel;
  setUserDefaultEffort(userId: string, effort: EffortLevel): void;
  resolveEffortInput(input: string): EffortLevel | null;
  getUserDefaultLogVerbosity(userId: string): LogVerbosity;
  getUserSessionTheme(userId: string): SessionTheme;
  getUserPersona(userId: string): string;
  getUserEmail(userId: string): string | undefined;
  getUserSettings(userId: string): { notification?: NotificationSettings } | undefined;
  patchNotification(userId: string, patch: Partial<NotificationSettings>): void;
  getUserAutoGoalEnabled(userId: string): boolean;
  setUserAutoGoalEnabled(userId: string, enabled: boolean): void;
  getUserGoalMaxContinuations(userId: string): number | undefined;
  setUserGoalMaxContinuations(userId: string, value: number): void;
  getUserAutoskills(userId: string): string[];
  setUserAutoskills(userId: string, skills: string[]): void;
  getUserRating(userId: string): number;
  changeUserRating(userId: string, rating: number): { from: number; to: number };
  getUserPermissionMode(userId: string): PermissionMode;
  getUserSandboxDisabled(userId: string): boolean;
  getUserNetworkDisabled(userId: string): boolean;
}

export interface SettingsRegistryDeps {
  store: SettingsStoreLike;
  /**
   * The /z model resolver without the save (`resolveModelChoice`): the model
   * write re-checks admin acceptance after this await, right before saving.
   */
  resolveModel(
    value: string,
  ): Promise<{ ok: true; modelId: string } | { ok: false; summary: string; description?: string }>;
  apply: {
    persona: ApplyFn;
    theme: ApplyFn;
    verbosity: ApplyFn;
    permissionMode: ApplyFn;
    sandbox: ApplyFn;
    notify: ApplyFn;
    email: ApplyFn;
  };
  effortLevels: readonly string[];
  verbosityLevels: readonly string[];
  themes: Readonly<Record<string, string>>;
  defaults: { model: string; effort: string; verbosity: string; theme: string; goalMaxContinuations: number };
  goalMaxBounds: { min: number; max: number };
  maxAutoskills: number;
  validateGoalMax(value: unknown): number;
  listPersonas(): string[];
  /** Representative models (nickname + the model id it resolves to). */
  listModels(userId: string): Array<{ nickname: string; model: string; label: string }>;
  listSkills(userId: string): Array<{ name: string; source?: string; description?: string }>;
  skillExists(name: string, userId: string): boolean;
  validateWebhookUrl(url: string): { valid: boolean; error?: string };
  workingDirectoryFor(userId: string): string | undefined;
  isAdmin(userId: string): boolean;
  /**
   * Admin acceptance. A write for a user without it is refused: every store
   * setter re-creates a missing record as accepted, so a settings write would
   * otherwise undo an admin's deny (design review P1).
   */
  isAccepted(userId: string): boolean;
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const VERBOSITY_LABELS: Record<string, string> = {
  minimal: 'Minimal — 결과만',
  compact: 'Compact — 요약',
  detail: 'Detail — 도구 호출까지',
  verbose: 'Verbose — 전부',
};
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

/**
 * Every `UserSettingsStore` mutator a Slack surface (`src/slack/**`) calls,
 * mapped to the registry key that exposes it, or to why it is not a personal
 * setting. Pinned by `user-settings-registry.slack-coverage.test.ts`.
 */
export const SLACK_SETTER_COVERAGE: Readonly<Record<string, SettingKey | { excluded: string }>> = {
  setUserDefaultModel: 'defaultModel',
  setUserDefaultEffort: 'defaultEffort',
  setUserDefaultLogVerbosity: 'logVerbosity',
  setUserSessionTheme: 'sessionTheme',
  setUserPersona: 'persona',
  patchNotification: 'notifySlackDm',
  setUserAutoGoalEnabled: 'autoGoal',
  toggleUserAutoGoalEnabled: 'autoGoal',
  setUserGoalMaxContinuations: 'goalMaxContinuations',
  setUserAutoskills: 'autoskills',
  addUserAutoskill: 'autoskills',
  removeUserAutoskill: 'autoskills',
  setUserEmail: 'email',
  setUserRating: 'rating',
  setPendingRatingChange: 'rating',
  changeUserRating: 'rating',
  setUserPermissionMode: 'permissionMode',
  setUserSandboxDisabled: 'sandbox',
  setUserNetworkDisabled: 'sandboxNetwork',
  clearUserCompactThreshold: {
    excluded: 'deprecated: `compact-threshold` only clears it and moves the value onto the session',
  },
  acceptUser: { excluded: 'admin action on another user (accept / deny), not a personal setting' },
  removeUserSettings: { excluded: 'admin action on another user (deny), not a personal setting' },
  createPendingUser: { excluded: 'onboarding bookkeeping, not a personal setting' },
  ensureUserExists: { excluded: 'onboarding bookkeeping, not a personal setting' },
  updateUserJiraInfo: { excluded: 'synced from the Jira mapping file, not user-editable' },
  setUserSlackDisplayName: { excluded: 'synced from the Slack profile, not user-editable' },
  consumePendingRatingChange: { excluded: 'read-and-clear by the prompt builder, not a write path' },
};

/** Slack card text → plain sentence for the page (drop mrkdwn markers). */
function plain(text: string): string {
  return text.replace(/[`*_]/g, '').trim();
}

async function viaApply(fn: ApplyFn, userId: string, value: string): Promise<void> {
  const r = await fn({ userId, value });
  if (!r.ok) {
    throw new SettingsError(400, plain([r.summary, r.description].filter(Boolean).join(' — ')));
  }
}

function expectString(value: unknown, key: SettingKey): string {
  if (typeof value !== 'string') throw new SettingsError(400, `${key}: 문자열이어야 합니다`);
  if (value.length > 2000) throw new SettingsError(400, `${key}: 너무 깁니다`);
  return value;
}

function expectBoolean(value: unknown, key: SettingKey): boolean {
  if (typeof value !== 'boolean') throw new SettingsError(400, `${key}: true 또는 false여야 합니다`);
  return value;
}

export interface SettingsRegistry {
  read(userId: string): SettingsSnapshot;
  write(userId: string, key: string, value: unknown): Promise<SettingView>;
}

export function createSettingsRegistry(deps: SettingsRegistryDeps): SettingsRegistry {
  const { store } = deps;

  function assertAccepted(userId: string): void {
    if (!deps.isAccepted(userId)) throw new SettingsError(403, '관리자 승인을 받은 뒤에 설정을 바꿀 수 있습니다');
  }

  function view(userId: string, key: SettingKey): SettingView {
    const isAdmin = deps.isAdmin(userId);
    switch (key) {
      case 'defaultModel': {
        const value = store.getUserDefaultModel(userId);
        const models = deps.listModels(userId);
        const options = models.map((m) => ({ value: m.nickname, label: m.label, description: m.model }));
        const current = models.find((m) => m.model === value);
        if (!current) options.unshift({ value, label: store.getModelDisplayName(value), description: value });
        return {
          key,
          group: 'model',
          label: '기본 모델',
          description: '새 세션이 쓰는 모델입니다. 진행 중인 세션은 세션 카드나 패널에서 바꿉니다.',
          kind: 'choice',
          value: current ? current.nickname : value,
          defaultValue: deps.defaults.model,
          modified: value !== deps.defaults.model,
          options,
          allowCustom: true,
          editable: true,
          slackCommand: 'model set <모델>',
        };
      }
      case 'defaultEffort': {
        const value = store.getUserDefaultEffort(userId);
        return {
          key,
          group: 'model',
          label: '기본 effort',
          description: '새 세션의 추론 강도입니다. 높을수록 느리고 토큰을 더 씁니다.',
          kind: 'choice',
          value,
          defaultValue: deps.defaults.effort,
          modified: value !== deps.defaults.effort,
          options: deps.effortLevels.map((l) => ({ value: l, label: EFFORT_LABELS[l] ?? l })),
          editable: true,
          slackCommand: 'effort <low|medium|high|xhigh|max>',
        };
      }
      case 'logVerbosity': {
        const value = store.getUserDefaultLogVerbosity(userId);
        return {
          key,
          group: 'output',
          label: '출력 상세도',
          description: '스레드에 도구 호출과 중간 과정을 얼마나 보여줄지 정합니다.',
          kind: 'choice',
          value,
          defaultValue: deps.defaults.verbosity,
          modified: value !== deps.defaults.verbosity,
          options: deps.verbosityLevels.map((l) => ({ value: l, label: VERBOSITY_LABELS[l] ?? l })),
          editable: true,
          slackCommand: 'verbosity <minimal|compact|detail|verbose>',
        };
      }
      case 'sessionTheme': {
        const value = store.getUserSessionTheme(userId);
        return {
          key,
          group: 'output',
          label: '스레드 헤더 테마',
          description: 'Slack 스레드 헤더와 턴 종료 카드의 모양입니다.',
          kind: 'choice',
          value,
          defaultValue: deps.defaults.theme,
          modified: value !== deps.defaults.theme,
          options: Object.entries(deps.themes).map(([id, name]) => ({ value: id, label: `${id} · ${name}` })),
          editable: true,
          slackCommand: 'theme <default|compact|minimal>',
        };
      }
      case 'persona': {
        const value = store.getUserPersona(userId);
        return {
          key,
          group: 'output',
          label: '페르소나',
          description: '에이전트의 말투와 판단 기준입니다. 새 세션부터 적용됩니다.',
          kind: 'choice',
          value,
          defaultValue: 'default',
          modified: value !== 'default',
          options: deps.listPersonas().map((p) => ({ value: p, label: p })),
          editable: true,
          slackCommand: 'persona set <이름>',
        };
      }
      case 'notifySlackDm': {
        const value = !!store.getUserSettings(userId)?.notification?.slackDm;
        return {
          key,
          group: 'notify',
          label: 'Slack DM 알림',
          description: '턴이 끝나면 Slack DM으로 알립니다.',
          kind: 'toggle',
          value,
          defaultValue: false,
          modified: value,
          editable: true,
          slackCommand: 'notify on|off',
        };
      }
      case 'notifyTelegram': {
        const value = store.getUserSettings(userId)?.notification?.telegramChatId ?? '';
        return {
          key,
          group: 'notify',
          label: '텔레그램 Chat ID',
          description: '숫자 Chat ID를 넣으면 턴 종료를 텔레그램으로도 알립니다. 비우면 해제됩니다.',
          kind: 'text',
          value,
          defaultValue: '',
          modified: value !== '',
          editable: true,
          slackCommand: 'notify telegram <chat_id> | notify telegram off',
        };
      }
      case 'notifyWebhook': {
        const value = store.getUserSettings(userId)?.notification?.webhookUrl ?? '';
        return {
          key,
          group: 'notify',
          label: '웹훅 URL',
          description: 'HTTPS 주소만 받습니다. 내부망 주소는 거부됩니다. 비우면 삭제됩니다.',
          kind: 'text',
          value,
          defaultValue: '',
          modified: value !== '',
          editable: true,
          slackCommand: 'webhook register <url> | webhook remove',
        };
      }
      case 'autoGoal': {
        const value = store.getUserAutoGoalEnabled(userId);
        return {
          key,
          group: 'goal',
          label: '자동 목표',
          description: '목표가 없는 세션에서 다음 지시를 자동으로 목표로 삼습니다.',
          kind: 'toggle',
          value,
          defaultValue: false,
          modified: value,
          editable: true,
          slackCommand: 'goal auto on|off',
        };
      }
      case 'goalMaxContinuations': {
        const stored = store.getUserGoalMaxContinuations(userId);
        const value = stored ?? deps.defaults.goalMaxContinuations;
        return {
          key,
          group: 'goal',
          label: '목표 자동 연속 최대 횟수',
          description:
            '새 목표가 스스로 이어갈 수 있는 최대 턴 수입니다. 진행 중인 목표는 Slack `goal max`로 바꿉니다.',
          kind: 'number',
          value,
          defaultValue: deps.defaults.goalMaxContinuations,
          modified: stored !== undefined && stored !== deps.defaults.goalMaxContinuations,
          min: deps.goalMaxBounds.min,
          max: deps.goalMaxBounds.max,
          editable: true,
          slackCommand: 'goal max <N>',
        };
      }
      case 'autoskills': {
        const value = store.getUserAutoskills(userId);
        return {
          key,
          group: 'skills',
          label: '자동 스킬',
          description: `모든 새 세션에 자동으로 넣을 스킬입니다. 최대 ${deps.maxAutoskills}개.`,
          kind: 'list',
          value,
          defaultValue: [],
          modified: value.length > 0,
          options: deps.listSkills(userId).map((s) => ({
            value: s.name,
            label: s.name,
            ...(s.description ? { description: s.description } : {}),
          })),
          maxItems: deps.maxAutoskills,
          editable: true,
          slackCommand: 'set autoskill <a, b> | set autoskill clear',
        };
      }
      case 'email': {
        const value = store.getUserEmail(userId) ?? '';
        return {
          key,
          group: 'account',
          label: '이메일',
          description: '커밋과 PR의 Co-Authored-By에 쓰입니다. 비우면 삭제됩니다.',
          kind: 'text',
          value,
          defaultValue: '',
          modified: false,
          editable: true,
          slackCommand: 'set email <주소>',
        };
      }
      case 'rating': {
        const value = store.getUserRating(userId);
        return {
          key,
          group: 'account',
          label: '모델 평가 점수',
          description: '에이전트에게 전하는 만족도(0–10)입니다. 바뀌면 다음 메시지에서 에이전트가 알게 됩니다.',
          kind: 'number',
          value,
          defaultValue: 5,
          modified: value !== 5,
          min: 0,
          max: 10,
          editable: true,
          slackCommand: 'rate + | rate -',
        };
      }
      case 'workingDirectory': {
        const value = deps.workingDirectoryFor(userId) ?? '';
        return {
          key,
          group: 'account',
          label: '작업 디렉터리',
          description: '사용자마다 고정된 경로입니다. 바꿀 수 없습니다.',
          kind: 'readonly',
          value,
          modified: false,
          editable: false,
          lockedReason: '사용자별로 고정된 경로입니다.',
          slackCommand: 'cwd',
        };
      }
      case 'permissionMode': {
        const value = store.getUserPermissionMode(userId);
        const options: SettingOption[] = [
          { value: 'auto', label: '자동 (권장)', description: '위험한 도구는 실행 전에 확인합니다.' },
          { value: 'bypass', label: '확인 없이 실행', description: '모든 도구를 확인 없이 실행합니다.' },
        ];
        if (value === 'legacy') options.push({ value: 'legacy', label: 'legacy', description: '이전 방식' });
        return {
          key,
          group: 'permissions',
          label: '권한 모드',
          description: '확인 없이 실행하면 에이전트가 파일 삭제나 배포 명령도 묻지 않고 실행합니다.',
          kind: 'choice',
          value,
          defaultValue: 'auto',
          modified: value !== 'auto',
          options,
          editable: true,
          danger: true,
          slackCommand: 'bypass on|off',
        };
      }
      case 'sandbox': {
        const value = !store.getUserSandboxDisabled(userId);
        return {
          key,
          group: 'permissions',
          label: '샌드박스',
          description: '끄면 Bash 명령이 격리 없이 실행됩니다. 다음 메시지부터 적용됩니다.',
          kind: 'toggle',
          value,
          defaultValue: true,
          modified: !value,
          editable: isAdmin,
          adminOnly: true,
          ...(isAdmin ? {} : { lockedReason: '관리자만 바꿀 수 있습니다.' }),
          danger: true,
          slackCommand: 'sandbox on|off',
        };
      }
      case 'sandboxNetwork': {
        const value = !store.getUserNetworkDisabled(userId);
        return {
          key,
          group: 'permissions',
          label: '네트워크 허용 목록',
          description: '켜면 샌드박스 안의 아웃바운드 접속을 개발용 도메인으로 제한합니다.',
          kind: 'toggle',
          value,
          defaultValue: true,
          modified: !value,
          editable: true,
          danger: true,
          slackCommand: 'sandbox network on|off',
        };
      }
    }
  }

  const ORDER: SettingKey[] = [
    'defaultModel',
    'defaultEffort',
    'logVerbosity',
    'sessionTheme',
    'persona',
    'notifySlackDm',
    'notifyTelegram',
    'notifyWebhook',
    'autoGoal',
    'goalMaxContinuations',
    'autoskills',
    'email',
    'rating',
    'workingDirectory',
    'permissionMode',
    'sandbox',
    'sandboxNetwork',
  ];

  async function apply(userId: string, key: SettingKey, value: unknown): Promise<void> {
    switch (key) {
      case 'defaultModel': {
        // A representative nickname (what the menus offer, e.g. grok[1m]) is
        // saved as the model id it stands for — the /z model resolver does not
        // know every nickname (grok[1m] → grok-4.6 lives in model-switch).
        const input = expectString(value, key).trim();
        const rep = deps.listModels(userId).find((m) => m.nickname === input);
        const choice = await deps.resolveModel(rep ? rep.model : input);
        if (!choice.ok) {
          throw new SettingsError(400, plain([choice.summary, choice.description].filter(Boolean).join(' — ')));
        }
        // The resolution may have waited on a catalog refresh: an admin deny in
        // that window must win — every setter re-creates a missing record as
        // accepted, so check again right before the synchronous save.
        assertAccepted(userId);
        store.setUserDefaultModel(userId, choice.modelId);
        return;
      }
      case 'defaultEffort': {
        const effort = store.resolveEffortInput(expectString(value, key));
        if (!effort) throw new SettingsError(400, `effort는 ${deps.effortLevels.join(', ')} 중 하나여야 합니다`);
        store.setUserDefaultEffort(userId, effort);
        return;
      }
      case 'logVerbosity':
        return viaApply(deps.apply.verbosity, userId, expectString(value, key));
      case 'sessionTheme':
        return viaApply(deps.apply.theme, userId, expectString(value, key));
      case 'persona':
        return viaApply(deps.apply.persona, userId, expectString(value, key));
      case 'notifySlackDm':
        return viaApply(deps.apply.notify, userId, expectBoolean(value, key) ? 'dm_on' : 'dm_off');
      case 'notifyTelegram': {
        const id = expectString(value, key).trim();
        if (!id) return viaApply(deps.apply.notify, userId, 'tg_clear');
        if (!TELEGRAM_CHAT_ID.test(id)) throw new SettingsError(400, 'Chat ID는 숫자만 받습니다 (그룹은 앞에 -)');
        store.patchNotification(userId, { telegramChatId: id });
        return;
      }
      case 'notifyWebhook': {
        const url = expectString(value, key).trim();
        if (!url) {
          store.patchNotification(userId, { webhookUrl: undefined });
          return;
        }
        const v = deps.validateWebhookUrl(url);
        if (!v.valid) throw new SettingsError(400, v.error || '웹훅 URL을 쓸 수 없습니다');
        store.patchNotification(userId, { webhookUrl: url });
        return;
      }
      case 'autoGoal':
        store.setUserAutoGoalEnabled(userId, expectBoolean(value, key));
        return;
      case 'goalMaxContinuations': {
        let n: number;
        try {
          n = deps.validateGoalMax(value);
        } catch (e) {
          throw new SettingsError(400, `${(e as Error).message} (${deps.goalMaxBounds.min}–${deps.goalMaxBounds.max})`);
        }
        store.setUserGoalMaxContinuations(userId, n);
        return;
      }
      case 'autoskills': {
        if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
          throw new SettingsError(400, 'autoskills: 스킬 이름 목록이어야 합니다');
        }
        const names = [...new Set((value as string[]).map((s) => s.trim()).filter(Boolean))];
        if (names.length > deps.maxAutoskills) {
          throw new SettingsError(400, `자동 스킬은 최대 ${deps.maxAutoskills}개입니다`);
        }
        const unknown = names.filter((n) => !deps.skillExists(n, userId));
        if (unknown.length) throw new SettingsError(400, `찾을 수 없는 스킬: ${unknown.join(', ')}`);
        store.setUserAutoskills(userId, names);
        return;
      }
      case 'email': {
        const email = expectString(value, key).trim();
        return viaApply(deps.apply.email, userId, email || 'clear');
      }
      case 'rating': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10) {
          throw new SettingsError(400, '평가 점수는 0–10 정수입니다');
        }
        store.changeUserRating(userId, value);
        return;
      }
      case 'workingDirectory':
        throw new SettingsError(400, '작업 디렉터리는 사용자별로 고정되어 바꿀 수 없습니다');
      case 'permissionMode':
        return viaApply(deps.apply.permissionMode, userId, expectString(value, key));
      case 'sandbox':
        // applySandbox enforces the admin gate itself (`isAdminUser`), like Slack.
        return viaApply(deps.apply.sandbox, userId, expectBoolean(value, key) ? 'on' : 'off');
      case 'sandboxNetwork':
        return viaApply(deps.apply.sandbox, userId, expectBoolean(value, key) ? 'network_on' : 'network_off');
    }
  }

  return {
    read(userId) {
      return {
        userId,
        isAdmin: deps.isAdmin(userId),
        accepted: deps.isAccepted(userId),
        groups: SETTING_GROUPS,
        settings: ORDER.map((k) => view(userId, k)),
      };
    },
    async write(userId, key, value) {
      if (!(ORDER as string[]).includes(key)) throw new SettingsError(400, `알 수 없는 설정: ${key}`);
      assertAccepted(userId);
      const k = key as SettingKey;
      const before = view(userId, k);
      if (!before.editable) throw new SettingsError(403, before.lockedReason || '바꿀 수 없는 설정입니다');
      await apply(userId, k, value);
      return view(userId, k);
    },
  };
}
