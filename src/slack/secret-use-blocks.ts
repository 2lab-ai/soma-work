/**
 * Block Kit for the secret-use prompt the admins receive (secret-access WU2, #1338, `.prd/32-secret-access-spec.md`
 * §4.1): a non-admin's model called a server-tools tool that uses secrets the requester holds no grant for.
 *
 * Three answers, in this order — the words of the request (SSOT_1 "수락, 거부, 앞으로 계속 자동 수락"):
 *   - 수락 (이 스레드)       → the requester's tools may use these secrets in that thread (12 h)
 *   - 거부                   → no grant; the requester is told
 *   - 앞으로 계속 자동 수락   → the requester's tools may use these secrets anywhere, from now on
 *
 * Each button carries ONLY the `requestId`; the request (names, requester, thread) is read back server-side from
 * the admin request store, so a forged or replayed payload cannot fabricate a grant. The same list feeds the
 * dashboard's approval card (`secretUseChoices`). Names only — a secret value is never on a card.
 */

import { describeRequestPlace } from './env-skill-permission-blocks';

/** action_id prefix so the Bolt router (`/^secret_use_/`) dispatches here. */
export const SECRET_USE_ACTION_ID_PREFIX = 'secret_use_';

export const VALUE_KIND_SECRET_ONCE = 'secret_once';
export const VALUE_KIND_SECRET_DENY = 'secret_deny';
export const VALUE_KIND_SECRET_ALWAYS = 'secret_always';

export type SecretUseKind =
  | typeof VALUE_KIND_SECRET_ONCE
  | typeof VALUE_KIND_SECRET_DENY
  | typeof VALUE_KIND_SECRET_ALWAYS;

const KINDS: ReadonlySet<string> = new Set([VALUE_KIND_SECRET_ONCE, VALUE_KIND_SECRET_DENY, VALUE_KIND_SECRET_ALWAYS]);

export function isSecretUseKind(value: unknown): value is SecretUseKind {
  return typeof value === 'string' && KINDS.has(value);
}

export interface SecretUseChoice {
  kind: SecretUseKind;
  label: string;
  style?: 'primary' | 'danger';
}

/** The admin's answers, in order — the Slack prompt and the dashboard card show the same ones. */
export function secretUseChoices(): SecretUseChoice[] {
  return [
    { kind: VALUE_KIND_SECRET_ONCE, label: '✅ 수락 (이 스레드)', style: 'primary' },
    { kind: VALUE_KIND_SECRET_DENY, label: '❌ 거부', style: 'danger' },
    { kind: VALUE_KIND_SECRET_ALWAYS, label: '🔁 앞으로 계속 자동 수락' },
  ];
}

export interface SecretUseView {
  requestId: string;
  requesterId: string;
  names: readonly string[];
  /** The server-tools tool, without the `mcp__server-tools__` prefix. */
  tool: string;
  server: string;
  channel: string;
  threadTs?: string;
  /** The tool is an admin's by default (`gh_pr`, `cf_api`, `login` …): the card says so. */
  adminOnlyTool: boolean;
}

export function secretNamesText(names: readonly string[]): string {
  return names.map((n) => `\`${n}\``).join(', ');
}

/** The prompt's one line — also the DM's notification text. */
export function secretUseTitle(view: Pick<SecretUseView, 'requesterId' | 'names'>): string {
  return `🔑 비밀 사용 요청 — <@${view.requesterId}>님의 모델이 비밀 ${secretNamesText(view.names)}을(를) 쓰려 합니다.`;
}

export function buildSecretUseMessage(view: SecretUseView): { text: string; blocks: any[] } {
  const text = secretUseTitle(view);
  const lines = [
    `🔑 *비밀 사용 요청* (어드민 승인 필요)`,
    `<@${view.requesterId}>님의 모델이 비밀 ${secretNamesText(view.names)}을(를) 쓰려 합니다.`,
    `도구 \`${view.tool}\` · 서버 \`${view.server || '(없음)'}\` · ${describeRequestPlace(view.channel, view.threadTs)}`,
    ...(view.adminOnlyTool
      ? [
          '⚠️ 원래 어드민 전용 도구입니다. 허락하면 이 비밀을 쓰는 이 도구의 호출이 열립니다(도구 자체의 조건표는 그대로).',
        ]
      : []),
    '값은 모델에게 보이지 않습니다 — 봇의 도구가 대신 씁니다. *수락*은 그 스레드에서 12시간, *앞으로 계속 자동 수락*은 이 유저에게 이 비밀을 항상 엽니다(대시보드 비밀 탭에서 회수).',
  ];
  return {
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
      {
        type: 'actions',
        block_id: `secret_use_${view.requestId}`,
        elements: secretUseChoices().map((choice) => ({
          type: 'button',
          text: { type: 'plain_text', text: choice.label, emoji: true },
          action_id: `${SECRET_USE_ACTION_ID_PREFIX}${choice.kind}`,
          value: JSON.stringify({ kind: choice.kind, requestId: view.requestId }),
          ...(choice.style ? { style: choice.style } : {}),
        })),
      },
    ],
  };
}
