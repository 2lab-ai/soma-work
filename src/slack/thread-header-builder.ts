import { SessionLinks, SessionUsage, WorkflowType, ConversationSession } from '../types';
import { ContextWindowManager } from './context-window-manager';
import { type SessionTheme } from '../user-settings-store';

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
  /** UI display theme (A-L) */
  theme?: SessionTheme;
}

export interface ThreadHeaderPayload {
  text: string;
  blocks?: any[];
  attachments?: any[];
}

export class ThreadHeaderBuilder {
  static fromSession(session: ConversationSession, overrides?: { closed?: boolean; theme?: SessionTheme }): ThreadHeaderPayload {
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
    const theme = data.theme || 'A';
    const textFallback = this.buildTextFallback(data);

    switch (theme) {
      case 'A': return { text: textFallback, blocks: this.buildMinimal(data) };
      case 'B': return { text: textFallback, blocks: this.buildOneLiner(data) };
      case 'C': return { text: textFallback, blocks: this.buildCompact(data) };
      case 'D': return { text: textFallback, blocks: this.buildClassic(data) };
      case 'E': return { text: textFallback, blocks: this.buildDashboard(data) };
      case 'F': return { text: textFallback, blocks: this.buildStatusBar(data) };
      case 'G': return { text: textFallback, blocks: this.buildRichCard(data) };
      case 'H': return { text: textFallback, blocks: this.buildTable(data) };
      case 'I': return { text: textFallback, blocks: this.buildKanban(data) };
      case 'J': return { text: textFallback, blocks: this.buildTimeline(data) };
      case 'K': return { text: textFallback, blocks: this.buildProgress(data) };
      case 'L': return { text: textFallback, blocks: this.buildNotification(data) };
      default: return { text: textFallback, blocks: this.buildMinimal(data) };
    }
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private static resolveTitle(data: ThreadHeaderData): string {
    return data.title
      || data.links?.pr?.title || data.links?.issue?.title
      || data.links?.pr?.label || data.links?.issue?.label
      || 'Session';
  }

  private static resolveOwner(data: ThreadHeaderData): string | undefined {
    return data.ownerName || data.ownerId;
  }

  private static buildTextFallback(data: ThreadHeaderData): string {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
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
      text: { type: 'plain_text', text: this.truncateHeader(text), emoji: true },
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
    els.push(this.mrkdwn(`\`${workflow}\``));
    if (data.model) {
      els.push(this.mrkdwn(`\`${this.formatModelName(data.model)}\``));
    }
    const ctxBar = this.formatContextBar(data.usage);
    if (ctxBar) els.push(this.mrkdwn(ctxBar));
    return els;
  }

  private static linkElements(data: ThreadHeaderData): any[] {
    return this.formatLinks(data.links).map(t => this.mrkdwn(t));
  }

  private static ownerMention(data: ThreadHeaderData): any | undefined {
    return data.ownerId ? this.mrkdwn(`<@${data.ownerId}>`) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Theme A: Minimal — single context line "title · model · time"
  // ---------------------------------------------------------------------------
  private static buildMinimal(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const els: any[] = [this.mrkdwn(title)];
    if (data.model) {
      els.push(this.mrkdwn(`\`${this.formatModelName(data.model)}\``));
    }
    const ctxBar = this.formatContextBar(data.usage);
    if (ctxBar) els.push(this.mrkdwn(ctxBar));
    if (data.closed) els.push(this.mrkdwn('_종료됨_'));
    return [this.contextBlock(els)];
  }

  // ---------------------------------------------------------------------------
  // Theme B: One-Liner — everything on one context line
  // ---------------------------------------------------------------------------
  private static buildOneLiner(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const els: any[] = [];
    if (owner) els.push(this.mrkdwn(`${owner} —`));
    els.push(this.mrkdwn(title));
    els.push(...this.metaElements(data));
    els.push(...this.linkElements(data));
    if (data.closed) els.push(this.mrkdwn('_종료됨_'));
    return [this.contextBlock(els)];
  }

  // ---------------------------------------------------------------------------
  // Theme C: Compact — section.text + thin context
  // ---------------------------------------------------------------------------
  private static buildCompact(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const emoji = data.closed ? '🔴' : '🟢';
    const sectionText = owner ? `${emoji} *${owner} — ${title}*` : `${emoji} *${title}*`;

    const blocks: any[] = [
      { type: 'section', text: this.mrkdwn(sectionText) },
    ];

    const ctxEls: any[] = [...this.metaElements(data), ...this.linkElements(data)];
    if (data.closed) ctxEls.push(this.mrkdwn('_종료됨_'));
    if (ctxEls.length > 0) blocks.push(this.contextBlock(ctxEls));
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme D: Classic — current implementation (header + context)
  // ---------------------------------------------------------------------------
  private static buildClassic(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const rawHeaderText = owner ? `${owner} — ${title}` : title;

    const blocks: any[] = [this.headerBlock(rawHeaderText)];

    const contextElements: any[] = [];
    if (data.ownerId) contextElements.push(this.mrkdwn(`<@${data.ownerId}>`));
    contextElements.push(...this.metaElements(data));
    contextElements.push(...this.linkElements(data));
    if (data.closed) contextElements.push(this.mrkdwn('_종료됨_'));

    if (contextElements.length > 0) blocks.push(this.contextBlock(contextElements));
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme E: Dashboard — header with 📊 + two context rows
  // ---------------------------------------------------------------------------
  private static buildDashboard(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const headerText = owner ? `📊 ${owner} — ${title}` : `📊 ${title}`;
    const blocks: any[] = [this.headerBlock(headerText)];

    // Context row 1: workflow + model + ctx bar
    const row1 = this.metaElements(data);
    if (row1.length > 0) blocks.push(this.contextBlock(row1));

    // Context row 2: links + closed
    const row2: any[] = [...this.linkElements(data)];
    if (data.closed) row2.push(this.mrkdwn('_종료됨_'));
    if (row2.length > 0) blocks.push(this.contextBlock(row2));

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme F: Status Bar — header + status context with colored dots
  // ---------------------------------------------------------------------------
  private static buildStatusBar(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const headerText = owner ? `${owner} — ${title}` : title;
    const blocks: any[] = [this.headerBlock(headerText)];

    const statusDot = data.closed ? '🔴 종료됨' : '🟢 Active';
    const els: any[] = [this.mrkdwn(statusDot)];
    const mention = this.ownerMention(data);
    if (mention) els.push(mention);
    els.push(...this.metaElements(data));
    els.push(...this.linkElements(data));
    blocks.push(this.contextBlock(els));
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme G: Rich Card — header + owner context + meta context
  // ---------------------------------------------------------------------------
  private static buildRichCard(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const blocks: any[] = [this.headerBlock(title)];

    // Context row 1: @owner + workflow + model
    const row1: any[] = [];
    const mention = this.ownerMention(data);
    if (mention) row1.push(mention);
    row1.push(...this.metaElements(data));
    if (row1.length > 0) blocks.push(this.contextBlock(row1));

    // Context row 2: ctx bar + links
    const row2: any[] = [...this.linkElements(data)];
    if (data.closed) row2.push(this.mrkdwn('_종료됨_'));
    if (row2.length > 0) blocks.push(this.contextBlock(row2));

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme H: Table — header + section.fields (2-col key/value)
  // ---------------------------------------------------------------------------
  private static buildTable(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const headerText = owner ? `${owner} — ${title}` : title;
    const blocks: any[] = [this.headerBlock(headerText)];

    const workflow = data.workflow || 'default';
    const fields: any[] = [];
    if (data.model) {
      fields.push(this.mrkdwn(`*모델*\n\`${this.formatModelName(data.model)}\``));
    }
    fields.push(this.mrkdwn(`*워크플로우*\n\`${workflow}\``));

    const ctxBar = this.formatContextBar(data.usage);
    if (ctxBar) {
      fields.push(this.mrkdwn(`*컨텍스트*\n${ctxBar}`));
    }

    const linkParts = this.formatLinks(data.links);
    if (linkParts.length > 0) {
      fields.push(this.mrkdwn(`*링크*\n${linkParts.join(' · ')}`));
    }

    if (data.closed) {
      fields.push(this.mrkdwn(`*상태*\n_종료됨_`));
    }

    if (fields.length > 0) {
      blocks.push({ type: 'section', fields });
    }

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme I: Kanban — context separator + section
  // ---------------------------------------------------------------------------
  private static buildKanban(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const blocks: any[] = [];

    blocks.push(this.contextBlock([this.mrkdwn(`── ${title} ──`)]));

    const parts: string[] = [];
    if (owner) parts.push(`<@${data.ownerId || owner}>`);
    const workflow = data.workflow || 'default';
    parts.push(`\`${workflow}\``);
    if (data.model) parts.push(`\`${this.formatModelName(data.model)}\``);
    const ctxBar = this.formatContextBar(data.usage);
    if (ctxBar) parts.push(ctxBar);
    const linkParts = this.formatLinks(data.links);
    parts.push(...linkParts);
    if (data.closed) parts.push('_종료됨_');

    blocks.push({ type: 'section', text: this.mrkdwn(parts.join(' · ')) });
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme J: Timeline — time context top + header + context
  // ---------------------------------------------------------------------------
  private static buildTimeline(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const blocks: any[] = [];

    // Time context at top
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    blocks.push(this.contextBlock([this.mrkdwn(`🕐 ${timeStr}`)]));

    const headerText = owner ? `${owner} — ${title}` : title;
    blocks.push(this.headerBlock(headerText));

    const els: any[] = [];
    const mention = this.ownerMention(data);
    if (mention) els.push(mention);
    els.push(...this.metaElements(data));
    els.push(...this.linkElements(data));
    if (data.closed) els.push(this.mrkdwn('_종료됨_'));
    if (els.length > 0) blocks.push(this.contextBlock(els));

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme K: Progress — header + section with progress bar + context
  // ---------------------------------------------------------------------------
  private static buildProgress(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const headerText = owner ? `${owner} — ${title}` : title;
    const blocks: any[] = [this.headerBlock(headerText)];

    // Section: @mention + model + progress bar
    const secParts: string[] = [];
    if (data.ownerId) secParts.push(`<@${data.ownerId}>`);
    if (data.model) secParts.push(`\`${this.formatModelName(data.model)}\``);

    // Progress bar from context window usage
    if (data.usage && data.usage.contextWindow > 0) {
      const used = ContextWindowManager.computeUsedTokens(data.usage);
      const total = data.usage.contextWindow;
      const usedPct = Math.max(0, Math.min(100, (used / total) * 100));
      const filled = Math.round(usedPct / 10);
      const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
      secParts.push(`${bar} ${Math.round(usedPct)}%`);
    }

    if (data.closed) secParts.push('_종료됨_');
    if (secParts.length > 0) {
      blocks.push({ type: 'section', text: this.mrkdwn(secParts.join(' · ')) });
    }

    // Context: links
    const linkEls = this.linkElements(data);
    if (linkEls.length > 0) blocks.push(this.contextBlock(linkEls));

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Theme L: Notification — section with blockquote style
  // ---------------------------------------------------------------------------
  private static buildNotification(data: ThreadHeaderData): any[] {
    const title = this.resolveTitle(data);
    const owner = this.resolveOwner(data);
    const workflow = data.workflow || 'default';

    const lines: string[] = [];
    if (owner) {
      lines.push(`⚡ ${owner}이(가) ${title} 세션을 시작했습니다`);
    } else {
      lines.push(`⚡ ${title} 세션이 시작되었습니다`);
    }

    const metaParts: string[] = [`\`${workflow}\``];
    if (data.model) metaParts.push(`\`${this.formatModelName(data.model)}\``);
    const ctxBar = this.formatContextBar(data.usage);
    if (ctxBar) metaParts.push(ctxBar);
    lines.push(`> ${metaParts.join(' · ')}`);

    const linkParts = this.formatLinks(data.links);
    if (linkParts.length > 0) lines.push(`> ${linkParts.join(' · ')}`);
    if (data.closed) lines.push('> _종료됨_');

    return [{ type: 'section', text: this.mrkdwn(lines.join('\n')) }];
  }

  // ---------------------------------------------------------------------------
  // Public static helpers (unchanged)
  // ---------------------------------------------------------------------------

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
   * Returns "▓░░░░ 156k/1M (85%)" or undefined if no usage data.
   */
  static formatContextBar(usage?: SessionUsage): string | undefined {
    if (!usage || usage.contextWindow <= 0) return undefined;

    const used = ContextWindowManager.computeUsedTokens(usage);
    const total = usage.contextWindow;
    const remainingPercent = Math.max(0, Math.min(100, ((total - used) / total) * 100));
    const usedPercent = 100 - remainingPercent;

    // 5-segment bar
    const filledSegments = Math.round(usedPercent / 20);
    const bar = '▓'.repeat(filledSegments) + '░'.repeat(5 - filledSegments);

    const pct = Number.isInteger(remainingPercent) ? `${remainingPercent}` : remainingPercent.toFixed(1);
    return `${bar} ${this.formatTokenCount(used)}/${this.formatTokenCount(total)} (${pct}%)`;
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
