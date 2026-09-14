import { ContextWindowManager, type SessionUsage } from './context-window-manager';
import {
  getSurfaceLines,
  MAX_BAR_WIDTH,
  MAX_TEXT_OBJECT_CHARS,
  type SurfaceBarStyle,
  type SurfaceFieldConfig,
  type SurfaceLineConfig,
  type SurfaceTheme,
} from './surface-config';

export type { SessionUsage } from './context-window-manager';

export type WorkflowType = string;
export type SessionTheme = 'default' | 'compact' | 'minimal';

export interface SessionLink {
  url: string;
  type?: string;
  provider?: string;
  label?: string;
  title?: string;
  status?: string;
}

export interface SessionLinks {
  issue?: SessionLink;
  pr?: SessionLink;
  doc?: SessionLink;
}

export interface SessionLinkHistory {
  issues?: SessionLink[];
  prs?: SessionLink[];
  docs?: SessionLink[];
}

export interface ConversationSession {
  summaryTitle?: string;
  title?: string;
  workflow?: WorkflowType;
  ownerName?: string;
  ownerId?: string;
  links?: SessionLinks;
  linkHistory?: SessionLinkHistory;
  model?: string;
  usage?: SessionUsage;
}

const ONE_M_SUFFIX_RE = /\[1m\]$/i;
const STATUS_EMOJI: Record<string, string> = {
  'to do': '⬜',
  open: '⬜',
  backlog: '⬜',
  'in progress': '🔵',
  'in development': '🔵',
  'in review': '🟡',
  review: '🟡',
  done: '✅',
  closed: '✅',
  resolved: '✅',
  'pr:open': '🟢',
  'pr:draft': '⚪',
  'pr:merged': '🟣',
  'pr:closed': '🔴',
  'issue:open': '🟢',
  'issue:closed': '✅',
};

function hasOneMSuffix(model: string): boolean {
  return ONE_M_SUFFIX_RE.test(model);
}

function stripOneMSuffix(model: string): string {
  return model.replace(ONE_M_SUFFIX_RE, '');
}

function getStatusEmoji(status: string | undefined, linkType?: string): string {
  if (!status) return '';
  const key = linkType ? `${linkType}:${status.toLowerCase()}` : status.toLowerCase();
  return STATUS_EMOJI[key] || STATUS_EMOJI[status.toLowerCase()] || '';
}

/** Max links to display per type when the field config sets no `max` */
const MAX_LINKS_PER_TYPE = 5;

/** Slack hard limits enforced regardless of configuration */
const HEADER_MAX_CHARS = 150;
const CONTEXT_MAX_ELEMENTS = 10;
const MESSAGE_MAX_BLOCKS = 50;

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

  /**
   * Build the thread header payload from the resolved surface config.
   * Line composition comes from `ui.threadheader` (user config.json override
   * or built-in DEFAULT_UI_SURFACES parity presets) via getSurfaceLines.
   */
  static build(data: ThreadHeaderData): ThreadHeaderPayload {
    const theme = (data.theme || 'default') as SurfaceTheme;
    const textFallback = ThreadHeaderBuilder.buildTextFallback(data);
    const lines = getSurfaceLines('threadheader', theme);
    return { text: textFallback, blocks: ThreadHeaderBuilder.renderLines(lines, data) };
  }

  // ---------------------------------------------------------------------------
  // Generic line → block rendering
  // ---------------------------------------------------------------------------

  private static renderLines(lines: SurfaceLineConfig[], data: ThreadHeaderData): any[] {
    const blocks: any[] = [];

    for (const line of lines) {
      if (blocks.length >= MESSAGE_MAX_BLOCKS) break;

      // Explicit divider block, or a line whose only field(s) are `separator`
      const dividerOnly = line.fields.length > 0 && line.fields.every((f) => f.field === 'separator');
      if (line.block === 'divider' || dividerOnly) {
        blocks.push({ type: 'divider' });
        continue;
      }

      const values: string[] = [];
      for (const field of line.fields) {
        if (field.show === false || field.field === 'separator') continue;
        for (const raw of ThreadHeaderBuilder.renderField(field, data)) {
          const decorated = ThreadHeaderBuilder.decorate(raw, field);
          if (decorated) values.push(decorated);
        }
      }
      if (values.length === 0) continue; // fully-empty lines are omitted

      const separator = line.separator ?? ' ';
      switch (line.block ?? 'context') {
        case 'header':
          blocks.push({
            type: 'header',
            text: {
              type: 'plain_text',
              text: ThreadHeaderBuilder.truncateText(values.join(separator), HEADER_MAX_CHARS),
              emoji: true,
            },
          });
          break;
        case 'section':
          blocks.push({ type: 'section', text: ThreadHeaderBuilder.mrkdwn(values.join(separator)) });
          break;
        default: {
          // context — one mrkdwn element per rendered value, chunked to
          // Slack's 10-elements-per-context-block cap.
          for (let i = 0; i < values.length; i += CONTEXT_MAX_ELEMENTS) {
            if (blocks.length >= MESSAGE_MAX_BLOCKS) break;
            blocks.push({
              type: 'context',
              elements: values.slice(i, i + CONTEXT_MAX_ELEMENTS).map((v) => ThreadHeaderBuilder.mrkdwn(v)),
            });
          }
        }
      }
    }

    return blocks.slice(0, MESSAGE_MAX_BLOCKS);
  }

  /**
   * Produce the raw value(s) for a configured field.
   * Multi-value fields (links, linkhistory) yield one entry per link so
   * context blocks render them as separate elements.
   */
  private static renderField(field: SurfaceFieldConfig, data: ThreadHeaderData): string[] {
    switch (field.field) {
      case 'title': {
        if (field.format === 'headline') {
          const title = ThreadHeaderBuilder.resolveTitle(data);
          const owner = ThreadHeaderBuilder.resolveOwner(data);
          const emoji = data.closed ? '🔴' : '🟢';
          return [owner ? `${emoji} *${owner} — ${title}*` : `${emoji} *${title}*`];
        }
        return [ThreadHeaderBuilder.resolveTitle(data)];
      }
      case 'owner': {
        const format = field.format ?? 'mention';
        if (format === 'name') {
          const name = data.ownerName || data.ownerId;
          return name ? [name] : [];
        }
        if (format === 'both') {
          if (data.ownerId && data.ownerName) return [`<@${data.ownerId}> (${data.ownerName})`];
          if (data.ownerId) return [`<@${data.ownerId}>`];
          return data.ownerName ? [data.ownerName] : [];
        }
        // 'mention' (default): requires an id to be renderable
        return data.ownerId ? [`<@${data.ownerId}>`] : [];
      }
      case 'workflow':
        return [data.workflow || 'default'];
      case 'model':
        return data.model ? [ThreadHeaderBuilder.formatModelName(data.model)] : [];
      case 'contextwindow': {
        const bar = ThreadHeaderBuilder.formatContextBar(data.usage, field.bar);
        return bar ? [bar] : [];
      }
      case 'links':
        return ThreadHeaderBuilder.formatLinks(data.links);
      case 'linkhistory':
        return ThreadHeaderBuilder.formatAllLinks(data.linkHistory, data.links, field.max ?? MAX_LINKS_PER_TYPE);
      case 'status': {
        if (!data.closed) return [];
        return [field.format === 'closed-text' ? '_종료됨_' : '🔴 _종료됨_'];
      }
      default:
        // Unknown fields were already warn-filtered by surface-config
        // normalization; built-ins never hit this. Stay silent on the hot path.
        return [];
    }
  }

  /**
   * Apply per-field decorations to a rendered value:
   * truncate → style (code innermost, then bold/italic/strike) → label prefix
   * → prefixEmoji prefix. `color` is intentionally ignored — Slack mrkdwn has
   * no inline text color (no per-render warnings on this hot path).
   */
  private static decorate(value: string, field: SurfaceFieldConfig): string {
    if (!value) return '';
    let out = value;
    if (field.truncate) out = ThreadHeaderBuilder.truncateText(out, field.truncate);
    if (field.style?.code) out = `\`${out}\``;
    if (field.style?.bold) out = `*${out}*`;
    if (field.style?.italic) out = `_${out}_`;
    if (field.style?.strike) out = `~${out}~`;
    if (field.label) out = `${field.label} ${out}`;
    if (field.prefixEmoji) out = `${field.prefixEmoji} ${out}`;
    return out;
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

  private static truncateText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /**
   * Build a mrkdwn text object hard-capped at Slack's 3000-char text-object
   * limit. Per-option normalization bounds each config string, but many
   * bounded values joined on one line can still exceed the limit — an
   * over-long text object gets the whole message rejected by the API.
   */
  private static mrkdwn(text: string): any {
    return { type: 'mrkdwn', text: ThreadHeaderBuilder.truncateText(text, MAX_TEXT_OBJECT_CHARS) };
  }

  // ---------------------------------------------------------------------------
  // Link formatting
  // ---------------------------------------------------------------------------

  /**
   * Format all links from linkHistory (one string per link) with title and
   * status metadata, up to `maxPerType` per type with "+N more" overflow.
   * Falls back to active links if no history available.
   */
  private static formatAllLinks(
    linkHistory: SessionLinkHistory | undefined,
    activeLinks: SessionLinks | undefined,
    maxPerType: number,
  ): string[] {
    if (!linkHistory) {
      // Fallback: use active links only
      return ThreadHeaderBuilder.formatLinks(activeLinks);
    }

    const values: string[] = [];
    const groups: Array<{ links: SessionLink[]; emoji: string; noun: string }> = [
      { links: linkHistory.issues || [], emoji: '📋', noun: 'issues' },
      { links: linkHistory.prs || [], emoji: '🔀', noun: 'PRs' },
      { links: linkHistory.docs || [], emoji: '📄', noun: 'docs' },
    ];

    for (const { links, emoji, noun } of groups) {
      for (const link of links.slice(-maxPerType)) {
        values.push(ThreadHeaderBuilder.formatLinkWithMeta(link, emoji));
      }
      if (links.length > maxPerType) {
        values.push(`_+${links.length - maxPerType} more ${noun}_`);
      }
    }

    return values;
  }

  /**
   * Format a single link with its metadata (title + status emoji).
   * Example: "📋 <url|SOMA-123>: Fix login bug ✅"
   */
  private static formatLinkWithMeta(link: SessionLink, emoji: string): string {
    const label = link.label || link.url;
    let text = `${emoji} <${link.url}|${label}>`;
    if (link.title) {
      const truncated = link.title.length > 40 ? `${link.title.slice(0, 39)}…` : link.title;
      text += `: ${truncated}`;
    }
    if (link.status) {
      const statusEmoji = getStatusEmoji(link.status, link.type);
      text += ` ${statusEmoji || `[${link.status}]`}`;
    }
    return text;
  }

  /** Format active links only (labels; slack-message URLs skipped) */
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
   *
   * Examples:
   *   "claude-opus-4-6-20250414"  → "opus-4.6"
   *   "claude-opus-4-7[1m]"       → "opus-4.7 (1M)"
   *   "claude-sonnet-4-6"         → "sonnet-4.6"
   *
   * The `[1m]` suffix signals the 1M beta context variant; strip it before
   * base formatting and append " (1M)" to the result.
   */
  static formatModelName(model: string): string {
    const has1m = hasOneMSuffix(model);
    const base = has1m ? stripOneMSuffix(model) : model;
    const match = base.match(/claude-(\w+)-(\d+)-(\d+)/);
    const formatted = match
      ? `${match[1]}-${match[2]}.${match[3]}`
      : base.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    return has1m ? `${formatted} (1M)` : formatted;
  }

  /**
   * Format context window usage as a compact bar.
   * Returns "▓░░░░ 150k/1M (15% used)" or undefined if no usage data.
   * Bar styling (segment count / chars) is configurable; defaults to 5/▓/░.
   *
   * The percentage reports what is USED, agreeing with both the `150k/1M` pair
   * beside it and the fill of the bar. It used to report what was LEFT while
   * the bar filled by what was used, so a nearly-full window printed a
   * reassuring high number — and the turn-completion footer printed the
   * complement in an identical-looking string (issue #196). The `used` suffix
   * is not decoration: it is what makes the number unambiguous at a glance.
   */
  static formatContextBar(usage?: SessionUsage, barStyle?: SurfaceBarStyle): string | undefined {
    if (!usage || usage.contextWindow <= 0) return undefined;

    // Defensive clamp: normalizeField already bounds config-provided widths,
    // but callers can pass an arbitrary SurfaceBarStyle (DEFAULT_UI_SURFACES
    // bypasses normalize) — an unbounded width would throw in `''.repeat`.
    const width = Math.min(MAX_BAR_WIDTH, Math.max(1, Math.floor(barStyle?.width ?? 5)));
    const filledChar = barStyle?.filledChar ?? '▓';
    const emptyChar = barStyle?.emptyChar ?? '░';

    const used = ContextWindowManager.computeUsedTokens(usage);
    const total = usage.contextWindow;
    const usedPercent = 100 - Math.max(0, Math.min(100, ((total - used) / total) * 100));

    const filledSegments = Math.min(width, Math.max(0, Math.round((usedPercent / 100) * width)));
    const bar = filledChar.repeat(filledSegments) + emptyChar.repeat(width - filledSegments);

    const pct = Number.isInteger(usedPercent) ? `${usedPercent}` : usedPercent.toFixed(1);
    return `${bar} ${ThreadHeaderBuilder.formatTokenCount(used)}/${ThreadHeaderBuilder.formatTokenCount(total)} (${pct}% used)`;
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
