/**
 * WebRefs tests (Issue #412)
 */

import { describe, expect, it } from 'vitest';
import { extractWebMessageRef, extractWebRef, webMessageHandle, webTarget } from './web-refs.js';

describe('WebRefs', () => {
  describe('webTarget', () => {
    it('creates a web ConversationTarget', () => {
      const target = webTarget('C123:root', 'U456');

      expect(target.platform).toBe('web');
      expect(target.userId).toBe('U456');
      const ref = extractWebRef(target);
      expect(ref.sessionKey).toBe('C123:root');
      expect(ref.userId).toBe('U456');
    });

    it('supports threadId', () => {
      const target = webTarget('C123:root', 'U456', 'thread-1');

      const ref = extractWebRef(target);
      expect(ref.threadId).toBe('thread-1');
    });
  });

  describe('webMessageHandle', () => {
    it('creates a web MessageHandle', () => {
      const handle = webMessageHandle('C123:root', 'msg-abc');

      expect(handle.platform).toBe('web');
      const ref = extractWebMessageRef(handle);
      expect(ref.sessionKey).toBe('C123:root');
      expect(ref.messageId).toBe('msg-abc');
      expect(ref.timestamp).toBeGreaterThan(0);
    });
  });
});
