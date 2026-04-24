/**
 * Compaction-Aware Context Preservation (#196)
 *
 * When the Claude SDK auto-compacts a conversation (compact_boundary event),
 * critical session metadata — linked resources, working directory, workflow,
 * title — can be lost from the context window.
 *
 * This module builds a concise "preservation block" that is injected into the
 * next user prompt after compaction, ensuring continuity without manual recap.
 *
 * Design: pure functions only — no side effects, no I/O.
 */

import type { ConversationSession, SessionInstruction, SessionLink, SessionLinks, WorkflowType } from '../types';

/**
 * Subset of ConversationSession needed to build the preservation context.
 * Keeps the builder decoupled from the full session type.
 */
export interface CompactionSessionSnapshot {
  title?: string;
  workflow?: WorkflowType;
  workingDirectory?: string;
  links?: SessionLinks;
  model?: string;
  ownerId: string;
  ownerName?: string;
  /**
   * User-SSOT instructions — preserved through compaction so the model
   * retains active/todo/completed intent even after the SDK rehydrates
   * from the compact summary alone. Dual-protected together with the
   * reset-point systemPrompt rebuild (PLAN §3(c) + §8).
   */
  instructions?: SessionInstruction[];
}

/**
 * Build a compact, structured text block that re-introduces session context
 * after an SDK auto-compaction event.
 *
 * Returns `undefined` if there is nothing meaningful to preserve.
 */
export function buildCompactionContext(snapshot: CompactionSessionSnapshot): string | undefined {
  const sections: string[] = [];

  // Session identity
  if (snapshot.title) {
    sections.push(`Session: ${snapshot.title}`);
  }

  // Active workflow
  if (snapshot.workflow && snapshot.workflow !== 'default') {
    sections.push(`Workflow: ${snapshot.workflow}`);
  }

  // Working directory
  if (snapshot.workingDirectory) {
    sections.push(`Working directory: ${snapshot.workingDirectory}`);
  }

  // Linked resources
  const linkLines = formatLinks(snapshot.links);
  if (linkLines.length > 0) {
    sections.push(`Linked resources:\n${linkLines.join('\n')}`);
  }

  // Model
  if (snapshot.model) {
    sections.push(`Model: ${snapshot.model}`);
  }

  // Owner
  if (snapshot.ownerName) {
    sections.push(`Session owner: ${snapshot.ownerName}`);
  }

  // User-SSOT instructions (active/todo/completed). Rendered as bulleted
  // lines — the full user-instructions-ssot block is already re-injected via
  // systemPrompt rebuild on the reset path, so this preservation block only
  // carries the *status-grouped headers* needed to bridge the SDK rehydrate
  // window between compact_boundary and the next user turn.
  const instructionLines = formatInstructions(snapshot.instructions);
  if (instructionLines.length > 0) {
    sections.push(`User instructions (SSOT):\n${instructionLines.join('\n')}`);
  }

  if (sections.length === 0) return undefined;

  return [
    '<session-context-after-compaction>',
    'The conversation was auto-compacted by the SDK. The following session metadata was preserved:',
    '',
    ...sections,
    '</session-context-after-compaction>',
  ].join('\n');
}

/**
 * Extract a snapshot from a full ConversationSession.
 */
export function snapshotFromSession(session: ConversationSession): CompactionSessionSnapshot {
  return {
    title: session.title,
    workflow: session.workflow,
    workingDirectory: session.workingDirectory,
    links: session.links,
    model: session.model,
    ownerId: session.ownerId,
    ownerName: session.ownerName,
    instructions: session.instructions,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

function formatLinks(links?: SessionLinks): string[] {
  if (!links) return [];
  const lines: string[] = [];
  if (links.issue) lines.push(formatLink(links.issue));
  if (links.pr) lines.push(formatLink(links.pr));
  if (links.doc) lines.push(formatLink(links.doc));
  return lines;
}

function formatLink(link: SessionLink): string {
  const parts = [`- [${link.type}]`];
  if (link.label) parts.push(link.label);
  if (link.title) parts.push(`"${link.title}"`);
  parts.push(link.url);
  if (link.status) parts.push(`(${link.status})`);
  return parts.join(' ');
}

function formatInstructions(instructions?: SessionInstruction[]): string[] {
  if (!instructions || instructions.length === 0) return [];
  const grouped = { active: [] as string[], todo: [] as string[], completed: [] as string[] };
  for (const i of instructions) {
    const s = i.status ?? 'active';
    const text = i.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (s === 'todo') grouped.todo.push(`- [todo] ${text}`);
    else if (s === 'completed') grouped.completed.push(`- [completed] ${text}`);
    else grouped.active.push(`- [active] ${text}`);
  }
  return [...grouped.active, ...grouped.todo, ...grouped.completed];
}
