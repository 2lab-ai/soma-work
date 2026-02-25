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

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: title, emoji: true },
      },
    ];

    // Single context line: workflow + owner + links + closed
    const contextElements: any[] = [];
    contextElements.push({ type: 'mrkdwn', text: `\`${workflow}\`` });

    if (owner) {
      contextElements.push({ type: 'mrkdwn', text: `*${owner}*` });
    }

    const linkParts = this.formatLinks(data.links);
    for (const linkText of linkParts) {
      contextElements.push({ type: 'mrkdwn', text: linkText });
    }

    if (data.closed) {
      contextElements.push({ type: 'mrkdwn', text: '_종료됨_' });
    }

    if (contextElements.length > 0) {
      blocks.push({
        type: 'context',
        elements: contextElements,
      });
    }

    const textParts: string[] = [title];
    if (owner) textParts.push(owner);
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
      parts.push(`<${links.issue.url}|${label}>`);
    }

    if (links.pr?.url && !this.isSlackMessageUrl(links.pr.url)) {
      const label = links.pr.label || 'PR';
      parts.push(`<${links.pr.url}|${label}>`);
    }

    if (links.doc?.url && !this.isSlackMessageUrl(links.doc.url)) {
      const label = links.doc.label || 'Doc';
      parts.push(`<${links.doc.url}|${label}>`);
    }

    return parts;
  }

  private static isSlackMessageUrl(url: string): boolean {
    return url.includes('slack.com/archives/') || url.includes('app.slack.com/client/');
  }
}
