/**
 * The Slack card for a user action (`instruct_user`): what the human does, where, the script, and the host's check
 * of that script. Posted as its own colored attachment — never folded into the reply text and never a question form —
 * so a task for the human stands apart from the agent's answer and from ASK_USER_QUESTION.
 *
 * Block Kit notes (docs/misc/reference/slack-block-kit.md): no `button.disabled` — a resolved card is rebuilt without
 * the actions block; block ids are left to Slack so a `chat.update` never reuses one.
 */
import type {
  UserActionFinding,
  UserActionInspection,
  UserActionRecord,
  UserActionVerdict,
} from 'somalib/user-action/user-action';
import { escapeSlackMrkdwn as esc } from './mrkdwn-escape';

export const USER_ACTION_DONE_ACTION_ID = 'user_action_done';
export const USER_ACTION_FAILED_ACTION_ID = 'user_action_failed';

const VERDICT: Record<UserActionVerdict, { icon: string; label: string; color: string }> = {
  ok: { icon: '✅', label: '통과', color: '#2EB67D' },
  caution: { icon: '⚠️', label: '주의', color: '#ECB22E' },
  danger: { icon: '⛔', label: '위험', color: '#E01E5A' },
};
const FINDING_ICON: Record<UserActionFinding['level'], string> = { info: 'ℹ️', caution: '⚠️', danger: '⛔' };
const PENDING_COLOR = '#4A90D9';
const RESOLVED = {
  done: { icon: '✅', label: '완료', color: '#2EB67D' },
  failed: { icon: '❌', label: '안 됨', color: '#868686' },
} as const;

/** Text inside a code block: Slack still reads `&<>`, and a stray fence would close the block. */
const codeBlock = (s: string) => `\`\`\`${esc(s).replace(/```/g, "'''")}\`\`\``;

export interface UserActionButtonValue {
  sessionKey: string;
  id: string;
}

export function parseUserActionButtonValue(raw: unknown): UserActionButtonValue | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return typeof v.sessionKey === 'string' && typeof v.id === 'string' && v.id
      ? { sessionKey: v.sessionKey, id: v.id }
      : null;
  } catch {
    return null;
  }
}

/** The inspection as mrkdwn lines: verdict, syntax check, the commands it runs, then every finding. */
export function inspectionLines(inspection: UserActionInspection): string[] {
  const v = VERDICT[inspection.verdict];
  const lines = [`🔎 *점검 결과: ${v.icon} ${v.label}* — 봇이 자기 Bash 명령에 쓰는 검사와 같은 검사`];
  const syntax = inspection.syntax;
  lines.push(
    syntax.checked
      ? `• 구문: \`${esc(syntax.tool ?? 'syntax')}\` ${syntax.ok ? '통과' : `실패 — ${esc(syntax.message ?? '')}`}`
      : `• 구문: 검사 못 함${syntax.message ? ` — ${esc(syntax.message)}` : ''}`,
  );
  if (inspection.commands.length) {
    lines.push(`• 실행하는 명령: ${inspection.commands.map((c) => `\`${esc(c)}\``).join(' ')}`);
  }
  lines.push(`• 길이: ${inspection.lines}줄 · ${inspection.chars}자`);
  for (const f of inspection.findings) {
    if (f.id === 'syntax-unchecked' || f.id === 'syntax-error') continue; // already on the syntax line
    lines.push(`• ${FINDING_ICON[f.level]} ${esc(f.label)}${f.detail ? ` — ${esc(f.detail)}` : ''}`);
  }
  if (!inspection.findings.some((f) => f.level !== 'info')) lines.push('• 위험 규칙·되돌릴 수 없는 동작: 없음');
  return lines;
}

/**
 * The card. `sessionKey` goes into the buttons so the click finds the session without a thread lookup.
 * Returns the fallback text (notifications, screen readers) and one attachment holding the blocks.
 */
export function buildUserActionCard(
  action: UserActionRecord,
  sessionKey: string,
): { text: string; attachments: Array<{ color: string; blocks: any[] }> } {
  const kind = action.optional ? '선택' : '해 주세요';
  const head = `🙋 *사용자 작업 (${kind})* — ${esc(action.title)}`;
  const resolved = action.status === 'pending' ? undefined : RESOLVED[action.status];
  const color = resolved
    ? resolved.color
    : action.inspection.verdict === 'ok'
      ? PENDING_COLOR
      : VERDICT[action.inspection.verdict].color;

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: head } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [`📍 *어디서:* \`${esc(action.host)}\` · ${esc(action.shell)}`, `❓ *왜:* ${esc(action.why)}`].join('\n'),
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `▶️ *실행할 스크립트*\n${codeBlock(action.script)}` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [`📝 *바뀌는 것:* ${esc(action.effects)}`, `🎯 *성공하면:* ${esc(action.expect)}`].join('\n'),
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: inspectionLines(action.inspection).join('\n') } },
  ];

  if (resolved) {
    const who = action.resolvedBy ? ` — <@${esc(action.resolvedBy)}>` : '';
    const when = action.resolvedAt
      ? ` · <!date^${Math.floor(action.resolvedAt / 1000)}^{date_short_pretty} {time}|${new Date(action.resolvedAt).toISOString()}>`
      : '';
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${resolved.icon} *${resolved.label}*${who}${when}` }],
    });
  } else {
    const value = JSON.stringify({ sessionKey, id: action.id } satisfies UserActionButtonValue);
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: USER_ACTION_DONE_ACTION_ID,
          text: { type: 'plain_text', text: '✅ 완료했어요', emoji: true },
          style: 'primary',
          value,
        },
        {
          type: 'button',
          action_id: USER_ACTION_FAILED_ACTION_ID,
          text: { type: 'plain_text', text: '❌ 안 됐어요', emoji: true },
          value,
        },
      ],
    });
  }

  const status = resolved ? ` [${resolved.label}]` : '';
  return {
    // The top-level text is parsed too (a `<!channel>` there would notify): escaped like the blocks.
    text: `🙋 사용자 작업 (${kind})${status}: ${esc(action.title)} — ${esc(action.host)}에서 실행`,
    attachments: [{ color, blocks }],
  };
}

/** The message the agent gets when the human answers the card: self-contained, so a reset session still knows. */
export function userActionResolvedPrompt(action: UserActionRecord): string {
  const head =
    action.status === 'done'
      ? `✅ 사용자 작업 완료: "${action.title}" — 사용자가 ${action.host}에서 실행하고 '완료했어요'를 눌렀습니다.`
      : `❌ 사용자 작업 안 됨: "${action.title}" — 사용자가 ${action.host}에서 '안 됐어요'를 눌렀습니다. 무엇이 안 됐는지 확인하고 다른 길을 찾으세요.`;
  return `${head}\n[user-action ${action.id}] 스크립트:\n\`\`\`\n${action.script}\n\`\`\``;
}
