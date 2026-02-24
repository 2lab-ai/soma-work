import { SessionLinks, WorkflowType, ConversationSession } from '../types';

export interface ThreadHeaderData {
  title?: string;
  workflow?: WorkflowType;
  ownerName?: string;
  ownerId?: string;
  links?: SessionLinks;
  closed?: boolean;
}

export interface ThreadHeaderPayload {
  text: string;
  blocks?: any[];
  attachments?: any[];
}

export class ThreadHeaderBuilder {
  static fromSession(session: ConversationSession, overrides?: { closed?: boolean }): ThreadHeaderPayload {
    return this.build({
      title: session.title,
      workflow: session.workflow,
      ownerName: session.ownerName,
      ownerId: session.ownerId,
      links: session.links,
      ...overrides,
    });
  }

  static build(data: ThreadHeaderData): ThreadHeaderPayload {
    const title = data.title || data.links?.pr?.label || data.links?.issue?.label || 'Session';
    const workflow = data.workflow || 'default';
    const owner = data.ownerName || data.ownerId;
    const icon = data.closed ? '🔒' : '🧵';
    const suffix = data.closed ? '  ·  _종료됨_' : '';
    const headerText = `${icon} *${title}*  ·  \`${workflow}\`${suffix}`;

    const metaElements: any[] = [];
    if (owner) {
      metaElements.push({ type: 'mrkdwn', text: `👤 ${owner}` });
    }

    const linkParts = this.formatLinks(data.links);
    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: headerText },
      },
    ];

    if (metaElements.length > 0) {
      blocks.push({
        type: 'context',
        elements: metaElements,
      });
    }

    if (linkParts.length > 0) {
      blocks.push({
        type: 'context',
        elements: linkParts.map((text) => ({ type: 'mrkdwn', text })),
      });
    }

    const textParts: string[] = [headerText];
    if (owner) textParts.push(`👤 ${owner}`);
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
}
