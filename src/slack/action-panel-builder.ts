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
      disabled,
    });
    const summaryLines = this.buildDashboardLines({
      status,
      workflow,
      actionsCount: actions.length,
      model: params.model,
      contextUsagePercent: params.contextUsagePercent,
    });
    const summaryElements = summaryLines.map((line) => ({ type: 'mrkdwn', text: line }));
    const blocks: any[] = [{ type: 'context', elements: summaryElements }];

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
      text: `Action panel (${workflow})`,
      blocks,
    };
  }

  private static resolveStatus(params: {
    waitingForChoice?: boolean;
    activityState?: ActivityState;
    disabled: boolean;
  }): string {
    if (params.waitingForChoice) {
      return '입력 대기';
    }

    if (params.activityState === 'working') {
      return '작업 중';
    }

    if (params.activityState === 'waiting') {
      return '대기 중';
    }

    if (params.disabled) {
      return '비활성';
    }

    return '사용 가능';
  }

  private static buildDashboardLines(params: {
    status: string;
    workflow: WorkflowType;
    actionsCount: number;
    model?: string;
    contextUsagePercent?: number;
  }): string[] {
    const lines = [
      '🧵 Thread',
      this.statusBadge(params.status),
      `\`${params.workflow}\``,
      `🎛️ ${params.actionsCount}`,
    ];

    if (params.model) {
      lines.push(`🤖 \`${this.truncateLine(params.model, 18)}\``);
    }

    if (typeof params.contextUsagePercent === 'number') {
      lines.push(`📦 ${params.contextUsagePercent}%`);
    }
    return lines;
  }

  private static statusBadge(status: string): string {
    switch (status) {
      case '사용 가능':
        return '✅ 사용 가능';
      case '작업 중':
        return '🟠 작업 중';
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
    if (links.issue) {
      segments.push(this.renderLinkSegment(links.issue, 'Issue'));
    }
    if (links.pr) {
      segments.push(this.renderLinkSegment(links.pr, 'PR'));
    }
    if (links.doc) {
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
