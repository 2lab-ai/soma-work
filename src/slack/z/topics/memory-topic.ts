/**
 * `/z memory` Block Kit topic — Phase 2 (#507).
 *
 * - Shows current memory + user profile sizes in the current-label.
 * - `clear_all` button wipes both stores.
 * - `clear_memory_N` / `clear_user_N` buttons remove individual entries.
 * - `open_modal` extra action pushes a views.open for adding a new user
 *   profile entry. Modal submit calls `addMemory(userId, 'user', content)`.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../../logger';
import { addMemory, clearAllMemory, loadMemory, removeMemoryByIndex } from '../../../user-memory-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import { buildSettingCard } from '../ui-builder';

const logger = new Logger('MemoryTopic');

export async function renderMemoryCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId, issuedAt } = args;
  const mem = loadMemory(userId, 'memory');
  const usr = loadMemory(userId, 'user');

  const desc = [
    `• 📝 Memory: ${mem.entries.length}개 (${mem.percentUsed}% • ${mem.totalChars}/${mem.charLimit})`,
    `• 👤 User Profile: ${usr.entries.length}개 (${usr.percentUsed}% • ${usr.totalChars}/${usr.charLimit})`,
  ].join('\n');

  const options: Array<{ id: string; label: string; description?: string; style?: 'danger' | 'primary' }> = [
    {
      id: 'clear_all',
      label: '🗑️ 전체 삭제',
      description: 'memory + user profile 모두 비웁니다. 되돌릴 수 없습니다.',
      style: 'danger',
    },
  ];

  // Up to 5 recent entries per store get a per-entry clear button.
  const maxPerStore = 5;
  for (let i = 0; i < Math.min(mem.entries.length, maxPerStore); i++) {
    const preview = mem.entries[i].slice(0, 24).replace(/\s+/g, ' ');
    options.push({
      id: `clear_memory_${i + 1}`,
      label: `📝 #${i + 1}: ${preview}${mem.entries[i].length > 24 ? '…' : ''}`,
      description: `memory 항목 #${i + 1}을 삭제합니다.`,
      style: 'danger',
    });
  }
  for (let i = 0; i < Math.min(usr.entries.length, maxPerStore); i++) {
    const preview = usr.entries[i].slice(0, 24).replace(/\s+/g, ' ');
    options.push({
      id: `clear_user_${i + 1}`,
      label: `👤 #${i + 1}: ${preview}${usr.entries[i].length > 24 ? '…' : ''}`,
      description: `user profile 항목 #${i + 1}을 삭제합니다.`,
      style: 'danger',
    });
  }

  const blocks = buildSettingCard({
    topic: 'memory',
    icon: '🧠',
    title: 'Memory',
    currentLabel: `${mem.entries.length + usr.entries.length} entries`,
    currentDescription: desc,
    options,
    extraActions: [
      {
        actionId: 'z_setting_memory_open_modal',
        label: '➕ 사용자 정보 추가',
        style: 'primary',
      },
    ],
    additionalCommands: [
      '`/z memory` — 요약 표시',
      '`/z memory save user|memory <text>` — 항목 추가',
      '`/z memory clear [N]` — N번 항목 또는 전체 삭제',
    ],
    issuedAt,
  });
  return { text: `🧠 Memory (${mem.entries.length + usr.entries.length} entries)`, blocks };
}

export async function applyMemory(args: { userId: string; value: string }): Promise<ApplyResult> {
  const { userId, value } = args;
  const v = value.toLowerCase();
  if (v === 'clear_all') {
    clearAllMemory(userId);
    return { ok: true, summary: '🗑️ 모든 메모리와 사용자 프로필을 삭제했습니다.' };
  }
  const memMatch = v.match(/^clear_memory_(\d+)$/);
  if (memMatch) {
    const idx = Number.parseInt(memMatch[1], 10);
    const r = removeMemoryByIndex(userId, 'memory', idx);
    return r.ok ? { ok: true, summary: `✅ memory #${idx} 삭제 완료` } : { ok: false, summary: `❌ ${r.message}` };
  }
  const usrMatch = v.match(/^clear_user_(\d+)$/);
  if (usrMatch) {
    const idx = Number.parseInt(usrMatch[1], 10);
    const r = removeMemoryByIndex(userId, 'user', idx);
    return r.ok
      ? { ok: true, summary: `✅ user profile #${idx} 삭제 완료` }
      : { ok: false, summary: `❌ ${r.message}` };
  }
  return { ok: false, summary: `❌ Unknown memory value: \`${value}\`` };
}

/** Build the "add user profile entry" modal payload. */
export function buildMemoryAddModal(): Record<string, any> {
  return {
    type: 'modal',
    callback_id: 'z_setting_memory_modal_submit',
    title: { type: 'plain_text', text: 'Add User Profile' },
    submit: { type: 'plain_text', text: '저장' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'input',
        block_id: 'memory_target',
        label: { type: 'plain_text', text: '저장 위치' },
        element: {
          type: 'static_select',
          action_id: 'value',
          initial_option: {
            text: { type: 'plain_text', text: '👤 User profile (페르소나)' },
            value: 'user',
          },
          options: [
            { text: { type: 'plain_text', text: '👤 User profile (페르소나)' }, value: 'user' },
            { text: { type: 'plain_text', text: '📝 Memory (세션 간 기억)' }, value: 'memory' },
          ],
        },
      },
      {
        type: 'input',
        block_id: 'memory_content',
        label: { type: 'plain_text', text: '내용' },
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          multiline: true,
          placeholder: { type: 'plain_text', text: '예: 저는 TypeScript와 Rust를 좋아합니다.' },
          max_length: 2000,
        },
      },
    ],
  };
}

export async function openMemoryModal(args: { client: WebClient; triggerId: string }): Promise<void> {
  const { client, triggerId } = args;
  if (!triggerId) {
    logger.warn('openMemoryModal: missing trigger_id');
    return;
  }
  await client.views.open({
    trigger_id: triggerId,
    view: buildMemoryAddModal() as any,
  });
}

export async function submitMemoryModal(args: {
  client: WebClient;
  userId: string;
  values: Record<string, Record<string, any>>;
}): Promise<ApplyResult> {
  const { client, userId, values } = args;
  const target = (values?.memory_target?.value?.selected_option?.value as string | undefined) ?? 'user';
  const content = (values?.memory_content?.value?.value as string | undefined)?.trim() ?? '';
  if (!content) {
    return { ok: false, summary: '❌ 내용이 비어있습니다.' };
  }
  if (target !== 'user' && target !== 'memory') {
    return { ok: false, summary: `❌ Unknown target: ${target}` };
  }
  const r = addMemory(userId, target, content);
  if (!r.ok) {
    return { ok: false, summary: `❌ ${r.message}` };
  }
  try {
    await client.chat.postMessage({
      channel: userId,
      text: `✅ ${target === 'user' ? 'User profile' : 'Memory'} 항목 추가 완료\n\n> ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`,
    });
  } catch (err) {
    logger.warn('memory modal ack DM failed', { err: (err as Error).message });
  }
  return { ok: true, summary: `🧠 ${target === 'user' ? 'User profile' : 'Memory'} 저장 완료` };
}

export function createMemoryTopicBinding(): ZTopicBinding {
  return {
    topic: 'memory',
    apply: (args) => applyMemory({ userId: args.userId, value: args.value }),
    renderCard: (args) => renderMemoryCard({ userId: args.userId, issuedAt: args.issuedAt }),
    openModal: (args) => openMemoryModal({ client: args.client, triggerId: args.triggerId }),
    submitModal: async (args) => {
      await submitMemoryModal({ client: args.client, userId: args.userId, values: args.values });
    },
  };
}
