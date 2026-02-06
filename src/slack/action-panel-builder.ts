import { WorkflowType } from '../types';

export interface ActionPanelBuildParams {
  sessionKey: string;
  workflow?: WorkflowType;
  disabled?: boolean;
  threadLink?: string;
  choiceBlocks?: any[];
  waitingForChoice?: boolean;
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

    const headerElements = [
      {
        type: 'mrkdwn',
        text: params.threadLink ? `🧵 <${params.threadLink}|Thread>` : '🧵 Thread link unavailable',
      },
      {
        type: 'mrkdwn',
        text: params.waitingForChoice ? '✋ 입력 대기' : (disabled ? '⏸️ 비활성' : '✅ 사용 가능'),
      },
    ];

    const blocks: any[] = [{ type: 'context', elements: headerElements }, ...actionBlocks];

    if (params.choiceBlocks && params.choiceBlocks.length > 0) {
      blocks.push(...params.choiceBlocks);
    }

    return {
      text: `Action panel (${workflow})`,
      blocks,
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
