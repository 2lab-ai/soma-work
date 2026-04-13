/**
 * SlackInputAdapter — InputAdapter implementation for Slack (Issue #409)
 *
 * Normalizes Slack events (messages, commands, actions, file uploads)
 * into platform-agnostic InputEvent objects.
 *
 * This is a stub that demonstrates the adapter pattern.
 * Full integration with Slack Bolt's event routing will happen
 * when SlackHandler is refactored to use the Pipeline (Phase 4).
 *
 * Current Slack event handling path:
 *   Bolt event → EventRouter → SlackHandler.handleMessage → StreamExecutor
 *
 * Target path (Phase 4):
 *   Bolt event → SlackInputAdapter → Pipeline → SlackViewAdapter
 */

import { Logger } from '../../logger.js';
import type { InputAdapter, InputHandler } from '../input.js';
import type { Platform } from '../types.js';

export class SlackInputAdapter implements InputAdapter {
  private logger = new Logger('SlackInputAdapter');
  readonly platform: Platform = 'slack';
  private handler: InputHandler | null = null;

  /**
   * Register the input handler.
   * In Phase 4, this will be connected to Slack Bolt's event listeners.
   */
  onInput(handler: InputHandler): void {
    this.handler = handler;
  }

  /**
   * Start listening for Slack events.
   * Currently a no-op — Slack Bolt's `app.start()` is called separately in index.ts.
   * Phase 4 will move Bolt event wiring here.
   */
  async start(): Promise<void> {
    this.logger.info('SlackInputAdapter started (stub — events routed via legacy path)');
  }

  /**
   * Stop listening.
   */
  async stop(): Promise<void> {
    this.logger.info('SlackInputAdapter stopped');
    this.handler = null;
  }

  /**
   * Get the registered handler for testing/integration.
   * Returns null if no handler is registered.
   */
  getHandler(): InputHandler | null {
    return this.handler;
  }
}
