import { ActivityState, WorkflowType } from '../types';

export interface ActionPanelBuildParams {
  sessionKey: string;
  workflow?: WorkflowType;
  disabled?: boolean;
  choiceBlocks?: any[];
  waitingForChoice?: boolean;
  choiceMessageLink?: string;
  activityState?: ActivityState;
  contextRemainingPercent?: number;
  hasActiveRequest?: boolean;
  agentPhase?: string;
  activeTool?: string;
  statusUpdatedAt?: number;
}

export interface ActionPanelPayload {
  text: string;
  blocks: any[];
}

type PanelActionKey =
  | 'issue_research'
  | 'pr_create'
  | 'pr_review'
  | 'pr_docs'
  | 'pr_fix'
  | 'pr_approve';

interface PanelActionDef {
  key: PanelActionKey;
  actionId: string;
  label: string;
  style?: 'primary' | 'danger';
}

const ACTION_DEFS: Record<PanelActionKey, PanelActionDef> = {
  issue_research: { key: 'issue_research', actionId: 'panel_issue_research', label: '이슈 리서치' },
  pr_create: { key: 'pr_create', actionId: 'panel_pr_create', label: 'PR 생성' },
  pr_review: { key: 'pr_review', actionId: 'panel_pr_review', label: 'PR 리뷰' },
  pr_docs: { key: 'pr_docs', actionId: 'panel_pr_docs', label: 'PR 문서화' },
  pr_fix: { key: 'pr_fix', actionId: 'panel_pr_fix', label: 'PR 수정' },
  pr_approve: { key: 'pr_approve', actionId: 'panel_pr_approve', label: 'PR 승인', style: 'primary' },
};

const DEFAULT_ACTIONS: PanelActionKey[] = [
  'issue_research',
  'pr_create',
  'pr_review',
  'pr_docs',
  'pr_fix',
  'pr_approve',
];

const WORKFLOW_ACTIONS: Record<WorkflowType, PanelActionKey[]> = {
  onboarding: DEFAULT_ACTIONS,
  'jira-executive-summary': ['issue_research', 'pr_create'],
  'jira-brainstorming': ['issue_research', 'pr_create'],
  'jira-planning': ['issue_research', 'pr_create'],
  'jira-create-pr': ['pr_create', 'issue_research'],
  'pr-review': ['pr_review', 'pr_fix', 'pr_approve', 'pr_docs'],
  'pr-fix-and-update': ['pr_fix', 'pr_review', 'pr_docs'],
  'pr-docs-confluence': ['pr_docs', 'pr_review'],
  deploy: ['pr_create', 'pr_review', 'pr_docs'],
  default: DEFAULT_ACTIONS,
};

export class ActionPanelBuilder {
  static build(params: ActionPanelBuildParams): ActionPanelPayload {
    const disabled = params.disabled ?? true;
    const workflow = params.workflow || 'default';
    const actions = WORKFLOW_ACTIONS[workflow] || DEFAULT_ACTIONS;

    const status = this.resolveStatus({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      disabled,
    });

    const isQuestionPending = params.waitingForChoice === true;
    const defaultButtons = actions.map((key) => this.buildButton(ACTION_DEFS[key], params.sessionKey));
    const actionBlocks = isQuestionPending
      ? []
      : this.chunk(defaultButtons, 5).map((row) => ({ type: 'actions', elements: row }));

    const summaryText = this.buildSummaryLine({
      status,
      contextRemainingPercent: params.contextRemainingPercent,
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      agentPhase: params.agentPhase,
      activeTool: params.activeTool,
      statusUpdatedAt: params.statusUpdatedAt,
    });

    const blocks: any[] = [];

    if (isQuestionPending) {
      blocks.push(...this.buildChoiceSlotBlocks(params.choiceBlocks));
    }

    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText },
    });

    blocks.push(...actionBlocks);

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
  }): string {
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

  private static buildSummaryLine(params: {
    status: string;
    contextRemainingPercent?: number;
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
    statusUpdatedAt?: number;
  }): string {
    const parts: string[] = [];

    parts.push(this.statusBadge(params.status));

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

    parts.push(this.contextChip(params.contextRemainingPercent));

    if (params.statusUpdatedAt) {
      parts.push('🟢 live');
    }

    return parts.join(' · ');
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
      return `📦 남은 ${this.formatPercent(contextRemainingPercent)}%`;
    }
    return '📦 남은 --%';
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
        return '⚙️ 작업 중';
      case '요청 처리 중':
        return '⏳ 요청 처리 중';
      case '입력 대기':
        return '✋ 입력 대기';
      case '대기 중':
        return '🟡 대기 중';
      case '비활성':
      default:
        return '⏸️ 비활성';
    }
  }

  private static buildChoiceSlotBlocks(choiceBlocks?: any[]): any[] {
    if (!Array.isArray(choiceBlocks) || choiceBlocks.length === 0) {
      return [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❓ *User Ask*\n응답이 필요한 질문이 있습니다.',
          },
        },
      ];
    }

    return choiceBlocks.map((block) => this.cloneBlock(block));
  }

  private static cloneBlock(block: any): any {
    return JSON.parse(JSON.stringify(block));
  }

  private static truncateLine(input: string, maxLength: number): string {
    if (input.length <= maxLength) {
      return input;
    }
    return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
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
