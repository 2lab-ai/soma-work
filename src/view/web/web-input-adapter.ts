/**
 * WebInputAdapter — HTTP/WebSocket input adapter stub (Issue #412)
 *
 * Translates Web Dashboard user actions into normalized InputEvents.
 * Full implementation will wire into Fastify routes in a future phase.
 *
 * Sources:
 * - POST /api/dashboard/session/:key/command → message events
 * - WebSocket messages → command/action events
 * - Form submissions → form_submit events
 */

import type { InputAdapter, InputHandler } from '../input.js';
import type { Platform } from '../types.js';

export class WebInputAdapter implements InputAdapter {
  readonly platform: Platform = 'web';

  onInput(_handler: InputHandler): void {
    // Will store handler when Fastify routes are wired in Phase 7
  }

  async start(): Promise<void> {
    // Will register Fastify routes and WebSocket handlers in Phase 7
  }

  async stop(): Promise<void> {
    // Will clean up handler when Fastify routes are wired in Phase 7
  }
}
