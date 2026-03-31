import type { ActivityState, WorkflowType } from '../types';
import { getVerbosityName, type LogVerbosity } from './output-flags';

export interface PRStatusInfo {
  state: string; // 'open' | 'closed' | 'merged'
  mergeable: boolean;
  draft: boolean;
  merged: boolean;
  approved?: boolean; // true if PR has been approved
  head?: string; // source branch
  base?: string; // target branch
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
  agentPhase?: string;
  activeTool?: string;
  statusUpdatedAt?: number;
  logVerbosity?: number;
  prStatus?: PRStatusInfo;
  prUrl?: string;
}

export interface ActionPanelPayload {
  text: string;
  blocks: any[];
}

type PanelActionKey =
  | 'pr_fix_new'
  | 'pr_fix_renew'
  | 'pr_review_new'
  | 'pr_review_renew'
  | 'pr_docs'
  | 'pr_approve'
  | 'pr_merge';

interface PanelActionDef {
  key: PanelActionKey;
  actionId: string;
  label: string;
  style?: 'primary' | 'danger';
}

const ACTION_DEFS: Record<PanelActionKey, PanelActionDef> = {
  pr_fix_new: { key: 'pr_fix_new', actionId: 'panel_pr_fix_new', label: 'New Fix' },
  pr_fix_renew: { key: 'pr_fix_renew', actionId: 'panel_pr_fix_renew', label: 'Renew Fix' },
  pr_review_new: { key: 'pr_review_new', actionId: 'panel_pr_review_new', label: 'New 리뷰' },
  pr_review_renew: { key: 'pr_review_renew', actionId: 'panel_pr_review_renew', label: 'Renew 리뷰' },
  pr_docs: { key: 'pr_docs', actionId: 'panel_pr_docs', label: 'PR 문서화' },
  pr_approve: { key: 'pr_approve', actionId: 'panel_pr_approve', label: 'PR 승인', style: 'primary' },
  pr_merge: { key: 'pr_merge', actionId: 'panel_pr_merge', label: 'Merge', style: 'primary' },
};

const DEFAULT_ACTIONS: PanelActionKey[] = [];

const WORKFLOW_ACTIONS: Record<WorkflowType, PanelActionKey[]> = {
  onboarding: [],
  'jira-executive-summary': [],
  'jira-brainstorming': [],
  'jira-planning': [],
  'jira-create-pr': [],
  'pr-review': ['pr_fix_new', 'pr_fix_renew', 'pr_approve', 'pr_docs'],
  'pr-fix-and-update': ['pr_review_new', 'pr_review_renew', 'pr_docs'],
  'pr-docs-confluence': ['pr_review_new', 'pr_review_renew'],
  deploy: [],
  default: [],
};

export class ActionPanelBuilder {
  static build(params: ActionPanelBuildParams): ActionPanelPayload {
    const disabled = params.disabled ?? true;
    const workflow = params.workflow || 'default';

    // Closed state: status + divider + summary grid + footer
    if (params.closed) {
      return ActionPanelBuilder.buildClosedPanel(params);
    }

    const actions = WORKFLOW_ACTIONS[workflow] || DEFAULT_ACTIONS;

    const status = ActionPanelBuilder.resolveStatus({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      disabled,
    });

    const isQuestionPending = params.waitingForChoice === true;
    const isWorking = params.activityState === 'working' || params.hasActiveRequest === true;

    const closeButton = ActionPanelBuilder.buildCloseButton(params.sessionKey);

    // Build final action rows with close button merged in
    let actionRows: any[];

    if (isWorking) {
      // Working: [⏸ 중지(default)] [세션 종료(danger)] in control row
      const stopButton = {
        type: 'button',
        text: { type: 'plain_text', text: '⏸ 중지', emoji: true },
        action_id: 'panel_stop',
        value: JSON.stringify({ sessionKey: params.sessionKey, action: 'stop' }),
      };
      actionRows = [{ type: 'actions', block_id: 'control_actions', elements: [stopButton, closeButton] }];
    } else if (isQuestionPending) {
      // Question: [세션 종료(danger)] alone in control row
      actionRows = [{ type: 'actions', block_id: 'control_actions', elements: [closeButton] }];
    } else {
      // Idle: workflow buttons chunked, close appended to last row
      const workflowButtons = actions
        .filter((key) => {
          if (key === 'pr_approve' && params.prStatus?.approved) return false;
          if (key === 'pr_approve' && params.prStatus?.merged) return false;
          return true;
        })
        .map((key) => ActionPanelBuilder.buildButton(ACTION_DEFS[key], params.sessionKey));

      if (params.prUrl && !actions.some((k) => k.startsWith('pr_review'))) {
        workflowButtons.push(ActionPanelBuilder.buildButton(ACTION_DEFS['pr_review_new'], params.sessionKey));
        workflowButtons.push(ActionPanelBuilder.buildButton(ACTION_DEFS['pr_review_renew'], params.sessionKey));
      }

      if (ActionPanelBuilder.shouldRenderMergeButton(workflow, params)) {
        workflowButtons.push(ActionPanelBuilder.buildMergeButton(params));
      }

      // Enforce max 1 primary button (recommended action only)
      ActionPanelBuilder.enforceMaxOnePrimary(workflowButtons);

      if (workflowButtons.length > 0) {
        const chunks = ActionPanelBuilder.chunk(workflowButtons, 5);
        actionRows = chunks.map((row, i) => ({
          type: 'actions',
          block_id: `workflow_actions${i > 0 ? `_${i}` : ''}`,
          elements: row,
        }));
        // Close in separate control row
        actionRows.push({ type: 'actions', block_id: 'control_actions', elements: [closeButton] });
      } else {
        actionRows = [{ type: 'actions', block_id: 'control_actions', elements: [closeButton] }];
      }
    }

    const blocks: any[] = [];

    // 1. Status blocks (hero section + fields section)
    blocks.push(
      ...ActionPanelBuilder.buildStatusBlocks({
        status,
        waitingForChoice: params.waitingForChoice,
        activityState: params.activityState,
        hasActiveRequest: params.hasActiveRequest,
        agentPhase: params.agentPhase,
        activeTool: params.activeTool,
        prStatus: params.prStatus,
        contextRemainingPercent: params.contextRemainingPercent,
      }),
    );

    // 2. Metrics context (small text: time + tools + link + verbosity)
    const metricsCtx = ActionPanelBuilder.buildMetricsContext({
      turnSummary: params.turnSummary,
      latestResponseLink: params.latestResponseLink,
      logVerbosity: params.logVerbosity,
    });
    if (metricsCtx) blocks.push(metricsCtx);

    // 3. Choice slot (when waiting for user input)
    if (isQuestionPending && params.choiceBlocks) {
      blocks.push({ type: 'divider' });
      blocks.push(...ActionPanelBuilder.buildChoiceSlotBlocks(params.choiceBlocks));
    }

    // 4. Divider + action rows (with close button merged)
    blocks.push({ type: 'divider' });
    blocks.push(...actionRows);

    return {
      text: `Action panel (${workflow}) - ${status}`,
      blocks,
    };
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
   * Status blocks: single section with 2-column fields layout.
   * Left: status badge + agent subtitle    Right: PR label + chip
   */
  private static buildStatusBlocks(params: {
    status: string;
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
    prStatus?: PRStatusInfo;
    contextRemainingPercent?: number;
  }): any[] {
    const badge = ActionPanelBuilder.statusBadge(params.status);
    const agentChip = ActionPanelBuilder.buildAgentChip({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      agentPhase: params.agentPhase,
      activeTool: params.activeTool,
    });

    const statusText = agentChip ? `${badge}\n_${agentChip}_` : badge;

    // PR chip for right column
    const prChip = params.prStatus ? ActionPanelBuilder.prStatusChip(params.prStatus) : '';

    if (prChip) {
      // 2-column fields: status (left) + PR (right)
      return [
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: statusText },
            { type: 'mrkdwn', text: `*PR*\n${prChip}` },
          ],
        },
      ];
    }

    // No PR — plain section
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: statusText },
      },
    ];
  }

  /**
   * Metrics context: time + tools + link + verbosity → context block (small text, separate elements)
   */
  private static buildMetricsContext(params: {
    turnSummary?: string;
    latestResponseLink?: string;
    logVerbosity?: number;
  }): any | null {
    const elements: any[] = [];

    if (params.turnSummary) {
      elements.push({ type: 'mrkdwn', text: params.turnSummary });
    }

    if (params.latestResponseLink) {
      elements.push({ type: 'mrkdwn', text: `<${params.latestResponseLink}|💬 최신 응답>` });
    }

    if (params.logVerbosity !== undefined) {
      elements.push({ type: 'mrkdwn', text: ActionPanelBuilder.verbosityLabel(params.logVerbosity) });
    }

    if (elements.length === 0) return null;

    return {
      type: 'context',
      elements,
    };
  }

  private static verbosityLabel(mask: number): string {
    const LABELS: Record<LogVerbosity, string> = {
      minimal: '🔇 minimal',
      compact: '📎 compact',
      detail: '📋 detail',
      verbose: '📢 verbose',
    };
    const name = getVerbosityName(mask);
    return name === 'custom' ? `🔧 custom` : LABELS[name];
  }

  private static buildAgentChip(params: {
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
  }): string | undefined {
    if (params.waitingForChoice) {
      return '질문 응답 필요';
    }

    if (params.activeTool) {
      return ActionPanelBuilder.formatToolLabel(params.activeTool);
    }

    if (params.agentPhase) {
      return ActionPanelBuilder.truncateLine(params.agentPhase, 22);
    }

    if (params.hasActiveRequest) {
      return '요청 처리';
    }

    if (params.activityState === 'working') {
      return '응답 생성';
    }

    if (params.activityState === 'waiting') {
      return '입력 대기';
    }

    return undefined;
  }

  private static contextChip(contextRemainingPercent?: number): string {
    if (typeof contextRemainingPercent === 'number' && Number.isFinite(contextRemainingPercent)) {
      return `${ActionPanelBuilder.formatPercent(contextRemainingPercent)}%`;
    }
    return '--%';
  }

  private static formatPercent(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  private static formatToolLabel(toolName: string): string {
    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      const serverName = parts[1] || 'mcp';
      const actualTool = parts.slice(2).join('__');
      const label = actualTool ? `${serverName}:${actualTool}` : serverName;
      return ActionPanelBuilder.truncateLine(label, 20);
    }

    const aliases: Record<string, string> = {
      Read: '파일 읽기',
      Write: '코드 작성',
      Edit: '코드 수정',
      Bash: '명령 실행',
      Grep: '코드 검색',
      Glob: '파일 탐색',
      WebSearch: '웹 검색',
      WebFetch: '웹 조회',
      Task: '에이전트 위임',
    };

    return aliases[toolName] || ActionPanelBuilder.truncateLine(toolName, 20);
  }

  private static statusBadge(status: string): string {
    switch (status) {
      case '사용 가능':
        return '⚪ 사용 가능';
      case '작업 중':
        return '🟢 *작업 중*';
      case '요청 처리 중':
        return '🟢 *요청 처리 중*';
      case '입력 대기':
        return '🟡 *입력 대기*';
      case '대기 중':
        return '⚪ 대기 중';
      case '종료됨':
        return '⚫ *종료됨*';
      case '비활성':
      default:
        return '⚪ 대기';
    }
  }

  private static prStatusChip(prStatus: PRStatusInfo): string {
    if (prStatus.merged) return '🟣 Merged';
    if (prStatus.draft) return '_Draft_';
    if (prStatus.state === 'closed') return '🔴 Closed';
    if (prStatus.approved && prStatus.mergeable) return 'Approved · Merge 가능';
    if (prStatus.approved) return 'Approved';
    if (prStatus.mergeable) return 'Merge 가능';
    if (prStatus.state === 'open') return '⚠️ Merge 불가';
    return '';
  }

  private static buildMergeButton(params: ActionPanelBuildParams): any {
    const prLabel = params.prStatus?.head ? `${params.prStatus.head} → ${params.prStatus.base}` : 'PR';

    return {
      type: 'button',
      text: { type: 'plain_text', text: 'Merge', emoji: true },
      action_id: 'panel_pr_merge',
      style: 'primary',
      value: JSON.stringify({
        sessionKey: params.sessionKey,
        action: 'pr_merge',
        prUrl: params.prUrl,
        headBranch: params.prStatus?.head,
        baseBranch: params.prStatus?.base,
      }),
      confirm: {
        title: { type: 'plain_text', text: 'PR 머지' },
        text: {
          type: 'mrkdwn',
          text: `*${prLabel}*을(를) 머지하시겠습니까?\n\nSquash merge로 진행되며, 머지 후 소스 브랜치가 삭제됩니다.`,
        },
        confirm: { type: 'plain_text', text: '머지' },
        deny: { type: 'plain_text', text: '취소' },
      },
    };
  }

  private static shouldRenderMergeButton(workflow: WorkflowType, params: ActionPanelBuildParams): boolean {
    if (!params.prStatus?.mergeable || !params.prUrl) {
      return false;
    }

    if (workflow === 'pr-review' || workflow === 'pr-fix-and-update') {
      return false;
    }

    return true;
  }

  private static buildChoiceSlotBlocks(choiceBlocks?: any[]): any[] {
    if (!Array.isArray(choiceBlocks) || choiceBlocks.length === 0) {
      return [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '❓ *응답이 필요한 질문이 있습니다.*' },
        },
      ];
    }
    return choiceBlocks.map((block) => JSON.parse(JSON.stringify(block)));
  }

  private static truncateLine(input: string, maxLength: number): string {
    if (input.length <= maxLength) {
      return input;
    }
    return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
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

  private static buildButton(def: PanelActionDef, sessionKey: string): any {
    const button: any = {
      type: 'button',
      text: { type: 'plain_text', text: def.label, emoji: true },
      action_id: def.actionId,
      value: JSON.stringify({ sessionKey, action: def.key }),
    };

    if (def.style) {
      button.style = def.style;
    }

    return button;
  }

  /**
   * Closed panel: hero (status left + PR right) → divider → summary fields grid → context footer
   */
  private static buildClosedPanel(params: ActionPanelBuildParams): ActionPanelPayload {
    const workflow = params.workflow || 'default';
    const prChip = params.prStatus ? ActionPanelBuilder.prStatusChip(params.prStatus) : '';

    const heroBlock = prChip
      ? {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '⚫ *종료됨*' },
            { type: 'mrkdwn', text: `*PR*\n${prChip}` },
          ],
        }
      : { type: 'section', text: { type: 'mrkdwn', text: '⚫ *종료됨*' } };

    const blocks: any[] = [heroBlock, { type: 'divider' }];

    // Summary fields grid (2-column layout)
    const fields: any[] = [];
    if (params.turnSummary) {
      const { elapsed, toolCount } = ActionPanelBuilder.parseTurnSummary(params.turnSummary);
      if (elapsed) {
        fields.push({ type: 'mrkdwn', text: `*소요 시간*\n${elapsed}` });
      }
      if (toolCount !== undefined) {
        fields.push({ type: 'mrkdwn', text: `*도구 사용*\n${toolCount}회` });
      }
    }
    // Context info is shown in thread header badge — no need to duplicate here.

    // Only add summary section when there are actual fields (Slack rejects empty fields[])
    if (fields.length > 0) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '*작업 요약*' },
        fields,
      });
    }

    // Context footer: timestamp + link
    const footerElements: any[] = [];
    footerElements.push({ type: 'mrkdwn', text: `${ActionPanelBuilder.formatCloseTimestamp()} 종료` });

    if (params.latestResponseLink) {
      footerElements.push({ type: 'mrkdwn', text: `<${params.latestResponseLink}|최신 응답>` });
    }

    blocks.push({ type: 'context', elements: footerElements });

    return {
      text: `Action panel (${workflow}) - 종료됨`,
      blocks,
    };
  }

  /**
   * Ensure at most 1 primary button.
   */
  private static enforceMaxOnePrimary(buttons: any[]): void {
    const primaryIndices = buttons.reduce<number[]>((acc, b, i) => {
      if (b.style === 'primary') acc.push(i);
      return acc;
    }, []);
    if (primaryIndices.length <= 1) return;
    // Keep only the last primary (merge takes priority over approve)
    for (let i = 0; i < primaryIndices.length - 1; i++) {
      delete buttons[primaryIndices[i]].style;
    }
  }

  private static parseTurnSummary(turnSummary: string): { elapsed?: string; toolCount?: number } {
    const timeMatch = turnSummary.match(/⏱\s*(.+?)(?:\s*·|$)/);
    const toolMatch = turnSummary.match(/🛠\s*(\d+)/);
    return {
      elapsed: timeMatch?.[1]?.trim(),
      toolCount: toolMatch ? parseInt(toolMatch[1], 10) : undefined,
    };
  }

  private static formatCloseTimestamp(): string {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  private static chunk<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      result.push(items.slice(i, i + size));
    }
    return result;
  }
}
