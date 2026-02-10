import { ActivityState, SessionLink, SessionLinks, WorkflowType } from '../types';

export interface ActionPanelBuildParams {
  sessionKey: string;
  workflow?: WorkflowType;
  disabled?: boolean;
  choiceBlocks?: any[];
  waitingForChoice?: boolean;
  links?: SessionLinks;
  activityState?: ActivityState;
  model?: string;
  contextUsagePercent?: number;
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
    const elements = actions.map((key) => this.buildButton(ACTION_DEFS[key], params.sessionKey));
    const actionBlocks = this.chunk(elements, 5).map((row) => ({ type: 'actions', elements: row }));

    const status = this.resolveStatus({
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      disabled,
    });
    const summaryText = this.buildSummaryLine({
      status,
      workflow,
      actionsCount: actions.length,
      model: params.model,
      contextUsagePercent: params.contextUsagePercent,
      waitingForChoice: params.waitingForChoice,
      activityState: params.activityState,
      hasActiveRequest: params.hasActiveRequest,
      agentPhase: params.agentPhase,
      activeTool: params.activeTool,
      statusUpdatedAt: params.statusUpdatedAt,
    });
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summaryText },
      },
    ];

    const linksText = this.buildLinksText(params.links);
    if (linksText) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: linksText }],
      });
    }

    blocks.push(...actionBlocks);

    if (params.choiceBlocks && params.choiceBlocks.length > 0) {
      blocks.push(...params.choiceBlocks);
    }

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
    workflow: WorkflowType;
    actionsCount: number;
    model?: string;
    contextUsagePercent?: number;
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    hasActiveRequest?: boolean;
    agentPhase?: string;
    activeTool?: string;
    statusUpdatedAt?: number;
  }): string {
    const parts: string[] = [];

    parts.push('🧵 Thread');
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

    parts.push(`\`${params.workflow}\``);
    parts.push(`🎛️ ${params.actionsCount}`);

    if (params.model) {
      parts.push(`🤖 \`${this.truncateLine(params.model, 18)}\``);
    }

    if (typeof params.contextUsagePercent === 'number') {
      parts.push(`📦 ${params.contextUsagePercent}%`);
    }

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
      return '🧩 선택 대기';
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

  private static buildLinksText(links: SessionLinks | undefined): string | undefined {
    if (!links) {
      return undefined;
    }

    const segments: string[] = [];
    if (links.issue && !this.isSlackMessageUrl(links.issue.url)) {
      segments.push(this.renderLinkSegment(links.issue, 'Issue'));
    }
    if (links.pr && !this.isSlackMessageUrl(links.pr.url)) {
      segments.push(this.renderLinkSegment(links.pr, 'PR'));
    }
    if (links.doc && !this.isSlackMessageUrl(links.doc.url)) {
      segments.push(this.renderLinkSegment(links.doc, 'Doc'));
    }

    if (segments.length === 0) {
      return undefined;
    }

    return `🔗 ${segments.join(' · ')}`;
  }

  private static renderLinkSegment(link: SessionLink, fallbackLabel: string): string {
    const rawLabel = (link.label || link.title || fallbackLabel).trim();
    const label = this.truncateLine(rawLabel || fallbackLabel, 40);
    return `<${link.url}|${label}>`;
  }

  private static truncateLine(input: string, maxLength: number): string {
    if (input.length <= maxLength) {
      return input;
    }
    return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private static isSlackMessageUrl(url: string): boolean {
    return url.includes('slack.com/archives/') || url.includes('app.slack.com/client/');
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
