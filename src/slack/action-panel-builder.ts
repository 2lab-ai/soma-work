import { SessionLink, SessionLinks, WorkflowType } from '../types';

export interface ActionPanelBuildParams {
  sessionKey: string;
  workflow?: WorkflowType;
  disabled?: boolean;
  choiceBlocks?: any[];
  waitingForChoice?: boolean;
  panelTitle?: string;
  styleVariant?: number;
  links?: SessionLinks;
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
  static readonly STYLE_VARIANT_COUNT = 10;

  static build(params: ActionPanelBuildParams): ActionPanelPayload {
    const disabled = params.disabled ?? true;
    const workflow = params.workflow || 'default';
    const actions = WORKFLOW_ACTIONS[workflow] || DEFAULT_ACTIONS;
    const elements = actions.map((key) => this.buildButton(ACTION_DEFS[key], params.sessionKey));
    const actionBlocks = this.chunk(elements, 5).map((row) => ({ type: 'actions', elements: row }));
    const statusText = params.waitingForChoice ? '(Thread) 입력 대기' : (disabled ? '(Thread) 비활성' : '(Thread) 사용 가능');
    const dialog = this.renderDialog({
      title: params.panelTitle,
      statusText,
      styleVariant: params.styleVariant ?? 0,
    });

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ['```', dialog, '```'].join('\n'),
        },
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
      text: `Action dialog (${workflow})`,
      blocks,
    };
  }

  private static renderDialog(params: {
    title?: string;
    statusText: string;
    styleVariant: number;
  }): string {
    const style = this.normalizeStyleVariant(params.styleVariant);
    if (style === 0) {
      return this.renderTitleBarStyle(params.title, params.statusText);
    }

    const lines: string[] = [];
    if (params.title) {
      lines.push(this.truncateLine(params.title, 48));
    }
    lines.push(params.statusText);

    switch (style) {
      case 1:
        return this.renderFrame(lines, { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' });
      case 2:
        return this.renderFrame(lines, { tl: '*', tr: '*', bl: '*', br: '*', h: '*', v: '*' });
      case 3:
        return this.renderFrame(lines, { tl: '#', tr: '#', bl: '#', br: '#', h: '#', v: '#' });
      case 4:
        return this.renderFrame(lines, { tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '||' });
      case 5:
        return this.renderFrame(lines, { tl: '/', tr: '\\', bl: '\\', br: '/', h: '-', v: '|' });
      case 6:
        return this.renderFrame(lines, { tl: '[', tr: ']', bl: '[', br: ']', h: '-', v: '|' });
      case 7:
        return this.renderFrame(lines, { tl: '<', tr: '>', bl: '<', br: '>', h: '-', v: '|' });
      case 8:
        return this.renderFrame(lines, { tl: '.', tr: '.', bl: '\'', br: '\'', h: '-', v: ':' });
      case 9:
        return this.renderFrame(lines, { tl: '+', tr: '+', bl: '+', br: '+', h: '~', v: '|' });
      default:
        return this.renderFrame(lines, { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' });
    }
  }

  private static renderTitleBarStyle(
    title: string | undefined,
    statusText: string
  ): string {
    const safeTitle = this.truncateLine(title || 'Thread', 36);
    const body = [statusText];
    const bodyWidth = body.reduce((max, line) => Math.max(max, line.length), 0);
    const topLabel = `+-< ${safeTitle} >`;
    const top = topLabel + '-'.repeat(Math.max(0, bodyWidth + 4 - topLabel.length)) + '+';
    const lines = [
      top,
      ...body.map((line) => `| ${line.padEnd(bodyWidth)} |`),
      '+' + '-'.repeat(bodyWidth + 2) + '+',
    ];
    return lines.join('\n');
  }

  private static renderFrame(
    lines: string[],
    chars: { tl: string; tr: string; bl: string; br: string; h: string; v: string }
  ): string {
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const top = chars.tl + chars.h.repeat(width + 2) + chars.tr;
    const bottom = chars.bl + chars.h.repeat(width + 2) + chars.br;
    const body = lines.map((line) => `${chars.v} ${line.padEnd(width)} ${chars.v}`);
    return [top, ...body, bottom].join('\n');
  }

  private static normalizeStyleVariant(styleVariant: number): number {
    const size = ActionPanelBuilder.STYLE_VARIANT_COUNT;
    return ((styleVariant % size) + size) % size;
  }

  private static truncateLine(input: string, maxLength: number): string {
    if (input.length <= maxLength) {
      return input;
    }
    return `${input.slice(0, Math.max(0, maxLength - 3))}...`;
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
