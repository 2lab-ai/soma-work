import { Logger } from '../logger.js';

const logger = new Logger('SummaryService');

/**
 * Summary prompt template — fixed, not user-configurable.
 * Trace: docs/turn-summary-lifecycle/trace.md, S3, Section 2
 */
export const SUMMARY_PROMPT = `현재 active issue, pr 각각에 대해 as-is to-be 형태로 리포트
stv:verify를 해주고 active issue, pr을 종합하여 executive summary

다음 유저가 내릴만한 행동을 3개 정도 제시해줘. 각각 복사하기 쉽게 코드 블럭으로 제시`;

/**
 * Minimal session interface for summary operations.
 * Avoids importing the full ConversationSession type to keep this module testable.
 */
export interface SummarySessionInfo {
  isActive: boolean;
  model?: string;
  workingDirectory?: string;
  links?: {
    issue?: { url: string; label?: string; title?: string };
    pr?: { url: string; label?: string; title?: string };
  };
  actionPanel?: {
    summaryBlocks?: any[];
    [key: string]: any;
  };
}

/**
 * Function type for executing a prompt against a forked session.
 * Injected at construction time — production wiring provides the real implementation,
 * tests provide a mock.
 *
 * @param prompt - The full summary prompt to execute
 * @param model - Model to use (from session)
 * @returns The LLM's response text, or null on failure
 */
export type ForkExecutor = (prompt: string, model?: string) => Promise<string | null>;

/**
 * Handles executive summary generation and display.
 *
 * - execute(): builds prompt from session context, calls forkExecutor, returns response
 * - displayOnThread(): sets summaryBlocks on actionPanel for ThreadSurface rendering
 * - clearDisplay(): removes summaryBlocks, triggers re-render
 *
 * Trace: docs/turn-summary-lifecycle/trace.md, S3 + S5
 */
export class SummaryService {
  private forkExecutor: ForkExecutor;

  /**
   * @param forkExecutor - Injected function that executes prompt via forked session.
   *   If not provided, falls back to returning the prompt text (stub behavior for testing).
   */
  constructor(forkExecutor?: ForkExecutor) {
    this.forkExecutor = forkExecutor ?? (async (prompt) => prompt);
  }

  /**
   * Build the full summary prompt from session context + template.
   */
  buildPrompt(session: SummarySessionInfo): string {
    const contextParts: string[] = [];
    if (session.links?.issue) {
      contextParts.push(`Active Issue: ${session.links.issue.url} (${session.links.issue.title || session.links.issue.label || 'untitled'})`);
    }
    if (session.links?.pr) {
      contextParts.push(`Active PR: ${session.links.pr.url} (${session.links.pr.title || session.links.pr.label || 'untitled'})`);
    }

    return contextParts.length > 0
      ? `${contextParts.join('\n')}\n\n${SUMMARY_PROMPT}`
      : SUMMARY_PROMPT;
  }

  /**
   * Execute summary.prompt via forked session and collect response.
   * Returns the LLM's response text, or null if execution fails.
   *
   * Trace: S3, Section 3b
   */
  async execute(session: SummarySessionInfo): Promise<string | null> {
    if (!session.isActive) {
      logger.warn('Skipping summary — session is not active');
      return null;
    }

    logger.info('Executing summary', {
      model: session.model,
      hasIssue: !!session.links?.issue,
      hasPR: !!session.links?.pr,
    });

    const fullPrompt = this.buildPrompt(session);

    try {
      const response = await this.forkExecutor(fullPrompt, session.model);
      logger.info('Summary fork completed', {
        hasResponse: !!response,
        responseLength: response?.length ?? 0,
      });
      return response;
    } catch (err: any) {
      logger.error('Summary fork failed', { error: err?.message || String(err) });
      return null;
    }
  }

  /**
   * Display summary result on thread header by setting summaryBlocks.
   * ThreadSurface picks these up during its next render cycle.
   *
   * Trace: S3, Section 3c
   */
  displayOnThread(session: SummarySessionInfo, summaryText: string): void {
    if (!session.actionPanel) {
      logger.warn('Cannot display summary — no actionPanel on session');
      return;
    }

    const summaryBlocks = this.buildSummaryBlocks(summaryText);
    session.actionPanel.summaryBlocks = summaryBlocks;

    logger.info('Summary displayed on thread', { blockCount: summaryBlocks.length });
  }

  /**
   * Clear summary display from thread header.
   * Trace: S5, Section 3b
   */
  clearDisplay(session: SummarySessionInfo): void {
    if (!session.actionPanel) return;
    if (!session.actionPanel.summaryBlocks) return;

    session.actionPanel.summaryBlocks = undefined;
    logger.info('Summary cleared from thread');
  }

  /**
   * Convert summary text to Slack Block Kit blocks.
   */
  private buildSummaryBlocks(summaryText: string): any[] {
    return [
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Executive Summary*\n${summaryText}`,
        },
      },
    ];
  }
}
