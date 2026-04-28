/**
 * `/z memory` Block Kit topic.
 *
 * Each entry renders as a `section` with an `accessory` 🪄 개선 button. Bulk
 * delete lives in a global modal (`multi_static_select`). The bottom actions
 * row is the only actions block; entries past the 50-block cap collapse into
 * a summary section with a banner.
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../../logger';
import {
  addMemory,
  clearAllMemory,
  clearMemory,
  loadMemory,
  removeMemoryByIndex,
  replaceAllMemory,
  replaceMemoryByIndex,
} from '../../../user-memory-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import type { ZBlock } from '../types';
import { improveAll, improveEntry } from './memory-improve';

const logger = new Logger('MemoryTopic');

type MemoryModalKind = 'add' | 'clear_manage';

/* ------------------------------------------------------------------ *
 * Confirm dialog (used by the global [🗑️ 전체 삭제] button)
 * ------------------------------------------------------------------ */

const CONFIRM_CLEAR_ALL = {
  title: { type: 'plain_text', text: '전체 삭제 확인' },
  text: { type: 'plain_text', text: 'memory + user profile 모두 비웁니다. 되돌릴 수 없습니다.' },
  confirm: { type: 'plain_text', text: '전체 삭제' },
  deny: { type: 'plain_text', text: '취소' },
};

/* ------------------------------------------------------------------ *
 * Mrkdwn escape + chunk + section cap utilities
 * ------------------------------------------------------------------ */

/**
 * Neutralize mrkdwn + mention tokens inside user content. Order matters:
 * `&` first so later `&lt;`/`&gt;` substitutions are not re-escaped.
 *
 * Per Scenario 5:
 *   - `&` → `&amp;`
 *   - `<` → `&lt;`  (kills mentions `<@Uxxxx>` and `<!here>`)
 *   - `>` → `&gt;`
 *   - `*` → `\u2217`  (asterisk operator — preserves readability)
 *   - `_` → `\u2f96`  (kangxi radical — preserves readability)
 *   - `` ` `` → `\u02cb`  (modifier letter grave)
 *   - `~` → `\u223c`  (tilde operator)
 */
export function escapeMrkdwn(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '\u2217')
    .replace(/_/g, '\u2f96')
    .replace(/`/g, '\u02cb')
    .replace(/~/g, '\u223c');
}

/** Split `text` into chunks each `≤ maxChars` long. */
export function chunkByChars(text: string, maxChars: number): string[] {
  if (maxChars <= 0) return [text];
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/** 3000-char Slack section cap with a markdown-friendly tail. */
function enforceSectionCharCap(blocks: ZBlock[]): ZBlock[] {
  for (const b of blocks) {
    if ((b as { type?: string }).type !== 'section') continue;
    const text = (b as { text?: { text?: string } }).text;
    if (!text || typeof text.text !== 'string') continue;
    if (text.text.length > 3000) {
      text.text = `${text.text.substring(0, 2960)}\n_…(전체 보기는 \`/z memory save\`)_`;
    }
  }
  return blocks;
}

/**
 * Stage-1: truncate per-entry section text to ~400 chars.
 * Stage-2: replace the entire user-profile group with a single truncated section.
 * Stage-3: truncate memory sections further + shrink user-collapsed if still over.
 *
 * Per-entry sections are identified by their Slack-side block_id prefix
 * (`z_memory_entry_*`) that we set at render time.
 */
function bytePayloadGuard(blocks: ZBlock[]): ZBlock[] {
  const byteLen = (arr: ZBlock[]) => Buffer.byteLength(JSON.stringify(arr), 'utf8');
  if (byteLen(blocks) <= 12000) return blocks;

  const truncatePerEntry = (maxChars: number) => {
    for (const b of blocks) {
      if ((b as { type?: string }).type !== 'section') continue;
      const blockId = (b as { block_id?: string }).block_id;
      if (!blockId?.startsWith('z_memory_entry_')) continue;
      const text = (b as { text?: { text?: string } }).text;
      if (typeof text?.text !== 'string') continue;
      if (text.text.length > maxChars) {
        text.text = `${text.text.substring(0, maxChars)}\n_…(잘림)_`;
      }
    }
  };
  const truncateCollapsed = (maxChars: number) => {
    for (const b of blocks) {
      if ((b as { type?: string }).type !== 'section') continue;
      const blockId = (b as { block_id?: string }).block_id;
      if (!blockId) continue;
      // z_memory_memory_collapsed_* + z_memory_user_collapsed + z_memory_user_collapsed_*
      if (!/_collapsed(_\d+)?$/.test(blockId)) continue;
      const text = (b as { text?: { text?: string } }).text;
      if (typeof text?.text !== 'string') continue;
      if (text.text.length > maxChars) {
        text.text = `${text.text.substring(0, maxChars)}\n_…(요약됨)_`;
      }
    }
  };

  // Stage 1: truncate per-entry sections to 400 chars
  truncatePerEntry(400);
  if (byteLen(blocks) <= 12000) return blocks;

  // Stage 2: collapse the entire user-profile group into a single section.
  // Group covers user-header section + all z_memory_entry_user_* and their
  // trailing actions, until the next group divider/actions block.
  const userStart = blocks.findIndex(
    (b) =>
      (b as { type?: string }).type === 'section' && (b as { block_id?: string }).block_id === 'z_memory_group_user',
  );
  if (userStart === -1) {
    // Stage 3 even without user group: shrink everything harder.
    truncatePerEntry(150);
    truncateCollapsed(800);
    return blocks;
  }

  // Find end of user-entry run: stop when we hit the bottom global actions
  // row (`z_memory_global_bottom`).
  const userEnd = blocks.findIndex(
    (b, i) =>
      i > userStart &&
      (b as { type?: string }).type === 'actions' &&
      (b as { block_id?: string }).block_id === 'z_memory_global_bottom',
  );
  if (userEnd === -1) {
    truncatePerEntry(150);
    truncateCollapsed(800);
    return blocks;
  }

  // Collapse all user entries' texts into a single truncated section.
  const userBlocks = blocks.slice(userStart + 1, userEnd);
  const parts: string[] = [];
  for (const b of userBlocks) {
    if ((b as { type?: string }).type !== 'section') continue;
    const txt = (b as { text?: { text?: string } }).text?.text;
    if (typeof txt === 'string') parts.push(txt);
  }
  const combined = parts.join('\n\n');
  const truncated = combined.length > 2800 ? `${combined.substring(0, 2800)}\n_…(user profile 요약 표시됨)_` : combined;
  const collapsedSection: ZBlock = {
    type: 'section',
    block_id: 'z_memory_user_collapsed',
    text: { type: 'mrkdwn', text: truncated || '_(empty)_' },
  };
  blocks.splice(userStart + 1, userEnd - userStart - 1, collapsedSection);
  if (byteLen(blocks) <= 12000) return blocks;

  // Stage 3: shrink memory-side sections further and the user-collapsed
  // placeholder to stay under the 12000-byte cap even with many long
  // memory entries.
  truncatePerEntry(150);
  truncateCollapsed(800);
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Block builders (per-entry + global)
 * ------------------------------------------------------------------ */

function headerBlock(): ZBlock {
  return { type: 'header', text: { type: 'plain_text', text: '🧠 Memory' } };
}

function summaryContextBlock(
  memCount: number,
  memPct: number,
  usrCount: number,
  usrPct: number,
  memLimit: number,
  usrLimit: number,
): ZBlock {
  return {
    type: 'context',
    block_id: 'z_memory_summary',
    elements: [
      {
        type: 'mrkdwn',
        text: `📝 Memory ${memCount}/${memLimit} (${memPct}%) · 👤 User ${usrCount}/${usrLimit} (${usrPct}%)`,
      },
    ],
  };
}

function bottomActionsRow(): ZBlock {
  return {
    type: 'actions',
    block_id: 'z_memory_global_bottom',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🪄 전체 메모리 개선' },
        style: 'primary',
        action_id: 'z_setting_memory_set_improve_memory_all',
        value: 'improve_memory_all',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🪄 전체 프로필 개선' },
        style: 'primary',
        action_id: 'z_setting_memory_set_improve_user_all',
        value: 'improve_user_all',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🗑️ 삭제 관리' },
        action_id: 'z_setting_memory_open_modal_clear_manage',
        value: 'open_modal_clear_manage',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🗑️ 전체 삭제' },
        style: 'danger',
        confirm: CONFIRM_CLEAR_ALL,
        action_id: 'z_setting_memory_set_clear_all',
        value: 'clear_all',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '➕ 사용자 정보 추가' },
        action_id: 'z_setting_memory_open_modal',
        value: 'open_modal',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ 닫기' },
        action_id: 'z_setting_memory_cancel',
        value: 'cancel',
      },
    ],
  };
}

function groupHeaderSection(kind: 'memory' | 'user', count: number): ZBlock {
  const label = kind === 'memory' ? '📝 Memory entries' : '👤 User profile entries';
  return {
    type: 'section',
    block_id: `z_memory_group_${kind}`,
    text: { type: 'mrkdwn', text: `*${label} (${count})*` },
  };
}

function perEntrySection(target: 'memory' | 'user', index1: number, text: string): ZBlock {
  return {
    type: 'section',
    block_id: `z_memory_entry_${target}_${index1}`,
    text: {
      type: 'mrkdwn',
      text: `*#${index1}* · ${escapeMrkdwn(text)}`,
    },
    accessory: {
      type: 'button',
      text: { type: 'plain_text', text: '🪄 개선' },
      action_id: `z_setting_memory_set_improve_${target}_${index1}`,
      value: `improve_${target}_${index1}`,
    },
  };
}

function helpContextBlock(): ZBlock {
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '`/z memory` · `/z memory save user|memory <text>` · `/z memory clear [N]`',
      },
    ],
  };
}

function dividerBlock(): ZBlock {
  return { type: 'divider' };
}

function collapseBannerContext(dropped: number): ZBlock {
  return {
    type: 'context',
    block_id: 'z_memory_collapse_banner',
    elements: [
      {
        type: 'mrkdwn',
        text: `⚠️ ${dropped}개 항목은 요약 표시됨 — 개별 개선/삭제 불가. 전체 보기는 \`/z memory save\`.`,
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Block-budget fallback (Scenario 2)
 * ------------------------------------------------------------------ */

function truncateForCollapse(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.substring(0, maxChars)}…`;
}

function collapseSectionsFor(kind: 'memory' | 'user', collapsed: string[], startIndex1: number): ZBlock[] {
  if (collapsed.length === 0) return [];
  const lines = collapsed.map((t, i) => `*#${startIndex1 + i}*: ${escapeMrkdwn(truncateForCollapse(t, 200))}`);
  const joined = lines.join('\n\n');
  const chunks = chunkByChars(joined, 2900);
  return chunks.map((c, i) => ({
    type: 'section',
    block_id: `z_memory_${kind}_collapsed_${i + 1}`,
    text: { type: 'mrkdwn', text: c },
  }));
}

/**
 * Plan how many old entries each store should collapse (move to a summary
 * section) to stay under the Block Kit 50-block cap.
 *
 * Fixed blocks (v4 minimal): header(1) + summary(1) + group_memory(1) +
 * divider(1) + group_user(1) + bottom_actions(1) + help(1) = 7.
 * Per-entry blocks: 1 each (section with accessory). Plus optional
 * collapse banner(1) + up to 2 collapsed sections per store (4).
 *
 * Budget: 7 fixed + (N+M kept) + 1 banner + 4 collapsed ≤ 50 → N+M ≤ 38.
 * Safety margin: use 42 as post-collapse target when total > 42; collapse
 * is only triggered above 42. Rules preserved:
 *   - Start pulling from the LARGER store first.
 *   - Keep at least 3 per-entry rows per store when possible; spill if
 *     the larger store hits the floor first.
 */
function planCollapse(memCount: number, usrCount: number): { memCollapseN: number; usrCollapseN: number } {
  const total = memCount + usrCount;
  if (total <= 42) return { memCollapseN: 0, usrCollapseN: 0 };
  const keptTarget = 42;
  const overflow = total - keptTarget;
  const minPerStore = 3;
  const larger: 'memory' | 'user' = memCount >= usrCount ? 'memory' : 'user';
  const largerCount = larger === 'memory' ? memCount : usrCount;
  const smallerCount = larger === 'memory' ? usrCount : memCount;
  const largerAbsorb = Math.min(overflow, Math.max(0, largerCount - minPerStore));
  const spill = overflow - largerAbsorb;
  const smallerAbsorb = Math.min(spill, Math.max(0, smallerCount - minPerStore));
  if (larger === 'memory') {
    return { memCollapseN: largerAbsorb, usrCollapseN: smallerAbsorb };
  }
  return { memCollapseN: smallerAbsorb, usrCollapseN: largerAbsorb };
}

function buildBlocksWithCollapse(
  memEntries: string[],
  usrEntries: string[],
  memLimit: number,
  usrLimit: number,
  memPct: number,
  usrPct: number,
  plan?: { memCollapseN: number; usrCollapseN: number },
): ZBlock[] {
  const memCount = memEntries.length;
  const usrCount = usrEntries.length;
  const { memCollapseN, usrCollapseN } = plan ?? planCollapse(memCount, usrCount);

  const memCollapsed = memEntries.slice(0, memCollapseN);
  const memKept = memEntries.slice(memCollapseN);
  const usrCollapsed = usrEntries.slice(0, usrCollapseN);
  const usrKept = usrEntries.slice(usrCollapseN);
  const totalCollapsed = memCollapsed.length + usrCollapsed.length;

  const blocks: ZBlock[] = [];
  blocks.push(headerBlock());
  blocks.push(summaryContextBlock(memCount, memPct, usrCount, usrPct, memLimit, usrLimit));
  if (totalCollapsed > 0) blocks.push(collapseBannerContext(totalCollapsed));
  blocks.push(groupHeaderSection('memory', memCount));

  // Collapsed memory section(s) first (oldest are at the top of the group)
  blocks.push(...collapseSectionsFor('memory', memCollapsed, 1));
  // Kept memory entries: numbering continues from collapsed.length + 1
  for (let i = 0; i < memKept.length; i++) {
    const idx = memCollapsed.length + i + 1;
    blocks.push(perEntrySection('memory', idx, memKept[i]));
  }

  blocks.push(dividerBlock());
  blocks.push(groupHeaderSection('user', usrCount));
  blocks.push(...collapseSectionsFor('user', usrCollapsed, 1));
  for (let i = 0; i < usrKept.length; i++) {
    const idx = usrCollapsed.length + i + 1;
    blocks.push(perEntrySection('user', idx, usrKept[i]));
  }

  blocks.push(bottomActionsRow());
  blocks.push(helpContextBlock());
  return blocks;
}

/* ------------------------------------------------------------------ *
 * renderMemoryCard (Scenario 1 + 2 + 3 + 4 + 5)
 * ------------------------------------------------------------------ */

export async function renderMemoryCard(args: { userId: string; issuedAt: number }): Promise<RenderResult> {
  const { userId } = args;
  const mem = loadMemory(userId, 'memory');
  const usr = loadMemory(userId, 'user');

  let blocks = buildBlocksWithCollapse(
    mem.entries,
    usr.entries,
    mem.charLimit,
    usr.charLimit,
    mem.percentUsed,
    usr.percentUsed,
  );

  // Safety: if still > 50 blocks (e.g. many very short entries on both
  // stores), fold ALL user entries into collapsed summary sections and trim
  // oldest memory entries until we fit under the cap. Memory is the primary
  // store so we prefer to preserve its per-entry view. Reuses the same
  // builder with an overridden plan (user fully collapsed, memory keeps ≤38
  // per-entry rows — fixed 7 + banner 1 + collapsed ≤2 + kept 38 = 48).
  if (blocks.length > 50) {
    const memCount = mem.entries.length;
    const usrCount = usr.entries.length;
    const memCollapseN = Math.max(0, memCount - 38);
    blocks = buildBlocksWithCollapse(
      mem.entries,
      usr.entries,
      mem.charLimit,
      usr.charLimit,
      mem.percentUsed,
      usr.percentUsed,
      { memCollapseN, usrCollapseN: usrCount },
    );
  }

  blocks = enforceSectionCharCap(blocks);
  blocks = bytePayloadGuard(blocks);

  // Final hard-cap: if still somehow > 50, trim per-entry rows from the
  // tail. Block Kit rejects >50. (Shouldn't hit in practice after the
  // collapse pass above but belt-and-suspenders per Scenario 2 contract.)
  if (blocks.length > 50) {
    blocks = blocks.slice(0, 50);
  }

  return {
    text: `🧠 Memory (${mem.entries.length + usr.entries.length} entries)`,
    blocks,
  };
}

/* ------------------------------------------------------------------ *
 * renderPendingCard — 2-stage rerender placeholder (Scenario 15)
 * ------------------------------------------------------------------ */

async function renderPendingCard(args: {
  userId: string;
  target: 'memory' | 'user';
  idx: number | 'all';
  issuedAt: number;
}): Promise<RenderResult> {
  const { userId, target, idx } = args;
  const card = await renderMemoryCard({ userId, issuedAt: args.issuedAt });
  const blocks = card.blocks as ZBlock[];

  if (idx === 'all') {
    // Insert pending banner after the summary context block.
    const label = target === 'memory' ? '전체 메모리 개선 중…' : '전체 프로필 개선 중…';
    const pendingBanner: ZBlock = {
      type: 'context',
      block_id: 'z_memory_pending_banner',
      elements: [{ type: 'mrkdwn', text: `🔄 ${label}` }],
    };
    const summaryIdx = blocks.findIndex((b) => (b as { block_id?: string }).block_id === 'z_memory_summary');
    if (summaryIdx !== -1) {
      blocks.splice(summaryIdx + 1, 0, pendingBanner);
    } else {
      blocks.unshift(pendingBanner);
    }
  } else {
    // Replace the target entry's section with "🔄 #N 개선 중…" text.
    const sectionIdx = blocks.findIndex(
      (b) =>
        (b as { type?: string }).type === 'section' &&
        (b as { block_id?: string }).block_id === `z_memory_entry_${target}_${idx}`,
    );
    if (sectionIdx !== -1) {
      blocks[sectionIdx] = {
        type: 'section',
        block_id: `z_memory_entry_${target}_${idx}`,
        text: { type: 'mrkdwn', text: `🔄 #${idx} 개선 중…` },
      };
    }
  }
  return { text: card.text, blocks };
}

/* ------------------------------------------------------------------ *
 * applyMemory — clear + improve branches (Scenarios 6-9, regression 17)
 * ------------------------------------------------------------------ */

export async function applyMemory(args: {
  userId: string;
  value: string;
  respond?: (blocks: ZBlock[]) => Promise<void>;
}): Promise<ApplyResult> {
  const { userId, value, respond } = args;
  const v = value.toLowerCase();

  // improve_<target>_<N> — MUST be matched before clear_* so 'improve_memory_3'
  // is not accidentally swallowed by a looser regex.
  const improveOneMatch = v.match(/^improve_(memory|user)_(\d+)$/);
  if (improveOneMatch) {
    const target = improveOneMatch[1] as 'memory' | 'user';
    const idx = Number.parseInt(improveOneMatch[2], 10);
    const cur = loadMemory(userId, target);
    if (idx < 1 || idx > cur.entries.length) {
      return {
        ok: false,
        summary: `❌ ${target} #${idx} entry 없음`,
        rerender: 'topic',
      };
    }
    // Capture the original text at click-time. This is our CAS witness: if
    // the entry at idx changes during the LLM call (e.g. concurrent delete
    // shifts the list), replaceMemoryByIndex below will reject the write
    // instead of overwriting a different entry.
    const originalText = cur.entries[idx - 1];
    // Stage 1 of 2-stage rerender: push pending card immediately.
    try {
      const pending = await renderPendingCard({ userId, target, idx, issuedAt: Date.now() });
      await respond?.(pending.blocks);
    } catch (err) {
      logger.warn('pending card render failed', { err: (err as Error).message });
    }
    // Stage 2: LLM call → persist → rerender.
    let improved: string;
    try {
      improved = await improveEntry(originalText, target);
    } catch (err) {
      return {
        ok: false,
        summary: `❌ 개선 실패: ${(err as Error).message}`,
        rerender: 'topic',
      };
    }
    const r = replaceMemoryByIndex(userId, target, idx, improved, originalText);
    if (!r.ok) {
      const msg =
        r.reason === 'cas mismatch'
          ? `⚠️ ${target} #${idx} 개선 중 다른 수정이 발생해 취소됨 (원본 보존됨)`
          : `❌ 저장 실패: ${r.reason}`;
      return {
        ok: false,
        summary: msg,
        rerender: 'topic',
      };
    }
    return {
      ok: true,
      summary: `✅ ${target} #${idx} 개선 완료`,
      rerender: 'topic',
    };
  }

  const improveAllMatch = v.match(/^improve_(memory|user)_all$/);
  if (improveAllMatch) {
    const target = improveAllMatch[1] as 'memory' | 'user';
    const cur = loadMemory(userId, target);
    if (cur.entries.length === 0) {
      return {
        ok: true,
        summary: `ℹ️ ${target} entries 없음`,
        rerender: 'topic',
      };
    }
    // Snapshot entries for CAS. If any entry mutates during the LLM call,
    // replaceAllMemory rejects with 'cas mismatch' and we keep the updated
    // store intact instead of overwriting intervening edits.
    const originalEntries = [...cur.entries];
    try {
      const pending = await renderPendingCard({ userId, target, idx: 'all', issuedAt: Date.now() });
      await respond?.(pending.blocks);
    } catch (err) {
      logger.warn('pending card render failed', { err: (err as Error).message });
    }
    let improved: string[];
    try {
      improved = await improveAll(originalEntries, target);
    } catch (err) {
      return {
        ok: false,
        summary: `❌ 개선 실패: ${(err as Error).message}`,
        rerender: 'topic',
      };
    }
    const r = replaceAllMemory(userId, target, improved, originalEntries);
    if (!r.ok) {
      const msg =
        r.reason === 'cas mismatch'
          ? `⚠️ ${target} 전체 개선 중 다른 수정이 발생해 취소됨 (기존 entries 보존됨)`
          : `❌ 저장 실패: ${r.reason}`;
      return {
        ok: false,
        summary: msg,
        rerender: 'topic',
      };
    }
    return {
      ok: true,
      summary: `✅ ${target} ${originalEntries.length} → ${improved.length} 재구성`,
      rerender: 'topic',
    };
  }

  // ---- Existing clear branches (regression — NO rerender flag) ----
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

/* ------------------------------------------------------------------ *
 * Modal builders + binding factory (preserved from phase-2)
 * ------------------------------------------------------------------ */

/** Build the "add user profile entry" modal payload. */
export function buildMemoryAddModal(): Record<string, any> {
  return {
    type: 'modal',
    callback_id: 'z_setting_memory_modal_submit',
    private_metadata: JSON.stringify({ kind: 'add' }),
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

/**
 * Build the bulk "clear management" modal. Uses `multi_static_select` (max
 * 100 options) so users can tick multiple entries across both stores and
 * confirm once on submit. Option value format: `"memory:N"` / `"user:N"`
 * (1-indexed, matches the card's displayed numbering).
 *
 * When both stores are empty we still build a view (no input block, no
 * submit button) so the click doesn't silently fail.
 */
export function buildClearManageModal(args: { memEntries: string[]; usrEntries: string[] }): Record<string, any> {
  const { memEntries, usrEntries } = args;
  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const options: Array<{ text: any; value: string }> = [];
  memEntries.forEach((t, i) => {
    if (options.length >= 100) return;
    options.push({
      text: { type: 'plain_text', text: `📝 M#${i + 1}: ${truncate(t, 60)}` },
      value: `memory:${i + 1}`,
    });
  });
  usrEntries.forEach((t, i) => {
    if (options.length >= 100) return;
    options.push({
      text: { type: 'plain_text', text: `👤 U#${i + 1}: ${truncate(t, 60)}` },
      value: `user:${i + 1}`,
    });
  });

  const hasAny = options.length > 0;
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: hasAny
          ? '*삭제할 항목을 선택하세요.* 저장 시 영구 삭제되며 되돌릴 수 없습니다.'
          : '_비어있음 — 삭제할 항목이 없습니다._',
      },
    },
  ];
  if (hasAny) {
    blocks.push({
      type: 'input',
      block_id: 'memory_clear_targets',
      label: { type: 'plain_text', text: '삭제 항목 (여러 개 선택 가능)' },
      element: {
        type: 'multi_static_select',
        action_id: 'value',
        placeholder: { type: 'plain_text', text: '삭제할 항목 선택…' },
        options,
      },
    });
  }

  const view: Record<string, any> = {
    type: 'modal',
    callback_id: 'z_setting_memory_modal_submit',
    private_metadata: JSON.stringify({ kind: 'clear_manage' }),
    title: { type: 'plain_text', text: '삭제 관리' },
    close: { type: 'plain_text', text: '취소' },
    blocks,
  };
  if (hasAny) view.submit = { type: 'plain_text', text: '삭제' };
  return view;
}

/**
 * Open the memory modal. `kind` selects which modal to build:
 *   - `'add'` (default): the existing add-user-profile modal.
 *   - `'clear_manage'`: bulk-delete modal; requires `userId` to load entries.
 */
async function openMemoryModal(args: {
  client: WebClient;
  triggerId: string;
  kind?: MemoryModalKind;
  userId?: string;
}): Promise<void> {
  const { client, triggerId, kind = 'add', userId } = args;
  if (!triggerId) {
    logger.warn('openMemoryModal: missing trigger_id');
    return;
  }
  let view: Record<string, any>;
  if (kind === 'clear_manage') {
    if (!userId) {
      logger.warn('openMemoryModal clear_manage: missing userId');
      return;
    }
    const mem = loadMemory(userId, 'memory');
    const usr = loadMemory(userId, 'user');
    view = buildClearManageModal({ memEntries: mem.entries, usrEntries: usr.entries });
  } else {
    view = buildMemoryAddModal();
  }
  await client.views.open({ trigger_id: triggerId, view: view as any });
}

/**
 * Submit the memory modal. `kind` is derived from `view.private_metadata`.
 *   - `'add'`: validate + addMemory + DM confirmation (legacy behaviour).
 *   - `'clear_manage'`: parse selected options, delete in index-descending
 *     order per target (prevents index shifts), DM summary of results.
 */
export async function submitMemoryModal(args: {
  client: WebClient;
  userId: string;
  values: Record<string, Record<string, any>>;
  kind?: MemoryModalKind;
}): Promise<ApplyResult> {
  const { client, userId, values, kind = 'add' } = args;

  if (kind === 'clear_manage') {
    const selected =
      (values?.memory_clear_targets?.value?.selected_options as Array<{ value?: string }> | undefined) ?? [];
    if (selected.length === 0) {
      return { ok: false, summary: '❌ 선택된 항목이 없습니다.' };
    }
    const perTarget: Record<'memory' | 'user', number[]> = { memory: [], user: [] };
    for (const opt of selected) {
      const v = opt?.value;
      if (typeof v !== 'string') continue;
      const m = v.match(/^(memory|user):(\d+)$/);
      if (!m) continue;
      perTarget[m[1] as 'memory' | 'user'].push(Number.parseInt(m[2], 10));
    }
    // Batch per target: 1 read + 1 write (vs N reads + N writes of
    // removeMemoryByIndex). Indices are 1-based and match the modal's
    // displayed numbering at the time the modal opened; concurrent edits
    // are surfaced as "이미 삭제됨" in the error tail.
    const okCounts: Record<'memory' | 'user', number> = { memory: 0, user: 0 };
    const errors: string[] = [];
    for (const target of ['memory', 'user'] as const) {
      const selectedIdxs = perTarget[target];
      if (selectedIdxs.length === 0) continue;
      const cur = loadMemory(userId, target);
      const selectedSet = new Set(selectedIdxs);
      const remaining = cur.entries.filter((_, i) => !selectedSet.has(i + 1));
      const removed = cur.entries.length - remaining.length;
      if (removed === 0) {
        errors.push(`${target}: 선택된 항목이 이미 삭제됨 (${selectedIdxs.length}건)`);
        continue;
      }
      const r = remaining.length === 0 ? clearMemory(userId, target) : replaceAllMemory(userId, target, remaining);
      if (r.ok) {
        okCounts[target] = removed;
        if (removed < selectedIdxs.length) {
          errors.push(`${target}: ${selectedIdxs.length - removed}건 이미 삭제됨`);
        }
      } else {
        const reason = 'reason' in r ? r.reason : (r as { message?: string }).message;
        errors.push(`${target}: ${reason ?? 'unknown error'}`);
      }
    }
    const totalOk = okCounts.memory + okCounts.user;
    try {
      const parts: string[] = [];
      if (okCounts.memory > 0) parts.push(`memory ${okCounts.memory}개`);
      if (okCounts.user > 0) parts.push(`user profile ${okCounts.user}개`);
      const head = totalOk > 0 ? `🗑️ ${parts.join(' + ')} 삭제 완료` : '⚠️ 삭제된 항목 없음';
      const errTail = errors.length > 0 ? `\n\n⚠️ ${errors.length}건 실패:\n- ${errors.slice(0, 5).join('\n- ')}` : '';
      await client.chat.postMessage({
        channel: userId,
        text: `${head}${errTail}`,
      });
    } catch (err) {
      logger.warn('memory clear_manage ack DM failed', { err: (err as Error).message });
    }
    if (totalOk === 0 && errors.length > 0) {
      return { ok: false, summary: `❌ 삭제 실패 (${errors.length}건)` };
    }
    return { ok: true, summary: `🗑️ ${totalOk}개 항목 삭제 완료` };
  }

  // kind === 'add' (default)
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

/**
 * Parse the `kind` discriminator from an `open_modal` action_id. Missing
 * suffix means legacy `open_modal` (add). Unknown suffixes fall back to
 * 'add' to preserve backward compat with future routing.
 */
function kindFromActionId(actionId: string | undefined): MemoryModalKind {
  const m = actionId?.match(/^z_setting_memory_open_modal(?:_(.+))?$/);
  return m?.[1] === 'clear_manage' ? 'clear_manage' : 'add';
}

/**
 * Parse the `kind` discriminator from a view's private_metadata. Missing
 * metadata (legacy modal) defaults to 'add'. Malformed JSON or unknown
 * `kind` returns `null` so the caller can reject rather than silently run
 * the add path.
 */
function kindFromPrivateMetadata(pm: string | undefined): MemoryModalKind | null {
  if (!pm) return 'add';
  try {
    const kind = JSON.parse(pm)?.kind;
    if (kind === 'clear_manage' || kind === 'add') return kind;
    return null;
  } catch {
    return null;
  }
}

export function createMemoryTopicBinding(): ZTopicBinding {
  return {
    topic: 'memory',
    apply: (args) => applyMemory({ userId: args.userId, value: args.value, respond: args.respond }),
    renderCard: (args) => renderMemoryCard({ userId: args.userId, issuedAt: args.issuedAt }),
    openModal: (args) => {
      const actionId: string | undefined = args.body?.actions?.[0]?.action_id;
      const kind = kindFromActionId(actionId);
      return openMemoryModal({ client: args.client, triggerId: args.triggerId, kind, userId: args.userId });
    },
    submitModal: async (args) => {
      // ack() already fired in the framework wrapper — surface validation
      // failures as a DM so users get visible feedback instead of a silently
      // closed modal.
      const kind = kindFromPrivateMetadata(args.body?.view?.private_metadata);
      const result =
        kind === null
          ? ({ ok: false, summary: '❌ Malformed modal metadata.' } as ApplyResult)
          : await submitMemoryModal({
              client: args.client,
              userId: args.userId,
              values: args.values,
              kind,
            });
      if (!result.ok) {
        try {
          const desc = result.description ? `\n${result.description}` : '';
          await args.client.chat.postMessage({
            channel: args.userId,
            text: `${result.summary}${desc}`,
          });
        } catch (err) {
          logger.warn('memory modal failure DM failed', { err: (err as Error).message });
        }
      }
    },
  };
}
