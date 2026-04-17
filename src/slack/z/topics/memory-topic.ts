/**
 * `/z memory` Block Kit topic — v3 full-view (issue #535).
 *
 * Renders the memory + user profile stores as per-entry section+actions rows
 * so every entry text is readable and each has its own improve/clear buttons.
 * Top and bottom "global" action rows expose bulk improve (memory/user) and
 * clear-all. A block-budget fallback collapses the larger store into a
 * summary section when N+M > 20, and a byte-payload guard truncates when
 * entries are long enough to hit Slack's ~13.2k cap.
 *
 * Exports preserved (public surface — do NOT change signatures):
 *   - buildMemoryAddModal
 *   - openMemoryModal
 *   - submitMemoryModal
 *   - createMemoryTopicBinding
 *
 * Exports rewritten / extended:
 *   - renderMemoryCard         — section+actions per entry (v3)
 *   - applyMemory              — improve_* branches + rerender flag
 *
 * New internal utilities:
 *   - escapeMrkdwn             — neutralize mention + mrkdwn tokens
 *   - chunkByChars             — split long text into <= N char chunks
 *   - enforceSectionCharCap    — 3000 char Slack section cap
 *   - bytePayloadGuard         — 12000 byte Buffer.byteLength cap
 *   - collapseFallback         — collapse old entries when block budget blown
 *   - renderPendingCard        — 2-stage rerender "working…" helper
 */

import type { WebClient } from '@slack/web-api';
import { Logger } from '../../../logger';
import {
  addMemory,
  clearAllMemory,
  loadMemory,
  removeMemoryByIndex,
  replaceAllMemory,
  replaceMemoryByIndex,
} from '../../../user-memory-store';
import type { ApplyResult, RenderResult, ZTopicBinding } from '../../actions/z-settings-actions';
import type { ZBlock } from '../types';
import { improveAll, improveEntry } from './memory-improve';

const logger = new Logger('MemoryTopic');

/* ------------------------------------------------------------------ *
 * Confirm dialogs (shared by per-entry clear + global clear-all)
 * ------------------------------------------------------------------ */

const CONFIRM_CLEAR_ONE = {
  title: { type: 'plain_text', text: '삭제 확인' },
  text: { type: 'plain_text', text: '이 항목을 삭제합니다. 되돌릴 수 없습니다.' },
  confirm: { type: 'plain_text', text: '삭제' },
  deny: { type: 'plain_text', text: '취소' },
};

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
export function enforceSectionCharCap(blocks: ZBlock[]): ZBlock[] {
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
export function bytePayloadGuard(blocks: ZBlock[]): ZBlock[] {
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
    elements: [
      {
        type: 'mrkdwn',
        text: `📝 Memory ${memCount}/${memLimit} (${memPct}%) · 👤 User ${usrCount}/${usrLimit} (${usrPct}%)`,
      },
    ],
  };
}

function globalActionsRow(blockId: 'z_memory_global_top' | 'z_memory_global_bottom'): ZBlock {
  return {
    type: 'actions',
    block_id: blockId,
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
        text: { type: 'plain_text', text: '🗑️ 전체 삭제' },
        style: 'danger',
        confirm: CONFIRM_CLEAR_ALL,
        action_id: 'z_setting_memory_set_clear_all',
        value: 'clear_all',
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

function perEntryBlocks(target: 'memory' | 'user', index1: number, text: string): ZBlock[] {
  const section: ZBlock = {
    type: 'section',
    block_id: `z_memory_entry_${target}_${index1}`,
    text: {
      type: 'mrkdwn',
      text: `*#${index1}* | ${escapeMrkdwn(text)}`,
    },
  };
  const actions: ZBlock = {
    type: 'actions',
    block_id: `z_memory_${target}_entry_${index1}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🪄 개선' },
        style: 'primary',
        action_id: `z_setting_memory_set_improve_${target}_${index1}`,
        value: `improve_${target}_${index1}`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '🗑️ 삭제' },
        style: 'danger',
        confirm: CONFIRM_CLEAR_ONE,
        action_id: `z_setting_memory_set_clear_${target}_${index1}`,
        value: `clear_${target}_${index1}`,
      },
    ],
  };
  return [section, actions];
}

function extraActionsRow(): ZBlock {
  return {
    type: 'actions',
    block_id: 'z_memory_extra',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '➕ 사용자 정보 추가' },
        style: 'primary',
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
 * section) to stay under the Block Kit 50-block cap. Rules:
 *   - Start pulling from the LARGER store first.
 *   - Keep at least 3 per-entry rows per store when possible; spill to the
 *     other store if the larger store hits the floor first.
 *   - When total ≤ 20 → no collapse.
 *   - Target: 2 * keptTotal + banner(1) + collapsedSections(≤2) ≤ 41
 *     i.e. keptTotal ≤ 19. Use 19 as the post-collapse target when total > 20.
 */
function planCollapse(memCount: number, usrCount: number): { memCollapseN: number; usrCollapseN: number } {
  const total = memCount + usrCount;
  if (total <= 20) return { memCollapseN: 0, usrCollapseN: 0 };
  // Leave 2 blocks for banner + per-store collapsed section headroom.
  const keptTarget = 19;
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
  blocks.push(globalActionsRow('z_memory_global_top'));
  blocks.push(groupHeaderSection('memory', memCount));

  // Collapsed memory section(s) first (oldest are at the top of the group)
  blocks.push(...collapseSectionsFor('memory', memCollapsed, 1));
  // Kept memory entries: numbering continues from collapsed.length + 1
  for (let i = 0; i < memKept.length; i++) {
    const idx = memCollapsed.length + i + 1;
    blocks.push(...perEntryBlocks('memory', idx, memKept[i]));
  }

  blocks.push(dividerBlock());
  blocks.push(groupHeaderSection('user', usrCount));
  blocks.push(...collapseSectionsFor('user', usrCollapsed, 1));
  for (let i = 0; i < usrKept.length; i++) {
    const idx = usrCollapsed.length + i + 1;
    blocks.push(...perEntryBlocks('user', idx, usrKept[i]));
  }

  blocks.push(globalActionsRow('z_memory_global_bottom'));
  blocks.push(extraActionsRow());
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
  // builder with an overridden plan (user fully collapsed, memory keeps ≤19
  // per-entry rows).
  if (blocks.length > 50) {
    const memCount = mem.entries.length;
    const usrCount = usr.entries.length;
    // 2*keep ≤ 38 → keep 19 memory rows (fixed ~9 + banner + collapsed ≤2)
    const memCollapseN = Math.max(0, memCount - 19);
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

export async function renderPendingCard(args: {
  userId: string;
  target: 'memory' | 'user';
  idx: number | 'all';
  issuedAt: number;
}): Promise<RenderResult> {
  const { userId, target, idx } = args;
  const card = await renderMemoryCard({ userId, issuedAt: args.issuedAt });
  const blocks = card.blocks as ZBlock[];

  if (idx === 'all') {
    // Replace the top-actions row text with a single "🔄 전체 {target} 개선 중…" marker.
    const topIdx = blocks.findIndex(
      (b) =>
        (b as { type?: string }).type === 'actions' && (b as { block_id?: string }).block_id === 'z_memory_global_top',
    );
    if (topIdx !== -1) {
      const label = target === 'memory' ? '전체 메모리 개선 중…' : '전체 프로필 개선 중…';
      blocks[topIdx] = {
        type: 'section',
        block_id: 'z_memory_global_top',
        text: { type: 'mrkdwn', text: `🔄 ${label}` },
      };
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
    apply: (args) => applyMemory({ userId: args.userId, value: args.value, respond: args.respond }),
    renderCard: (args) => renderMemoryCard({ userId: args.userId, issuedAt: args.issuedAt }),
    openModal: (args) => openMemoryModal({ client: args.client, triggerId: args.triggerId }),
    submitModal: async (args) => {
      // ack() already fired in the framework wrapper — surface validation
      // failures as a DM so users get visible feedback instead of a silently
      // closed modal (codex P1 #5).
      const result = await submitMemoryModal({ client: args.client, userId: args.userId, values: args.values });
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
