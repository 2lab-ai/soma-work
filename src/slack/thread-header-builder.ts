import { ActivityState, SessionLinks, WorkflowType, ConversationSession } from '../types';
import { MessageFormatter } from './message-formatter';
import { DEFAULT_MODEL, userSettingsStore } from '../user-settings-store';

export interface ThreadHeaderData {
  title?: string;
  workflow?: WorkflowType;
  ownerName?: string;
  ownerId?: string;
  model?: string;
  activityState?: ActivityState;
  agentPhase?: string;
  activeTool?: string;
  lastActivity?: Date;
  links?: SessionLinks;
}

export interface ThreadHeaderPayload {
  text: string;
  blocks?: any[];
  attachments?: any[];
}

const STATUS_STYLE = {
  working: { label: '작업 중', color: '#F2C744', emoji: '⚙️' },
  waiting: { label: '입력 대기', color: '#3B82F6', emoji: '✋' },
  idle: { label: '대기', color: '#36a64f', emoji: '✅' },
} as const;

export class ThreadHeaderBuilder {
  static getStatusStyle(state?: ActivityState): { label: string; color: string; emoji: string } {
    if (state === 'working') return STATUS_STYLE.working;
    if (state === 'waiting') return STATUS_STYLE.waiting;
    return STATUS_STYLE.idle;
  }

  static fromSession(session: ConversationSession): ThreadHeaderPayload {
    return this.build({
      title: session.title,
      workflow: session.workflow,
      ownerName: session.ownerName,
      ownerId: session.ownerId,
      model: session.model,
      activityState: session.activityState,
      agentPhase: session.actionPanel?.agentPhase,
      activeTool: session.actionPanel?.activeTool,
      lastActivity: session.lastActivity,
      links: session.links,
    });
  }

  static build(data: ThreadHeaderData): ThreadHeaderPayload {
    const status = this.getStatusStyle(data.activityState);
    const title = data.title || data.links?.pr?.label || data.links?.issue?.label || 'Session';
    const workflow = data.workflow || 'default';
    const owner = data.ownerName || data.ownerId;
    const modelDisplay = data.model
      ? userSettingsStore.getModelDisplayName(data.model as any)
      : userSettingsStore.getModelDisplayName(DEFAULT_MODEL);
    const agentStatus = this.formatAgentStatus(data.agentPhase, data.activeTool, data.activityState);
    const lastActivity = data.lastActivity || new Date();
    const timeAgo = MessageFormatter.formatTimeAgo(lastActivity);
    const expiresIn = MessageFormatter.formatExpiresIn(lastActivity);

    const headerText = `${status.emoji} *${title}*  ·  \`${workflow}\`  ·  *${status.label}*`;

    const metaElements: any[] = [];
    if (owner) {
      metaElements.push({ type: 'mrkdwn', text: `👤 ${owner}` });
    }
    if (agentStatus) {
      metaElements.push({ type: 'mrkdwn', text: `🧠 ${agentStatus}` });
    }
    metaElements.push({ type: 'mrkdwn', text: `🤖 ${modelDisplay}` });
    metaElements.push({ type: 'mrkdwn', text: `🕐 ${timeAgo}` });
    metaElements.push({ type: 'mrkdwn', text: `⏳ ${expiresIn}` });

    const linkParts = this.formatLinks(data.links);
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerText },
      },
      {
        type: 'context',
        elements: metaElements,
      },
    ];

    if (linkParts.length > 0) {
      blocks.push({
        type: 'context',
        elements: linkParts.map((text) => ({ type: 'mrkdwn', text })),
      });
    }

    const textParts: string[] = [headerText];
    if (owner) textParts.push(`👤 ${owner}`);
    if (agentStatus) textParts.push(`🧠 ${agentStatus}`);
    textParts.push(`🤖 ${modelDisplay} | 🕐 ${timeAgo} | ⏳ ${expiresIn}`);
    if (linkParts.length > 0) textParts.push(linkParts.join(' · '));

    return {
      text: textParts.join('\n'),
      blocks,
    };
  }

  private static formatLinks(links?: SessionLinks): string[] {
    if (!links) return [];
    const parts: string[] = [];

    if (links.issue?.url && !this.isSlackMessageUrl(links.issue.url)) {
      const label = links.issue.label || 'Issue';
      parts.push(`🎫 <${links.issue.url}|${label}>`);
    }

    if (links.pr?.url && !this.isSlackMessageUrl(links.pr.url)) {
      const label = links.pr.label || 'PR';
      parts.push(`🔀 <${links.pr.url}|${label}>`);
    }

    if (links.doc?.url && !this.isSlackMessageUrl(links.doc.url)) {
      const label = links.doc.label || 'Doc';
      parts.push(`📄 <${links.doc.url}|${label}>`);
    }

    return parts;
  }

  private static isSlackMessageUrl(url: string): boolean {
    return url.includes('slack.com/archives/') || url.includes('app.slack.com/client/');
  }

  private static formatAgentStatus(
    agentPhase?: string,
    activeTool?: string,
    activityState?: ActivityState
  ): string | undefined {
    if (activeTool) {
      if (activeTool.startsWith('mcp__')) {
        const parts = activeTool.split('__');
        const server = parts[1] || 'mcp';
        const toolName = parts.slice(2).join('__');
        return toolName ? `${server}:${toolName}` : server;
      }
      return activeTool;
    }

    if (agentPhase) {
      return agentPhase;
    }

    if (activityState === 'working') return '응답 생성 중';
    if (activityState === 'waiting') return '입력 대기 중';
    return undefined;
  }
}
