/**
 * Web View Module — Dashboard view adapter (Issue #412)
 */

// Input adapter (stub)
export { WebInputAdapter } from './web-input-adapter.js';
export type { WebConversationRef, WebMessageRef } from './web-refs.js';
// Opaque reference types
export { extractWebMessageRef, extractWebRef, webMessageHandle, webTarget } from './web-refs.js';
// Response session (native WebSocket streaming)
export { WebResponseSession, type WebSocketBroadcaster } from './web-response-session.js';
// View adapter
export { WebViewAdapter } from './web-view-adapter.js';
