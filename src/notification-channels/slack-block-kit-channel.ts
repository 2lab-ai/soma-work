/**
 * Slack Block Kit notification channel — posts colored status message to thread.
 * Trace: docs/turn-notification/trace.md, Scenario 1 (Section 3c)
 * Trace: docs/rich-turn-notification/trace.md, Scenario 3
 * Always enabled — this is the default in-thread visual feedback.
 *
 * Block composition is config-driven: the `ui.turnend` surface config
 * (packages/slack/src/surface-config.ts) declares WHICH fields render on
 * WHICH lines per theme; this channel owns the field → value mapping from
 * `TurnCompletionEvent`. With no operator config, `getSurfaceLines` resolves
 * to `DEFAULT_UI_SURFACES.turnend`, which mirrors the historical hardcoded
 * default/compact/minimal builders exactly (parity test-locked in
 * src/__tests__/slack-block-kit-channel-config.test.ts).
 */

import {
  DEFAULT_UI_SURFACES,
  getSurfaceLines,
  getUiSurfacesConfig,
  MAX_BAR_WIDTH,
  MAX_TEXT_OBJECT_CHARS,
  type SurfaceFieldConfig,
  type SurfaceLineConfig,
} from '@soma/slack/surface-config';
import { buildFeedbackContextActions } from '@soma/slack/turn-feedback-block-builder';
import { Logger } from '../logger.js';
import type { CompletionMessageTracker } from '../slack/completion-message-tracker.js';
import {
  buildThreadPermalink,
  getCategoryColor,
  getCategoryEmoji,
  getCategoryLabel,
  type NotificationChannel,
  type TurnCompletionEvent,
} from '../turn-notifier.js';
import { type SessionTheme, userSettingsStore } from '../user-settings-store.js';

const logger = new Logger('SlackBlockKitChannel');

/** Stable identifier for `TurnNotifier.notify({ excludeChannelNames: [...] })` and future filters. */
const SLACK_BLOCK_KIT_CHANNEL_NAME = 'slack-block-kit';

/**
 * Slack `section.text` hard limit is 3000 chars. We cap below that to leave
 * room for the markdown code fence (```\n + \n```) plus a "truncated"
 * marker so callers can tell the body was clipped. PROJ-4318 / soma-work#933.
 */
const EXCEPTION_BODY_MAX_CHARS = 2900;
const EXCEPTION_HEADER_SUFFIX_MAX_CHARS = 200;

/** Slack hard limit: ≤50 blocks per message. Enforced regardless of config. */
const MAX_BLOCKS = 50;

/** Slack `header` block plain_text limit. */
const HEADER_TEXT_MAX_CHARS = 150;

/**
 * Fields whose renderer consumes `field.label` itself (placement is
 * value-specific, e.g. "Ctx ▓▓▓░░ …" puts the label before the bar).
 * The generic decorator must NOT prefix the label again for these.
 */
const LABEL_CONSUMING_FIELDS = new Set(['contextwindow', 'duration', 'fivehour', 'sevenday', 'separator']);

/**
 * Fields whose renderer consumes `field.truncate` itself (errorbody applies
 * it to the raw message before fencing, with its own `…(truncated)` marker).
 */
const TRUNCATE_CONSUMING_FIELDS = new Set(['errorbody']);

export class SlackBlockKitChannel implements NotificationChannel {
  name = SLACK_BLOCK_KIT_CHANNEL_NAME;

  constructor(
    private slackApi: { postMessage: (channel: string, text: string, options?: any) => Promise<any> },
    private completionMessageTracker?: CompletionMessageTracker,
  ) {}

  async isEnabled(_userId: string): Promise<boolean> {
    return true; // Always enabled — core UX
  }

  async send(event: TurnCompletionEvent): Promise<void> {
    const color = getCategoryColor(event.category);
    const emoji = getCategoryEmoji(event.category);
    const label = getCategoryLabel(event.category);

    // Turn-end surface guarantee: the terminal card must NEVER be lost to a
    // render bug. Config is clamped at normalize time, but any unexpected
    // throw during theme/lines resolution or block building falls back to
    // the built-in default line composition instead of killing the card.
    let blocks: any[];
    let usedConfigDerivedBlocks = false;
    try {
      const theme = userSettingsStore.getUserSessionTheme(event.userId);
      blocks = this.buildBlocksFromConfig(theme, event, emoji, label);
      usedConfigDerivedBlocks = true;
    } catch (renderError: any) {
      logger.warn('Turn-end card rendering threw with active ui config — falling back to built-in defaults', {
        userId: event.userId,
        category: event.category,
        error: renderError?.message,
      });
      blocks = this.buildBlocksFromLines(DEFAULT_UI_SURFACES.turnend?.lines ?? [], event, emoji, label);
    }

    // Slack requires a non-empty `text` fallback when blocks/attachments are present
    // (empty text silently drops the message on some clients and breaks accessibility).
    // For Exception cards, prefer the actual error message so the fallback
    // text (used in notification previews) reflects the real reason rather
    // than a stale workflow title.
    const fallbackText = this.pickHeaderSuffix(event) || event.sessionTitle || event.category;

    // #1064 — agent-workflow feedback affordance. `context_actions` /
    // `feedback_buttons` are NOT reliably rendered inside legacy message
    // attachments (codex c411a78a), so the success card that carries feedback
    // is posted as TOP-LEVEL blocks instead of an attachment. Only
    // WorkflowComplete gets feedback — feedback on Exception/Stalled/Ask cards
    // is noise. Requires a turnId to key the feedback record on.
    const withFeedback = event.category === 'WorkflowComplete' && typeof event.turnId === 'string' && !!event.turnId;
    const buildPostOptions = (blks: any[]) =>
      withFeedback
        ? { threadTs: event.threadTs, blocks: [...blks, buildFeedbackContextActions(event.turnId!, event.userId)] }
        : { threadTs: event.threadTs, attachments: [{ color, blocks: blks }] };

    try {
      const result = await this.slackApi.postMessage(event.channel, fallbackText, buildPostOptions(blocks));
      this.trackCompletionMessage(result, event);
    } catch (error: any) {
      // Turn-end surface guarantee, API leg: a custom `ui.turnend` config can
      // produce blocks the Slack API itself rejects (e.g. `invalid_blocks`) —
      // clamps catch per-option abuse, but the API is the final judge. When
      // the failed attempt used config-derived blocks AND a custom turnend
      // config is active, retry ONCE with the built-in default lines so the
      // terminal card is not lost. No custom config → no behavior change.
      //
      // Gate strictly on Slack's `invalid_blocks` rejection: rate_limited /
      // auth / network errors must NOT trigger an immediate second post
      // (429 backoff guardrail — retrying those with default blocks would
      // both violate Retry-After and not fix anything).
      const slackErrorCode = error?.data?.error;
      if (slackErrorCode === 'invalid_blocks' && usedConfigDerivedBlocks && getUiSurfacesConfig().turnend) {
        logger.warn('postMessage rejected config-derived turn-end blocks — retrying once with built-in defaults', {
          channel: event.channel,
          threadTs: event.threadTs,
          userId: event.userId,
          category: event.category,
          error: error.message,
        });
        try {
          const defaultBlocks = this.buildBlocksFromLines(
            DEFAULT_UI_SURFACES.turnend?.lines ?? [],
            event,
            emoji,
            label,
          );
          const result = await this.slackApi.postMessage(event.channel, fallbackText, buildPostOptions(defaultBlocks));
          this.trackCompletionMessage(result, event);
          return;
        } catch (retryError: any) {
          this.warnPostFailed(event, retryError);
          return;
        }
      }
      this.warnPostFailed(event, error);
    }
  }

  /**
   * Track the actual posted notification message ts for auto-deletion.
   * Previously tracked in stream-executor using threadTs (thread root),
   * which for bot-initiated threads IS the surface/header message —
   * causing header deletion on next user input.
   * Trace: docs/archive/features/turn-summary-lifecycle/trace.md, S6
   * Exception (real error) and Stalled (timeout / investigation queue)
   * both persist — track() will also skip them defense-in-depth, but
   * checking here avoids the unnecessary map lookup.
   */
  private trackCompletionMessage(result: any, event: TurnCompletionEvent): void {
    if (this.completionMessageTracker && result?.ts && event.category !== 'Exception' && event.category !== 'Stalled') {
      const sessionKey = `${event.channel}-${event.threadTs}`;
      this.completionMessageTracker.track(sessionKey, result.ts, event.category);
    }
  }

  private warnPostFailed(event: TurnCompletionEvent, error: any): void {
    logger.warn('Failed to post Block Kit notification', {
      channel: event.channel,
      threadTs: event.threadTs,
      userId: event.userId,
      category: event.category,
      error: error.message,
    });
  }

  // --- Config-driven block composition ---

  /**
   * Render the turn-end card from the resolved `ui.turnend` line composition
   * for the user's theme. Empty lines are omitted; the Slack ≤50-block hard
   * limit is enforced regardless of configuration.
   */
  private buildBlocksFromConfig(theme: SessionTheme, event: TurnCompletionEvent, emoji: string, label: string): any[] {
    return this.buildBlocksFromLines(getSurfaceLines('turnend', theme), event, emoji, label);
  }

  /** Render blocks from an explicit line composition (also the send() fallback path). */
  private buildBlocksFromLines(
    lines: SurfaceLineConfig[],
    event: TurnCompletionEvent,
    emoji: string,
    label: string,
  ): any[] {
    const blocks: any[] = [];

    for (const line of lines) {
      if (blocks.length >= MAX_BLOCKS) break;
      const blockType = line.block ?? 'context';

      if (blockType === 'divider') {
        blocks.push({ type: 'divider' });
        continue;
      }

      const text = this.renderLineText(line, event, emoji, label);
      if (!text) continue;

      if (blockType === 'section') {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: this.capTextObject(text) } });
      } else if (blockType === 'header') {
        blocks.push({ type: 'header', text: { type: 'plain_text', text: text.slice(0, HEADER_TEXT_MAX_CHARS) } });
      } else {
        // 'context' — parity note: a whole line is ONE mrkdwn element (the
        // historical builders joined row parts into a single element, not
        // one element per field).
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: this.capTextObject(text) }] });
      }
    }

    return blocks;
  }

  /**
   * Hard-cap a section / context text object at Slack's 3000-char limit.
   * Per-option normalization bounds each config string, but many bounded
   * values joined on one line can still exceed the limit — an over-long
   * text object gets the whole message rejected AFTER postMessage.
   */
  private capTextObject(text: string): string {
    return text.length > MAX_TEXT_OBJECT_CHARS ? `${text.slice(0, MAX_TEXT_OBJECT_CHARS - 1)}…` : text;
  }

  /**
   * Join a line's rendered field values into one mrkdwn string.
   *
   * Joining rule (parity with the historical header line
   * `${status}${suffix ? ' — ' + suffix : ''}${threadlink}`): `title` and
   * `threadlink` are SELF-SEPARATING — when preceded by any non-empty value
   * on the same line they supply their own ' — ' / ' · ' joiners instead of
   * the line's generic `separator`. All other fields join with
   * `line.separator ?? ''`.
   */
  private renderLineText(line: SurfaceLineConfig, event: TurnCompletionEvent, emoji: string, label: string): string {
    const separator = line.separator ?? '';
    let text = '';

    for (const field of line.fields) {
      if (field.show === false) continue;
      const value = this.renderFieldValue(field, event, emoji, label);
      if (!value) continue;
      const decorated = this.decorateFieldValue(field, value);

      if (text.length === 0) {
        text = decorated;
      } else if (field.field === 'title') {
        text += ` — ${decorated}`;
      } else if (field.field === 'threadlink') {
        text += ` · ${decorated}`;
      } else {
        text += separator + decorated;
      }
    }

    return text;
  }

  /**
   * Generic per-field decorations: truncate → style (bold/italic/code/strike)
   * → label prefix → emoji prefix. Label/truncate are skipped for fields
   * whose renderer already consumed them (see the *_CONSUMING_FIELDS sets).
   */
  private decorateFieldValue(field: SurfaceFieldConfig, value: string): string {
    let v = value;
    if (
      typeof field.truncate === 'number' &&
      field.truncate > 0 &&
      !TRUNCATE_CONSUMING_FIELDS.has(field.field) &&
      v.length > field.truncate
    ) {
      v = `${v.slice(0, Math.max(0, field.truncate - 1))}…`;
    }
    if (field.style?.code) v = `\`${v}\``;
    if (field.style?.bold) v = `*${v}*`;
    if (field.style?.italic) v = `_${v}_`;
    if (field.style?.strike) v = `~${v}~`;
    if (field.label && !LABEL_CONSUMING_FIELDS.has(field.field)) v = `${field.label} ${v}`;
    if (field.prefixEmoji) v = `${field.prefixEmoji} ${v}`;
    return v;
  }

  /**
   * Registry field → string value from the event. Empty string = skip
   * (the field contributes nothing to its line).
   */
  private renderFieldValue(
    field: SurfaceFieldConfig,
    event: TurnCompletionEvent,
    emoji: string,
    label: string,
  ): string {
    switch (field.field) {
      case 'status':
        return this.renderStatus(field, event, emoji, label);
      case 'title':
        return this.pickHeaderSuffix(event);
      case 'threadlink': {
        const permalink = buildThreadPermalink(event.channel, event.threadTs);
        return permalink ? `<${permalink}|🧵 스레드 열기>` : '';
      }
      case 'errorbody':
        return this.renderErrorBody(field, event);
      case 'persona':
        return event.persona ?? '';
      case 'model': {
        if (!event.model) return '';
        return field.format === 'with-effort' && event.effort ? `${event.model} | ${event.effort}` : event.model;
      }
      case 'effort':
        return event.effort ?? '';
      case 'startedat':
        return event.startedAt ? this.formatClock(event.startedAt) : '';
      case 'contextwindow':
        return this.renderContextWindow(field, event);
      case 'duration':
        return event.durationMs ? `${field.label ? `${field.label} ` : ''}${this.formatElapsed(event.durationMs)}` : '';
      case 'fivehour':
        return this.renderUsageGauge(field, event.fiveHourUsage, event.fiveHourDelta, 6);
      case 'sevenday':
        return this.renderUsageGauge(field, event.sevenDayUsage, event.sevenDayDelta, 8);
      case 'toolstats':
        return this.renderToolStats(field, event);
      case 'separator':
        // Literal inline separator text — renders only when the operator
        // supplies a label (never invented).
        return field.label ?? '';
      default:
        return ''; // unknown fields are already filtered by the normalizer
    }
  }

  /**
   * `status` — default `${emoji} *${label}*`; format 'plain' drops the bold
   * and (minimal-theme parity) appends the short error reason for Exception
   * cards ONLY (not Stalled — historical buildMinimalBlocks behavior).
   */
  private renderStatus(field: SurfaceFieldConfig, event: TurnCompletionEvent, emoji: string, label: string): string {
    if (field.format === 'plain') {
      const headerSuffix = this.pickHeaderSuffix(event);
      const suffix = headerSuffix && event.category === 'Exception' ? ` — ${headerSuffix}` : '';
      return `${emoji} ${label}${suffix}`;
    }
    return `${emoji} *${label}*`;
  }

  /**
   * Choose the suffix that follows the "{emoji} *{label}*" header.
   *
   * Bug fix: Exception cards used to show `event.sessionTitle` in the header,
   * but `sessionTitle` reflects the workflow that was running (e.g. "Session
   * Reset" left over from an earlier `/z reset`) — NOT the error reason.
   * `handleError()` in `stream-executor.ts` already passes a friendly error
   * reason via `event.message` (e.g. `이전 턴이 일정 시간 응답이 없어 중단되었습니다.`),
   * but the renderer was silently dropping it. For Exception, prefer
   * `event.message` and only fall back to `sessionTitle` when message is
   * absent. Non-Exception categories keep the existing sessionTitle-only
   * behavior so success/UIUserAskQuestion cards are unchanged.
   *
   * Returns the empty string when no suffix is available — the line joiner
   * inserts the " — " separator only for non-empty values.
   *
   * PROJ-4318 / soma-work#933: the header suffix is now intentionally short
   * (first line of the error reason, capped at {@link EXCEPTION_HEADER_SUFFIX_MAX_CHARS}).
   * The full message body — multi-line API errors, stack traces, etc. —
   * goes into a separate section rendered by the `errorbody` field.
   */
  private pickHeaderSuffix(event: TurnCompletionEvent): string {
    // Exception AND Stalled both surface the full diagnostic message in
    // the body block — keep the header suffix to the first line so the
    // Slack notification preview stays readable.
    if (event.category === 'Exception' || event.category === 'Stalled') {
      const message = event.message?.trim();
      if (message) {
        const firstLine = message.split(/\r?\n/, 1)[0] ?? message;
        return firstLine.length > EXCEPTION_HEADER_SUFFIX_MAX_CHARS
          ? `${firstLine.slice(0, EXCEPTION_HEADER_SUFFIX_MAX_CHARS - 1)}…`
          : firstLine;
      }
      return event.sessionTitle?.trim() || '';
    }
    return event.sessionTitle?.trim() || '';
  }

  /**
   * `errorbody` — Exception/Stalled-only full diagnostic message in a
   * markdown code fence so:
   *  - newlines render verbatim (so multi-line API errors stay multi-line)
   *  - model-generated `*`/`_`/`>` characters in the error don't accidentally
   *    trigger Slack mrkdwn formatting
   *  - long bodies are visually distinct from the rich-context lines
   *
   * Capped at `field.truncate ?? EXCEPTION_BODY_MAX_CHARS` chars (well under
   * Slack's 3000-char `section.text` limit) with an explicit `…(truncated)`
   * marker so users know when the body was clipped.
   *
   * PROJ-4318 / soma-work#933 — the full error text was previously dropped
   * by the renderer, leaving users with only the stale `sessionTitle` in
   * the header. This field restores end-to-end visibility.
   */
  private renderErrorBody(field: SurfaceFieldConfig, event: TurnCompletionEvent): string {
    // Both Exception (real error) and Stalled (timeout = code-bug signal)
    // surface their full diagnostic message in a fenced body block.
    if (event.category !== 'Exception' && event.category !== 'Stalled') return '';
    const message = event.message?.trim();
    if (!message) return '';

    // Hard cap regardless of config: the fenced body must stay under Slack's
    // 3000-char `section.text` limit including the ``` fence overhead.
    const maxChars = Math.min(field.truncate ?? EXCEPTION_BODY_MAX_CHARS, EXCEPTION_BODY_MAX_CHARS);
    let body = message;
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n…(truncated)`;
    }

    return `\`\`\`\n${body}\n\`\`\``;
  }

  /**
   * `contextwindow` — default: `Ctx ▓▓▓▓░ 160.3k/1M (84.0%) -5.6`;
   * format 'percent': `Ctx 84.0%` (label/decimals from config; the minimal
   * preset has no label → `84.0%`).
   */
  private renderContextWindow(field: SurfaceFieldConfig, event: TurnCompletionEvent): string {
    if (typeof event.contextUsagePercent !== 'number') return '';
    const labelPrefix = field.label ? `${field.label} ` : '';
    const decimals = field.decimals ?? 1;

    if (field.format === 'percent') {
      return `${labelPrefix}${event.contextUsagePercent.toFixed(decimals)}%`;
    }

    const bar = this.renderBar(
      event.contextUsagePercent,
      field.bar?.width ?? 5,
      field.bar?.filledChar,
      field.bar?.emptyChar,
    );
    const tokensStr =
      typeof event.contextUsageTokens === 'number' && typeof event.contextWindowSize === 'number'
        ? `${this.formatTokens(event.contextUsageTokens)}/${this.formatTokens(event.contextWindowSize)} `
        : '';
    const deltaStr = this.formatSignedDelta(event.contextUsageDelta, decimals);
    const deltaSuffix = deltaStr ? ` ${deltaStr}` : '';
    return `${labelPrefix}${bar} ${tokensStr}(${event.contextUsagePercent.toFixed(decimals)}%)${deltaSuffix}`;
  }

  /**
   * `fivehour` / `sevenday` — `${label} ${bar} ${pct}%${delta}` gauge with
   * config-driven bar width (defaults 6 / 8 for historical parity).
   */
  private renderUsageGauge(
    field: SurfaceFieldConfig,
    usage: number | undefined,
    delta: number | undefined,
    defaultWidth: number,
  ): string {
    if (typeof usage !== 'number') return '';
    const decimals = field.decimals ?? 0;
    const bar = this.renderBar(usage, field.bar?.width ?? defaultWidth, field.bar?.filledChar, field.bar?.emptyChar);
    const pct = decimals > 0 ? usage.toFixed(decimals) : String(Math.round(usage));
    const deltaStr = this.formatSignedDelta(delta, decimals);
    const labelPrefix = field.label ? `${field.label} ` : '';
    return `${labelPrefix}${bar} ${pct}%${deltaStr ? ` ${deltaStr}` : ''}`;
  }

  /**
   * `toolstats` — default: rich top-N (`field.max ?? 5`) list, wrench emoji
   * supplied by the generic `prefixEmoji` decoration; format 'summary':
   * `🔧 N tools×M` one-liner for lighter themes.
   */
  private renderToolStats(field: SurfaceFieldConfig, event: TurnCompletionEvent): string {
    const stats = event.toolStats;
    if (!stats || Object.keys(stats).length === 0) return '';

    if (field.format === 'summary') {
      const entries = Object.entries(stats);
      const totalCount = entries.reduce((sum, [, s]) => sum + s.count, 0);
      return `🔧 ${entries.length} tools×${totalCount}`;
    }

    const entries = Object.entries(stats).sort((a, b) => b[1].totalDurationMs - a[1].totalDurationMs);
    const max = field.max ?? 5;
    const parts = entries.slice(0, max).map(([name, s]) => {
      const shortName = name.startsWith('mcp__') ? name.split('__').slice(1, 3).join(':') : name;
      const durationSec = (s.totalDurationMs / 1000).toFixed(1);
      return `${shortName}×${s.count}: ${durationSec}s`;
    });

    if (entries.length > max) {
      const remaining = entries.slice(max).reduce((sum, [, s]) => sum + s.count, 0);
      parts.push(`+${remaining} more`);
    }

    return parts.join(' | ');
  }

  // --- Utility functions ---

  private formatClock(date: Date): string {
    return date.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  }

  private formatElapsed(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  private renderBar(percent: number, width: number, filledChar = '▓', emptyChar = '░'): string {
    // Defensive width clamp: normalizeField bounds config widths, but
    // DEFAULT_UI_SURFACES / direct callers bypass normalize — an unbounded
    // width would throw in `''.repeat`.
    const safeWidth = Math.min(MAX_BAR_WIDTH, Math.max(1, Math.floor(width)));
    const clamped = Math.max(0, Math.min(100, percent));
    const filled = Math.round((clamped / 100) * safeWidth);
    return filledChar.repeat(filled) + emptyChar.repeat(safeWidth - filled);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
      const val = tokens / 1_000_000;
      return Number.isInteger(val) ? `${val}M` : `${val.toFixed(1)}M`;
    }
    const val = tokens / 1_000;
    return `${val.toFixed(1)}k`;
  }

  private formatSignedDelta(delta: number | undefined, decimals: number): string | undefined {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return undefined;
    const sign = delta >= 0 ? '+' : '';
    return decimals > 0 ? `${sign}${delta.toFixed(decimals)}` : `${sign}${Math.round(delta)}`;
  }
}
