import { getStatusEmoji } from '../link-metadata-fetcher';
import { hasOneMSuffix, stripOneMSuffix } from '../metrics/model-registry';
import type {
  ConversationSession,
  SessionLink,
  SessionLinkHistory,
  SessionLinks,
  SessionUsage,
  WorkflowType,
} from '../types';
import type { SessionTheme } from '../user-settings-store';
import { ContextWindowManager } from './context-window-manager';

/** Max links to display per type in Default theme */
const MAX_LINKS_PER_TYPE = 5;

export interface ThreadHeaderData {
  title?: string;
  workflow?: WorkflowType;
  ownerName?: string;
  ownerId?: string;
  links?: SessionLinks;
  /** Full link history for Default theme multi-link display */
  linkHistory?: SessionLinkHistory;
  closed?: boolean;
  /** Model name for display (e.g. "claude-opus-4-6-20250414") */
  model?: string;
  /** Current session usage for context bar */
  usage?: SessionUsage;
  /** UI display theme */
  theme?: SessionTheme;
}

export interface ThreadHeaderPayload {
  text: string;
  blocks?: any[];
  attachments?: any[];
}

export class ThreadHeaderBuilder {
  static fromSession(
    session: ConversationSession,
    overrides?: { closed?: boolean; theme?: SessionTheme },
  ): ThreadHeaderPayload {
    // Dashboard v2.1 — prefer LLM-generated summaryTitle when available,
    // then raw title. Undefined when neither is set so resolveTitle's
    // existing pr/issue fallback chain still runs.
    const resolvedTitle = session.summaryTitle?.trim() || session.title?.trim() || undefined;
    return ThreadHeaderBuilder.build({
      title: resolvedTitle,
      workflow: session.workflow,
      ownerName: session.ownerName,
      ownerId: session.ownerId,
      links: session.links,
      linkHistory: session.linkHistory,
      model: session.model,
      usage: session.usage,
      ...overrides,
    });
  }

  static build(data: ThreadHeaderData): ThreadHeaderPayload {
    const theme = data.theme || 'default';
    const textFallback = ThreadHeaderBuilder.buildTextFallback(data);

    switch (theme) {
      case 'default':
        return { text: textFallback, blocks: ThreadHeaderBuilder.buildDefault(data) };
      case 'compact':
        return { text: textFallback, blocks: ThreadHeaderBuilder.buildCompact(data) };
      case 'minimal':
        return { text: textFallback, blocks: ThreadHeaderBuilder.buildMinimal(data) };
      default:
        return { text: textFallback, blocks: ThreadHeaderBuilder.buildDefault(data) };
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private static resolveTitle(data: ThreadHeaderData): string {
    return (
      data.title ||
      data.links?.pr?.title ||
      data.links?.issue?.title ||
      data.links?.pr?.label ||
      data.links?.issue?.label ||
      'Session'
    );
  }

  private static resolveOwner(data: ThreadHeaderData): string | undefined {
    return data.ownerName || data.ownerId;
  }

  private static buildTextFallback(data: ThreadHeaderData): string {
    const title = ThreadHeaderBuilder.resolveTitle(data);
    const owner = ThreadHeaderBuilder.resolveOwner(data);
    const parts: string[] = [title];
    if (owner) parts.push(owner);
    return parts.join('\n');
  }

  private static truncateHeader(text: string): string {
    const MAX = 150;
    return text.length > MAX ? text.slice(0, MAX - 1) + '…' : text;
  }

  private static headerBlock(text: string): any {
    return {
      type: 'header',
      text: { type: 'plain_text', text: ThreadHeaderBuilder.truncateHeader(text), emoji: true },
    };
  }

  private static contextBlock(elements: any[]): any {
    // Slack caps context elements at 10
    return { type: 'context', elements: elements.slice(0, 10) };
  }

  private static mrkdwn(text: string): any {
    return { type: 'mrkdwn', text };
  }

  /** Gather the standard meta elements: workflow, model, contextBar */
  private static metaElements(data: ThreadHeaderData): any[] {
    const els: any[] = [];
    const workflow = data.workflow || 'default';
    els.push(ThreadHeaderBuilder.mrkdwn(`\`${workflow}\``));
    if (data.model) {
      els.push(ThreadHeaderBuilder.mrkdwn(`\`${ThreadHeaderBuilder.formatModelName(data.model)}\``));
    }
    const ctxBar = ThreadHeaderBuilder.formatContextBar(data.usage);
    if (ctxBar) els.push(ThreadHeaderBuilder.mrkdwn(ctxBar));
    return els;
  }

  private static linkElements(data: ThreadHeaderData): any[] {
    return ThreadHeaderBuilder.formatLinks(data.links).map((t) => ThreadHeaderBuilder.mrkdwn(t));
  }

  private static ownerMention(data: ThreadHeaderData): any | undefined {
    return data.ownerId ? ThreadHeaderBuilder.mrkdwn(`<@${data.ownerId}>`) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Theme: Default (Rich Card) — maximum info density, all links with metadata
  // ---------------------------------------------------------------------------
  private static buildDefault(data: ThreadHeaderData): any[] {
    const title = ThreadHeaderBuilder.resolveTitle(data);
    const blocks: any[] = [ThreadHeaderBuilder.headerBlock(title)];

    // Row 1: @owner + workflow + model
    const row1: any[] = [];
    const mention = ThreadHeaderBuilder.ownerMention(data);
    if (mention) row1.push(mention);
    row1.push(...ThreadHeaderBuilder.metaElements(data));
    if (row1.length > 0) blocks.push(ThreadHeaderBuilder.contextBlock(row1));

    // Row 2+: All links from linkHistory (max 5 per type) with metadata
    const allLinkElements = ThreadHeaderBuilder.formatAllLinks(data.linkHistory, data.links);
    if (allLinkElements.length > 0) {
      // Group into context blocks (max 10 elements each)
      for (let i = 0; i < allLinkElements.length; i += 10) {
        blocks.push(ThreadHeaderBuilder.contextBlock(allLinkElements.slice(i, i + 10)));
      }
    }

    // Closed indicator
    if (data.closed) {
      blocks.push(ThreadHeaderBuilder.contextBlock([ThreadHeaderBuilder.mrkdwn('🔴 _종료됨_')]));
    }

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme: Compact — section.text + thin context, active links only
  // ---------------------------------------------------------------------------
  private static buildCompact(data: ThreadHeaderData): any[] {
    const title = ThreadHeaderBuilder.resolveTitle(data);
    const owner = ThreadHeaderBuilder.resolveOwner(data);
    const emoji = data.closed ? '🔴' : '🟢';
    const sectionText = owner ? `${emoji} *${owner} — ${title}*` : `${emoji} *${title}*`;

    const blocks: any[] = [{ type: 'section', text: ThreadHeaderBuilder.mrkdwn(sectionText) }];

    const ctxEls: any[] = [...ThreadHeaderBuilder.metaElements(data), ...ThreadHeaderBuilder.linkElements(data)];
    if (data.closed) ctxEls.push(ThreadHeaderBuilder.mrkdwn('_종료됨_'));
    if (ctxEls.length > 0) blocks.push(ThreadHeaderBuilder.contextBlock(ctxEls));
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme: Minimal — single context line, bare minimum
  // ---------------------------------------------------------------------------
  private static buildMinimal(data: ThreadHeaderData): any[] {
    const title = ThreadHeaderBuilder.resolveTitle(data);
    const els: any[] = [ThreadHeaderBuilder.mrkdwn(title)];
    if (data.model) {
      els.push(ThreadHeaderBuilder.mrkdwn(`\`${ThreadHeaderBuilder.formatModelName(data.model)}\``));
    }
    const ctxBar = ThreadHeaderBuilder.formatContextBar(data.usage);
    if (ctxBar) els.push(ThreadHeaderBuilder.mrkdwn(ctxBar));
    // Active links only (labels)
    els.push(...ThreadHeaderBuilder.linkElements(data));
    if (data.closed) els.push(ThreadHeaderBuilder.mrkdwn('_종료됨_'));
    return [ThreadHeaderBuilder.contextBlock(els)];
  }

  // ---------------------------------------------------------------------------
  // Link formatting
  // ---------------------------------------------------------------------------

  /**
   * Format all links from linkHistory for Default theme.
   * Shows up to MAX_LINKS_PER_TYPE per type with title and status.
   * Falls back to active links if no history available.
   */
  private static formatAllLinks(linkHistory?: SessionLinkHistory, activeLinks?: SessionLinks): any[] {
    const elements: any[] = [];

    if (!linkHistory) {
      // Fallback: use active links only
      return ThreadHeaderBuilder.formatLinks(activeLinks).map((t) => ThreadHeaderBuilder.mrkdwn(t));
    }

    // Issues
    const issues = linkHistory.issues || [];
    const displayIssues = issues.slice(-MAX_LINKS_PER_TYPE);
    for (const link of displayIssues) {
      elements.push(ThreadHeaderBuilder.mrkdwn(ThreadHeaderBuilder.formatLinkWithMeta(link, '📋')));
    }
    if (issues.length > MAX_LINKS_PER_TYPE) {
      elements.push(ThreadHeaderBuilder.mrkdwn(`_+${issues.length - MAX_LINKS_PER_TYPE} more issues_`));
    }

    // PRs
    const prs = linkHistory.prs || [];
    const displayPrs = prs.slice(-MAX_LINKS_PER_TYPE);
    for (const link of displayPrs) {
      elements.push(ThreadHeaderBuilder.mrkdwn(ThreadHeaderBuilder.formatLinkWithMeta(link, '🔀')));
    }
    if (prs.length > MAX_LINKS_PER_TYPE) {
      elements.push(ThreadHeaderBuilder.mrkdwn(`_+${prs.length - MAX_LINKS_PER_TYPE} more PRs_`));
    }

    // Docs
    const docs = linkHistory.docs || [];
    const displayDocs = docs.slice(-MAX_LINKS_PER_TYPE);
    for (const link of displayDocs) {
      elements.push(ThreadHeaderBuilder.mrkdwn(ThreadHeaderBuilder.formatLinkWithMeta(link, '📄')));
    }
    if (docs.length > MAX_LINKS_PER_TYPE) {
      elements.push(ThreadHeaderBuilder.mrkdwn(`_+${docs.length - MAX_LINKS_PER_TYPE} more docs_`));
    }

    return elements;
  }

  /**
   * Format a single link with its metadata (title + status emoji).
   * Example: "📋 <url|SOMA-123>: Fix login bug ✅"
   */
  private static formatLinkWithMeta(link: SessionLink, emoji: string): string {
    const label = link.label || link.url;
    let text = `${emoji} <${link.url}|${label}>`;
    if (link.title) {
      const truncated = link.title.length > 40 ? link.title.slice(0, 39) + '…' : link.title;
      text += `: ${truncated}`;
    }
    if (link.status) {
      const statusEmoji = getStatusEmoji(link.status, link.type);
      text += ` ${statusEmoji || `[${link.status}]`}`;
    }
    return text;
  }

  /** Format active links only (for Compact/Minimal themes) */
  private static formatLinks(links?: SessionLinks): string[] {
    if (!links) return [];
    const parts: string[] = [];

    if (links.issue?.url && !ThreadHeaderBuilder.isSlackMessageUrl(links.issue.url)) {
      const label = links.issue.label || 'Issue';
      parts.push(`<${links.issue.url}|${label}>`);
    }

    if (links.pr?.url && !ThreadHeaderBuilder.isSlackMessageUrl(links.pr.url)) {
      const label = links.pr.label || 'PR';
      parts.push(`<${links.pr.url}|${label}>`);
    }

    if (links.doc?.url && !ThreadHeaderBuilder.isSlackMessageUrl(links.doc.url)) {
      const label = links.doc.label || 'Doc';
      parts.push(`<${links.doc.url}|${label}>`);
    }

    return parts;
  }

  private static isSlackMessageUrl(url: string): boolean {
    return url.includes('slack.com/archives/') || url.includes('app.slack.com/client/');
  }

  // ---------------------------------------------------------------------------
  // Public static helpers
  // ---------------------------------------------------------------------------

  /**
   * Format model name for display.
   * "claude-opus-4-6-20250414" → "opus-4.6"
   * "claude-opus-4-7[1m]"      → "opus-4.7 (1M)"
   *
   * The `[1m]` suffix is a non-word character, so we strip it before running
   * the slug regex and re-append `" (1M)"` to the formatted output.
   */
  static formatModelName(model: string): string {
    const oneM = hasOneMSuffix(model);
    const base = oneM ? stripOneMSuffix(model) : model;
    const match = base.match(/claude-(\w+)-(\d+)-(\d+)/);
    const formatted = match
      ? `${match[1]}-${match[2]}.${match[3]}`
      : base.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    return oneM ? `${formatted} (1M)` : formatted;
  }

  /**
   * Format context window usage as a compact bar.
   * Returns "▓░░░░ 156k/1M (85%)" or undefined if no usage data.
   */
  static formatContextBar(usage?: SessionUsage): string | undefined {
    if (!usage || usage.contextWindow <= 0) return undefined;

    const used = ContextWindowManager.computeUsedTokens(usage);
    const total = usage.contextWindow;
    const remainingPercent = Math.max(0, Math.min(100, ((total - used) / total) * 100));
    const usedPercent = 100 - remainingPercent;

    const filledSegments = Math.round(usedPercent / 20);
    const bar = '▓'.repeat(filledSegments) + '░'.repeat(5 - filledSegments);

    const pct = Number.isInteger(remainingPercent) ? `${remainingPercent}` : remainingPercent.toFixed(1);
    return `${bar} ${ThreadHeaderBuilder.formatTokenCount(used)}/${ThreadHeaderBuilder.formatTokenCount(total)} (${pct}%)`;
  }

  /**
   * Format token count for compact display.
   * 1_000_000 → "1M", 200_000 → "200k", 156_700 → "156.7k"
   */
  static formatTokenCount(n: number): string {
    if (n >= 1_000_000) {
      const m = n / 1_000_000;
      return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
    }
    if (n >= 1000) {
      const k = n / 1000;
      return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`;
    }
    return n.toString();
  }
}
