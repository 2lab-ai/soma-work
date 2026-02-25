import { ActivityState, WorkflowType } from '../types';

export interface PRStatusInfo {
  state: string;      // 'open' | 'closed' | 'merged'
  mergeable: boolean;
  draft: boolean;
  merged: boolean;
  approved?: boolean; // true if PR has been approved
  head?: string;      // source branch
  base?: string;      // target branch
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

    // Closed state: section + context, no buttons
    if (params.closed) {
      const blocks: any[] = [];
      blocks.push(this.buildStatusSection({
        status: '종료됨',
        prStatus: params.prStatus,
      }));
      const metricsCtx = this.buildMetricsContext({
        contextRemainingPercent: params.contextRemainingPercent,
      });
      if (metricsCtx) blocks.push(metricsCtx);

      return {
        text: `Action panel (${workflow}) - 종료됨`,
        blocks,
      };
    }

    const actions = WORKFLOW_ACTIONS[workflow] || DEFAULT_ACTIONS;

    const status = this.resolveStatus({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      disabled,
    });

    const isQuestionPending = params.waitingForChoice === true;
    const isWorking = params.activityState === 'working' || params.hasActiveRequest === true;

    // Build close button (always present, separated with divider)
    const closeButton = this.buildCloseButton(params.sessionKey);

    // Build workflow action blocks
    let actionBlocks: any[];

    if (isWorking) {
      // Working: show only stop button; close button after divider
      const stopButton = {
        type: 'button',
        text: { type: 'plain_text', text: '중지', emoji: true },
        action_id: 'panel_stop',
        value: JSON.stringify({ sessionKey: params.sessionKey, action: 'stop' }),
        style: 'danger' as const,
      };
      actionBlocks = [{ type: 'actions', elements: [stopButton] }];
    } else if (isQuestionPending) {
      // Waiting for choice: no workflow buttons
      actionBlocks = [];
    } else {
      // Idle: show workflow buttons
      const workflowButtons = actions
        .filter((key) => {
          // Hide pr_approve when PR is already approved or merged
          if (key === 'pr_approve' && params.prStatus?.approved) return false;
          if (key === 'pr_approve' && params.prStatus?.merged) return false;
          return true;
        })
        .map((key) => this.buildButton(ACTION_DEFS[key], params.sessionKey));

      // Dynamic: add review buttons when PR exists and workflow doesn't already have them
      if (params.prUrl && !actions.some(k => k.startsWith('pr_review'))) {
        workflowButtons.push(this.buildButton(ACTION_DEFS['pr_review_new'], params.sessionKey));
        workflowButtons.push(this.buildButton(ACTION_DEFS['pr_review_renew'], params.sessionKey));
      }

      // Add merge button when PR is mergeable
      if (params.prStatus?.mergeable && params.prUrl) {
        workflowButtons.push(this.buildMergeButton(params));
      }

      actionBlocks = workflowButtons.length > 0
        ? this.chunk(workflowButtons, 5).map((row) => ({ type: 'actions', elements: row }))
        : [];
    }

    const blocks: any[] = [];

    // 1. Status section (big text: status + PR chip + agent chip)
    blocks.push(this.buildStatusSection({
      status,
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      agentPhase: params.agentPhase,
      activeTool: params.activeTool,
      prStatus: params.prStatus,
    }));

    // 2. Metrics context (small text: context% + time + tools + link + live)
    const metricsCtx = this.buildMetricsContext({
      contextRemainingPercent: params.contextRemainingPercent,
      turnSummary: params.turnSummary,
      latestResponseLink: params.latestResponseLink,
      statusUpdatedAt: params.statusUpdatedAt,
    });
    if (metricsCtx) blocks.push(metricsCtx);

    // 3. Choice slot (when waiting for user input)
    if (isQuestionPending && params.choiceBlocks) {
      blocks.push({ type: 'divider' });
      blocks.push(...this.buildChoiceSlotBlocks(params.choiceBlocks));
    }

    // 4. Action buttons
    blocks.push(...actionBlocks);

    // 5. Divider + close button (always present)
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'actions', elements: [closeButton] });

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
   * Status section: status badge + PR chip + agent chip → section block (big text)
   */
  private static buildStatusSection(params: {
    status: string;
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
    prStatus?: PRStatusInfo;
  }): any {
    const parts: string[] = [];

    parts.push(this.statusBadge(params.status));

    if (params.prStatus) {
      const chip = this.prStatusChip(params.prStatus);
      if (chip) parts.push(chip);
    }

    const agentChip = this.buildAgentChip({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      agentPhase: params.agentPhase,
      activeTool: params.activeTool,
    });
    if (agentChip) {
      parts.push(agentChip);
    }

    return {
      type: 'section',
      text: { type: 'mrkdwn', text: parts.join('  ·  ') },
    };
  }

  /**
   * Metrics context: context% + time + tools + link + live → context block (small text)
   */
  private static buildMetricsContext(params: {
    contextRemainingPercent?: number;
    turnSummary?: string;
    latestResponseLink?: string;
    statusUpdatedAt?: number;
  }): any | null {
    const parts: string[] = [];

    parts.push(this.contextChip(params.contextRemainingPercent));

    if (params.turnSummary) {
      parts.push(params.turnSummary);
    }

    if (params.latestResponseLink) {
      parts.push(`<${params.latestResponseLink}|💬 최신 응답>`);
    }

    if (params.statusUpdatedAt) {
      parts.push('🟢 live');
    }

    if (parts.length === 0) return null;

    return {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: parts.join('  ·  ') }],
    };
  }

  private static buildAgentChip(params: {
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
  }): string | undefined {
    if (params.waitingForChoice) {
      return '🧩 질문 응답 필요';
    }

    if (params.activeTool) {
      return `🛠 ${this.formatToolLabel(params.activeTool)}`;
    }

    if (params.agentPhase) {
      return `🧠 ${this.truncateLine(params.agentPhase, 22)}`;
    }

    if (params.hasActiveRequest) {
      return '⏳ 요청 처리';
    }

    if (params.activityState === 'working') {
      return '🧠 응답 생성';
    }

    if (params.activityState === 'waiting') {
      return '🧩 입력 대기';
    }

    return undefined;
  }

  private static contextChip(contextRemainingPercent?: number): string {
    if (typeof contextRemainingPercent === 'number' && Number.isFinite(contextRemainingPercent)) {
      return `📦 ${this.formatPercent(contextRemainingPercent)}%`;
    }
    return '📦 --%';
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
      return this.truncateLine(label, 20);
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

    return aliases[toolName] || this.truncateLine(toolName, 20);
  }

  private static statusBadge(status: string): string {
    switch (status) {
      case '사용 가능':
        return '✅ 사용 가능';
      case '작업 중':
        return '⚙️ *작업 중*';
      case '요청 처리 중':
        return '⏳ *요청 처리 중*';
      case '입력 대기':
        return '✋ *입력 대기*';
      case '대기 중':
        return '🟡 대기 중';
      case '종료됨':
        return '🔒 *종료됨*';
      case '비활성':
      default:
        return '⏸️ 대기';
    }
  }

  private static prStatusChip(prStatus: PRStatusInfo): string {
    if (prStatus.merged) return '🟣 Merged';
    if (prStatus.draft) return '⚪ Draft';
    if (prStatus.state === 'closed') return '🔴 Closed';
    if (prStatus.approved && prStatus.mergeable) return '👍 Approved · ✅ Merge 가능';
    if (prStatus.approved) return '👍 Approved';
    if (prStatus.mergeable) return '✅ Merge 가능';
    if (prStatus.state === 'open') return '⚠️ Merge 불가';
    return '';
  }

  private static buildMergeButton(params: ActionPanelBuildParams): any {
    const prLabel = params.prStatus?.head
      ? `${params.prStatus.head} → ${params.prStatus.base}`
      : 'PR';

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

  private static buildChoiceSlotBlocks(choiceBlocks?: any[]): any[] {
    if (!Array.isArray(choiceBlocks) || choiceBlocks.length === 0) {
      return [{
        type: 'section',
        text: { type: 'mrkdwn', text: '❓ *응답이 필요한 질문이 있습니다.*' },
      }];
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
        text: { type: 'mrkdwn', text: '이 세션을 종료하시겠습니까?' },
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

  private static chunk<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      result.push(items.slice(i, i + size));
    }
    return result;
  }
}
