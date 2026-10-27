import { getVerbosityName } from './output-flags';

export type ActivityState = 'working' | 'waiting' | 'idle';

export type WorkflowType =
  | 'onboarding'
  | 'jira-executive-summary'
  | 'jira-brainstorming'
  | 'jira-planning'
  | 'jira-create-pr'
  | 'pr-review'
  | 'pr-fix-and-update'
  | 'pr-docs-confluence'
  | 'deploy'
  | 'default'
  | 'z-plan-to-work'
  | 'z-epic-update';

export interface PRStatusInfo {
  state: string; // 'open' | 'closed' | 'merged'
  mergeable: boolean;
  draft: boolean;
  merged: boolean;
  approved?: boolean; // true if PR has been approved
  head?: string; // source branch
  base?: string; // target branch
  /**
   * T2 — provenance of the fetch: the PR URL it was made for and the state the
   * session's stored link carried at that moment. {@link ActionPanelBuilder.livePrStatus}
   * uses them to refuse a status that belongs to another PR, or that predates
   * a re-recorded link.
   */
  fetchedForUrl?: string;
  linkStatusAtFetch?: string;
}

export interface ActionPanelBuildParams {
  sessionKey: string;
  workflow?: WorkflowType;
  disabled?: boolean;
  closed?: boolean;
  choiceBlocks?: any[];
  waitingForChoice?: boolean;
  choiceMessageLink?: string;
  latestResponseLink?: string;
  turnSummary?: string;
  activityState?: ActivityState;
  contextRemainingPercent?: number;
  hasActiveRequest?: boolean;
  statusUpdatedAt?: number;
  logVerbosity?: number;
  prStatus?: PRStatusInfo;
  /**
   * U9 — the step the agent is on, in its own words ("코드 수정 중"), as opposed
   * to the coarse `activityState` badge. Rendered next to the badge; a running
   * tool ({@link ActionPanelBuildParams.activeTool}) and an approval wait
   * outrank it (A19).
   */
  agentPhase?: string;
  /** U9 — the tool currently executing. Its own phase, distinct from `agentPhase`. */
  activeTool?: string;
  /**
   * U9 — when the work LAST ACTUALLY MOVED (a tool returned, a file was
   * written, output was produced). Supplied only by a caller that witnessed a
   * real progress event. Never derived from a heartbeat, a lifecycle
   * transition or a render: when it is absent the header states
   * `실제 활동 기록 없음` instead of printing a fabricated age (A19).
   */
  lastProgressAt?: number;
  /**
   * U9 — when the process last proved it was alive (heartbeat / stream signal).
   * Liveness is NOT progress: it renders as a separate statement, and only when
   * it says something the progress age does not (fresh signal + stale progress
   * = "alive but stuck").
   */
  lastSignalAt?: number;
  /**
   * Injected clock for the age calculations. Defaults to `Date.now()`; tests
   * pass a fixed value so the rendered strings are exact instead of flaky. The
   * builder stays pure.
   */
  now?: number;
}

export interface ActionPanelPayload {
  text: string;
  blocks: any[];
}

/**
 * U9 — how far the liveness signal must outrun the last real progress before
 * the header states it separately. Below this the two agree and a second line
 * would only be noise.
 */
const LIVENESS_DIVERGENCE_MS = 60_000;

export class ActionPanelBuilder {
  static build(params: ActionPanelBuildParams): ActionPanelPayload {
    const disabled = params.disabled ?? true;
    const workflow = params.workflow || 'default';

    // Closed state: status + divider + summary grid + footer
    if (params.closed) {
      return ActionPanelBuilder.buildClosedPanel(params);
    }

    const status = ActionPanelBuilder.resolveStatus({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      disabled,
    });

    const isQuestionPending = params.waitingForChoice === true;
    const isWorking = params.activityState === 'working' || params.hasActiveRequest === true;

    const closeButton = ActionPanelBuilder.buildCloseButton(params.sessionKey);

    // The surface carries exactly two controls: ⏸ 중지 while a turn runs, and
    // 세션 종료 always. The per-workflow buttons (New Fix / Renew Fix / PR 문서화 /
    // New·Renew 리뷰 / PR 승인 / Merge) were removed on 2026-10-27 — unused.
    const controls = isWorking ? [ActionPanelBuilder.buildStopButton(params.sessionKey), closeButton] : [closeButton];
    const actionRows = [{ type: 'actions', block_id: 'control_actions', elements: controls }];

    // The rail: ONE full-width section (T2, 2026-10-27, trinity-reviewed) —
    //   line 1  badge · step · progress age [· liveness]   (buildProgressLine)
    //   line 2  turn timers · PR state · latest response · verbosity
    //   line 3  the open question, when there is one
    // It used to be a 2-column `fields` grid with the PR chip in the right half,
    // which gave the state half the width and wrapped it mid-word; the question
    // and the controls each sat behind their own divider.
    const rail = ActionPanelBuilder.buildRail([
      ActionPanelBuilder.joinParts([
        ActionPanelBuilder.statusBadge(status),
        ActionPanelBuilder.buildProgressLine({
          status,
          waitingForChoice: params.waitingForChoice,
          activityState: params.activityState,
          hasActiveRequest: params.hasActiveRequest,
          agentPhase: params.agentPhase,
          activeTool: params.activeTool,
          lastProgressAt: params.lastProgressAt,
          lastSignalAt: params.lastSignalAt,
          now: params.now,
        }),
      ]),
      ActionPanelBuilder.joinParts([
        params.turnSummary,
        params.prStatus ? ActionPanelBuilder.prStatusChip(params.prStatus) : undefined,
        params.latestResponseLink ? `<${params.latestResponseLink}|💬 최신 응답>` : undefined,
        params.logVerbosity !== undefined ? ActionPanelBuilder.verbosityLabel(params.logVerbosity) : undefined,
      ]),
      isQuestionPending ? ActionPanelBuilder.choiceLine(params.choiceMessageLink) : undefined,
    ]);

    return {
      text: `Action panel (${workflow}) - ${status}`,
      blocks: [rail, ...actionRows],
    };
  }

  /**
   * The PR status the surface may show as LIVE for the session's active PR link
   * — or `undefined`. A fetched status is live only while it still describes
   * that link: fetched for the same URL, and the link has not been re-recorded
   * with a different state since (re-recording rewrites the stored status; the
   * cache would otherwise contradict it for up to its TTL). One rule for the
   * rail chip and the link row, on every composition path (T2).
   */
  static livePrStatus(
    prLink: { url?: string; status?: string } | undefined,
    prStatus: Partial<PRStatusInfo> | undefined,
  ): PRStatusInfo | undefined {
    if (!prLink?.url || !prStatus || prStatus.fetchedForUrl !== prLink.url) return undefined;
    if ((prStatus.linkStatusAtFetch ?? '') !== (prLink.status ?? '')) return undefined;
    return prStatus as PRStatusInfo;
  }

  /**
   * Place the panel into the header (T2). The rail goes right after the first
   * non-divider header block — the title in every preset — then the rest of the
   * header, then the controls. Header blocks are never split or reordered; an
   * empty header puts the rail first. Every surface composition (live, closed,
   * and the close fallbacks) goes through here so they cannot drift apart.
   */
  static compose(headerBlocks: any[], panelBlocks: any[]): any[] {
    const [rail, ...rest] = panelBlocks;
    if (!rail) return [...headerBlocks];
    const first = headerBlocks.findIndex((block) => block?.type !== 'divider');
    if (first < 0) return [rail, ...headerBlocks, ...rest];
    return [...headerBlocks.slice(0, first + 1), rail, ...headerBlocks.slice(first + 1), ...rest];
  }

  private static buildRail(lines: Array<string | undefined>): any {
    const text = lines.filter((line): line is string => Boolean(line)).join('\n');
    return { type: 'section', text: { type: 'mrkdwn', text } };
  }

  private static joinParts(parts: Array<string | null | undefined>): string | undefined {
    const present = parts.filter((part): part is string => Boolean(part));
    return present.length > 0 ? present.join(' · ') : undefined;
  }

  private static choiceLine(choiceMessageLink?: string): string {
    return choiceMessageLink ? `❓ 질문에 답변해 주세요 — <${choiceMessageLink}|질문 보기>` : '❓ 질문에 답변해 주세요';
  }

  private static resolveStatus(params: {
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    disabled: boolean;
    closed?: boolean;
  }): string {
    if (params.closed) {
      return '종료됨';
    }

    if (params.waitingForChoice) {
      return '입력 대기';
    }

    if (params.activityState === 'working') {
      return '작업 중';
    }

    if (params.hasActiveRequest) {
      return '요청 처리 중';
    }

    if (params.activityState === 'waiting') {
      return '대기 중';
    }

    if (params.disabled) {
      return '비활성';
    }

    return '사용 가능';
  }

  /**
   * U9 — `단계 · 마지막 활동 N초 전 [· 응답 신호 N초 전]`.
   *
   * Three independent facts, never collapsed (A19):
   *   - the STEP, chosen by priority: approval wait > running tool > agentPhase;
   *   - the age of the last REAL progress event, or `실제 활동 기록 없음` when the
   *     caller never witnessed one — no time is ever invented;
   *   - LIVENESS, and only when it disagrees with progress (a fresh heartbeat
   *     against a stale progress = alive but stuck).
   *
   * Nothing here predicts: no ETA, no remaining time, no percentage.
   * Returns `null` when there is nothing to say (e.g. an idle session that has
   * never reported a phase).
   */
  private static buildProgressLine(params: {
    status: string;
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
    lastProgressAt?: number;
    lastSignalAt?: number;
    now?: number;
  }): string | null {
    const phase = ActionPanelBuilder.resolvePhase(params);
    const isLive =
      params.waitingForChoice === true ||
      params.activityState === 'working' ||
      params.activityState === 'waiting' ||
      params.hasActiveRequest === true;

    // A dormant session with nothing reported has no story to tell; the badge
    // alone is honest.
    if (!phase && !isLive) return null;

    const now = params.now ?? Date.now();
    const parts: string[] = [];
    if (phase) parts.push(phase);

    parts.push(
      params.lastProgressAt === undefined
        ? '실제 활동 기록 없음'
        : `마지막 활동 ${ActionPanelBuilder.formatAge(now - params.lastProgressAt)} 전`,
    );

    // Liveness earns its own words whenever it adds information:
    //   - progress KNOWN: only once the signal has outrun it (alive but stuck);
    //   - progress UNKNOWN: always — "is it even alive?" is then the only
    //     question left, and suppressing the one real timestamp we do have
    //     would leave the user with nothing (review round 1).
    const livenessAdds =
      params.lastSignalAt !== undefined &&
      (params.lastProgressAt === undefined || params.lastSignalAt - params.lastProgressAt >= LIVENESS_DIVERGENCE_MS);
    if (livenessAdds) {
      parts.push(`응답 신호 ${ActionPanelBuilder.formatAge(now - (params.lastSignalAt as number))} 전`);
    }

    return parts.join(' · ');
  }

  /** Approval wait > running tool > declared phase. The thing the user must act on wins. */
  private static resolvePhase(params: {
    waitingForChoice?: boolean;
    agentPhase?: string;
    activeTool?: string;
  }): string | null {
    if (params.waitingForChoice) return null; // the badge already says 입력 대기
    if (params.activeTool) return `🔧 ${params.activeTool}`;
    return params.agentPhase || null;
  }

  /**
   * Coarse, non-negative age. A stamp from the future (clock skew between the
   * reporting worker and the renderer) reads as `0초`, never as a negative age.
   */
  private static formatAge(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}초`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간`;
    return `${Math.floor(hours / 24)}일`;
  }

  /** The log verbosity is a setting, not a state: a plain code chip, no emoji (T2). */
  private static verbosityLabel(mask: number): string {
    return `\`${getVerbosityName(mask)}\``;
  }

  /**
   * Session-state badge. The circles 🟢🟡⚪⚫ mean session state and nothing
   * else on the surface, and every badge is bold — the state is the first thing
   * to read, whichever state it is (T2).
   */
  private static statusBadge(status: string): string {
    switch (status) {
      case '작업 중':
      case '요청 처리 중':
        return `🟢 *${status}*`;
      case '입력 대기':
        return `🟡 *${status}*`;
      case '종료됨':
        return `⚫ *${status}*`;
      case '사용 가능':
      case '대기 중':
        return `⚪ *${status}*`;
      default:
        return '⚪ *대기*';
    }
  }

  /**
   * PR state as a word behind the 🔀 kind glyph — never a colour dot, which
   * would collide with the session badge (T2).
   */
  private static prStatusChip(prStatus: PRStatusInfo): string | undefined {
    if (prStatus.merged) return '🔀 Merged';
    if (prStatus.draft) return '🔀 Draft';
    if (prStatus.state === 'closed') return '🔀 Closed';
    if (prStatus.approved && prStatus.mergeable) return '🔀 Approved · Merge 가능';
    if (prStatus.approved) return '🔀 Approved';
    if (prStatus.mergeable) return '🔀 Merge 가능';
    if (prStatus.state === 'open') return '🔀 ⚠️ Merge 불가';
    return undefined;
  }

  private static buildCloseButton(sessionKey: string): any {
    return {
      type: 'button',
      text: { type: 'plain_text', text: '세션 종료', emoji: true },
      action_id: 'panel_close',
      style: 'danger',
      value: JSON.stringify({ sessionKey, action: 'close' }),
      confirm: {
        title: { type: 'plain_text', text: '세션 종료' },
        text: { type: 'mrkdwn', text: '세션을 종료하시겠습니까?\n이 작업은 되돌릴 수 없습니다.' },
        confirm: { type: 'plain_text', text: '종료' },
        deny: { type: 'plain_text', text: '취소' },
      },
    };
  }

  private static buildStopButton(sessionKey: string): any {
    return {
      type: 'button',
      text: { type: 'plain_text', text: '⏸ 중지', emoji: true },
      action_id: 'panel_stop',
      value: JSON.stringify({ sessionKey, action: 'stop' }),
    };
  }

  /**
   * Closed rail: the same single section, in the same place as the live one —
   *   line 1  `⚫ *종료됨* · MM-DD HH:MM 종료`
   *   line 2  turn summary (verbatim) · PR state · latest response
   * It used to be a hero row, a divider, a `*작업 요약*` grid re-parsed out of
   * the turn summary, and a context footer. No controls: the session is gone.
   */
  private static buildClosedPanel(params: ActionPanelBuildParams): ActionPanelPayload {
    const workflow = params.workflow || 'default';
    const closedAt = `${ActionPanelBuilder.formatCloseTimestamp(params.now ?? Date.now())} 종료`;
    const rail = ActionPanelBuilder.buildRail([
      ActionPanelBuilder.joinParts([ActionPanelBuilder.statusBadge('종료됨'), closedAt]),
      ActionPanelBuilder.joinParts([
        params.turnSummary,
        params.prStatus ? ActionPanelBuilder.prStatusChip(params.prStatus) : undefined,
        params.latestResponseLink ? `<${params.latestResponseLink}|💬 최신 응답>` : undefined,
      ]),
    ]);

    return {
      text: `Action panel (${workflow}) - 종료됨`,
      blocks: [rail],
    };
  }

  private static formatCloseTimestamp(nowMs: number): string {
    const now = new Date(nowMs);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }
}
