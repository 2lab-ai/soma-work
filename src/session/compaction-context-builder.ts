/**
 * Compaction Context Builder
 *
 * When Claude SDK auto-compacts a session (context window full), the
 * conversation summary may lose soma-work-specific state: session links,
 * workflow type, persona, etc.
 *
 * This module builds a concise system-reminder block containing all
 * critical session state, to be injected into the next user prompt
 * after compaction occurs.
 *
 * Pure function — no I/O, no side effects, deterministic.
 */

import type { SessionLinks, SessionLinkHistory, SessionLink, WorkflowType } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionContextInput {
  sessionTitle?: string;
  workflow?: WorkflowType;
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  persona?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a system-reminder block with preserved session context.
 * Returns empty string if there's nothing meaningful to preserve.
 */
export function buildCompactionContext(input: CompactionContextInput): string {
  const sections: string[] = [];

  // Session title
  if (input.sessionTitle) {
    sections.push(`세션 제목: ${input.sessionTitle}`);
  }

  // Workflow type
  if (input.workflow) {
    sections.push(`워크플로우: ${input.workflow}`);
  }

  // Active links
  const activeLinks = formatActiveLinks(input.links);
  if (activeLinks) {
    sections.push(`활성 링크:\n${activeLinks}`);
  }

  // Link history (truncated)
  const history = formatLinkHistory(input.linkHistory, input.links);
  if (history) {
    sections.push(`링크 이력:\n${history}`);
  }

  // Persona (skip default)
  if (input.persona && input.persona !== 'default') {
    sections.push(`persona: ${input.persona}`);
  }

  // Effort level
  if (input.effort) {
    sections.push(`effort: ${input.effort}`);
  }

  if (sections.length === 0) {
    return '';
  }

  const body = [
    'Context preserved after session compaction. This is your previous session state:',
    '',
    ...sections,
  ].join('\n');

  return `<system-reminder>\n${body}\n</system-reminder>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatActiveLinks(links?: SessionLinks): string | null {
  if (!links) return null;

  const parts: string[] = [];

  if (links.issue) {
    parts.push(`- Issue: ${formatLink(links.issue)}`);
  }
  if (links.pr) {
    parts.push(`- PR: ${formatLink(links.pr)}`);
  }
  if (links.doc) {
    parts.push(`- Doc: ${formatLink(links.doc)}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function formatLinkHistory(
  history?: SessionLinkHistory,
  activeLinks?: SessionLinks,
): string | null {
  if (!history) return null;

  // Collect all history links, excluding active ones (already shown above)
  const activeUrls = new Set<string>();
  if (activeLinks?.issue) activeUrls.add(activeLinks.issue.url);
  if (activeLinks?.pr) activeUrls.add(activeLinks.pr.url);
  if (activeLinks?.doc) activeUrls.add(activeLinks.doc.url);

  const allLinks = [
    ...history.issues.map((l) => ({ ...l, category: 'Issue' })),
    ...history.prs.map((l) => ({ ...l, category: 'PR' })),
    ...history.docs.map((l) => ({ ...l, category: 'Doc' })),
  ].filter((l) => !activeUrls.has(l.url));

  if (allLinks.length === 0) return null;

  // Cap at 10 to stay within token budget
  const capped = allLinks.slice(0, 10);
  const parts = capped.map((l) => `- ${l.category}: ${formatLink(l)}`);

  if (allLinks.length > 10) {
    parts.push(`- ... and ${allLinks.length - 10} more`);
  }

  return parts.join('\n');
}

function formatLink(link: SessionLink): string {
  const label = link.label || link.title || '';
  const status = link.status ? ` (${link.status})` : '';
  return label ? `${label}${status} — ${link.url}` : link.url;
}
