/**
 * #1074 T4 — two versions of a text artifact compared line by line (an HTML source, markdown, text).
 */

import { describe, expect, it } from 'vitest';
import { lineDiff, MAX_DIFF_EDITS, MAX_DIFF_LINES } from '../artifact-diff';

describe('#1074 T4 — line diff between two versions', () => {
  it('the same text → no hunks', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual({ text: '', added: 0, removed: 0, truncated: false });
  });

  it('a changed line in the middle → one hunk with 3 lines of context', () => {
    const before = [
      '<html>',
      '<body>',
      '<h1>Report</h1>',
      '<p>old</p>',
      '<footer/>',
      '</body>',
      '</html>',
      'x',
      'y',
    ].join('\n');
    const after = before.replace('<p>old</p>', '<p>new</p>');
    const d = lineDiff(before, after);
    expect(d).toMatchObject({ added: 1, removed: 1, truncated: false });
    expect(d.text).toBe(
      [
        '@@ -1,7 +1,7 @@',
        ' <html>',
        ' <body>',
        ' <h1>Report</h1>',
        '-<p>old</p>',
        '+<p>new</p>',
        ' <footer/>',
        ' </body>',
        ' </html>',
      ].join('\n'),
    );
  });

  it('changes far apart are separate hunks; additions at the end and removals at the start count', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = [...before.slice(1), 'line 20', 'line 21'];
    const d = lineDiff(before.join('\n'), after.join('\n'));
    expect(d).toMatchObject({ added: 2, removed: 1 });
    expect(d.text.split('\n').filter((l) => l.startsWith('@@'))).toEqual(['@@ -1,4 +1,3 @@', '@@ -18,3 +17,5 @@']);
  });

  it('from empty and to empty', () => {
    expect(lineDiff('', 'a\nb')).toMatchObject({ added: 2, removed: 0, text: '@@ -0,0 +1,2 @@\n+a\n+b' });
    expect(lineDiff('a', '')).toMatchObject({ added: 0, removed: 1, text: '@@ -1,1 +0,0 @@\n-a' });
  });

  it('CRLF and LF are the same lines', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n').text).toBe('');
  });

  it('too long or too different → truncated, never a runaway request', () => {
    const long = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => String(i)).join('\n');
    expect(lineDiff(long, 'x').truncated).toBe(true);
    const a = Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: MAX_DIFF_EDITS }, (_, i) => `b${i}`).join('\n');
    expect(lineDiff(a, b).truncated).toBe(true);
  });
});
