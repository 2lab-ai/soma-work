/**
 * User media (SSOT 2026-10-25, review gate P3): a files-only first instruction
 * still gives the title prompt something to read — the file names.
 */

import { describe, expect, it } from 'vitest';
import { titleSourceText } from '../title-sub';

describe('titleSourceText', () => {
  it('uses the attached file names when a user turn has no text', () => {
    const text = titleSourceText({
      turns: [
        {
          id: 'u1',
          role: 'user',
          timestamp: 1,
          rawContent: '',
          attachments: [
            { id: 'M1', name: 'login-broken.png', kind: 'image', mime: 'image/png', size: 1, stored: true },
            { id: 'M2', name: 'guide.pdf', kind: 'pdf', mime: 'application/pdf', size: 1, stored: true },
          ],
        },
      ],
    } as any);
    expect(text).toBe('[user]: 📎 login-broken.png · guide.pdf');
  });
});
