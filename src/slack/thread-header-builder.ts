import { SessionLinks, SessionUsage, WorkflowType, ConversationSession } from '../types';
import { ContextWindowManager } from './context-window-manager';

export interface ThreadHeaderData {
  title?: string;
  workflow?: WorkflowType;
  ownerName?: string;
  ownerId?: string;
  links?: SessionLinks;
  closed?: boolean;
  /** Model name for display (e.g. "claude-opus-4-6-20250414") */
  model?: string;
  /** Current session usage for context bar */
  usage?: SessionUsage;
}

export interface ThreadHeaderPayload {
  text: string;
  blocks?: any[];
  attachments?: any[];
}

export class ThreadHeaderBuilder {
  static fromSession(session: ConversationSession, overrides?: { closed?: boolean }): ThreadHeaderPayload {
    return this.build({
      title: session.title,
      workflow: session.workflow,
      ownerName: session.ownerName,
      ownerId: session.ownerId,
      links: session.links,
      model: session.model,
      usage: session.usage,
      ...overrides,
    });
  }

  static build(data: ThreadHeaderData): ThreadHeaderPayload {
    // Prefer actual PR/issue title over short label (e.g. "Fix auth flow" over "PR #456")
    const title = data.title
      || data.links?.pr?.title || data.links?.issue?.title
      || data.links?.pr?.label || data.links?.issue?.label
      || 'Session';
    const workflow = data.workflow || 'default';
    const owner = data.ownerName || data.ownerId;

    // Header: "OwnerName — Title" (owner first, prominently visible)
    // Slack header blocks cap plain_text at 150 characters
    const MAX_HEADER_LEN = 150;
    const rawHeaderText = owner ? `${owner} — ${title}` : title;
    const headerText = rawHeaderText.length > MAX_HEADER_LEN
      ? rawHeaderText.slice(0, MAX_HEADER_LEN - 1) + '…'
      : rawHeaderText;
    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      },
    ];

    // Context line: @mention + workflow + model + context bar + links + closed
    const contextElements: any[] = [];
    if (data.ownerId) {
      contextElements.push({ type: 'mrkdwn', text: `<@${data.ownerId}>` });
    }
    contextElements.push({ type: 'mrkdwn', text: `\`${workflow}\`` });

    // Model chip: short display name
    if (data.model) {
      contextElements.push({ type: 'mrkdwn', text: `\`${this.formatModelName(data.model)}\`` });
    }

    // Context window bar: "⬛⬛⬛⬜⬜ 156k/1M"
    const contextBar = this.formatContextBar(data.usage);
    if (contextBar) {
      contextElements.push({ type: 'mrkdwn', text: contextBar });
    }

    const linkParts = this.formatLinks(data.links);
    for (const linkText of linkParts) {
      contextElements.push({ type: 'mrkdwn', text: linkText });
    }

    if (data.closed) {
      contextElements.push({ type: 'mrkdwn', text: '_종료됨_' });
    }

    if (contextElements.length > 0) {
      blocks.push({
        type: 'context',
        elements: contextElements,
      });
    }

    const textParts: string[] = [title];
    if (owner) textParts.push(owner);
    if (linkParts.length > 0) textParts.push(linkParts.join(' · '));

    return {
      text: textParts.join('\n'),
      blocks,
    };
  }

  /**
   * Format model name for display.
   * "claude-opus-4-6-20250414" → "opus-4.6"
   * "claude-sonnet-4-5-20250414" → "sonnet-4.5"
   */
  static formatModelName(model: string): string {
    // Match patterns like "claude-opus-4-6", "claude-sonnet-4-5"
    const match = model.match(/claude-(\w+)-(\d+)-(\d+)/);
    if (match) {
      return `${match[1]}-${match[2]}.${match[3]}`;
    }
    // Fallback: strip "claude-" prefix and date suffix
    return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  }

  /**
   * Format context window usage as a compact bar.
   * Returns "▓▓▓▓░ 156k/1M" or undefined if no usage data.
   */
  static formatContextBar(usage?: SessionUsage): string | undefined {
    if (!usage || usage.contextWindow <= 0) return undefined;

    const used = ContextWindowManager.computeUsedTokens(usage);
    const total = usage.contextWindow;
    const usedPercent = Math.min(100, (used / total) * 100);

    // 5-segment bar
    const filledSegments = Math.round(usedPercent / 20);
    const bar = '▓'.repeat(filledSegments) + '░'.repeat(5 - filledSegments);

    return `${bar} ${this.formatTokenCount(used)}/${this.formatTokenCount(total)}`;
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

  private static formatLinks(links?: SessionLinks): string[] {
    if (!links) return [];
    const parts: string[] = [];

    if (links.issue?.url && !this.isSlackMessageUrl(links.issue.url)) {
      const label = links.issue.label || 'Issue';
      parts.push(`<${links.issue.url}|${label}>`);
    }

    if (links.pr?.url && !this.isSlackMessageUrl(links.pr.url)) {
      const label = links.pr.label || 'PR';
      parts.push(`<${links.pr.url}|${label}>`);
    }

    if (links.doc?.url && !this.isSlackMessageUrl(links.doc.url)) {
      const label = links.doc.label || 'Doc';
      parts.push(`<${links.doc.url}|${label}>`);
    }

    return parts;
  }

  private static isSlackMessageUrl(url: string): boolean {
    return url.includes('slack.com/archives/') || url.includes('app.slack.com/client/');
  }
}
