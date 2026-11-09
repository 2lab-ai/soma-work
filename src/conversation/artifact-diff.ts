/**
 * #1074 — the line-by-line difference between two versions of a text artifact (an HTML source, markdown,
 * text). Myers' O((N+M)·D) diff over lines, shown as unified hunks with 3 lines of context.
 *
 * Bounded: each side at most MAX_DIFF_LINES lines, and the edit distance at most MAX_DIFF_EDITS — past
 * either, the result says `truncated` instead of spending the request on it.
 */

export const MAX_DIFF_LINES = 20_000;
export const MAX_DIFF_EDITS = 2_000;
const CONTEXT = 3;

export interface LineDiff {
  /** Unified hunks (`@@ -a,b +c,d @@`, then ` `, `-`, `+` lines); '' when the two are the same. */
  text: string;
  added: number;
  removed: number;
  /** Too large or too different to diff line by line. */
  truncated: boolean;
}

type Op = { t: ' ' | '-' | '+'; line: string };

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The edit script from a to b, or null when it needs more than maxEdits edits. */
function myers(a: string[], b: string[], maxEdits: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = the furthest x on diagonals -d-1 … d+1 before round d (index k + d + 1): O(D²) memory, not O(D·N).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
      let x = down ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  const snake = (toX: number, toY: number) => {
    while (x > toX && y > toY) {
      x--;
      y--;
      ops.push({ t: ' ', line: a[x] });
    }
  };
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    snake(prevX, prevX - prevK);
    if (x === prevX) {
      y--;
      ops.push({ t: '+', line: b[y] });
    } else {
      x--;
      ops.push({ t: '-', line: a[x] });
    }
  }
  snake(0, 0);
  return ops.reverse();
}

function hunks(ops: Op[]): string {
  const out: string[] = [];
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  const pos: Array<{ a: number; b: number }> = [];
  for (const op of ops) {
    pos.push({ a: aLine, b: bLine });
    if (op.t !== '+') aLine++;
    if (op.t !== '-') bLine++;
  }
  while (i < ops.length) {
    if (ops[i].t === ' ') {
      i++;
      continue;
    }
    let start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend over changes whose context windows touch.
    for (;;) {
      while (end < ops.length && ops[end].t !== ' ') end++;
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === ' ') run++;
      if (end + run < ops.length && run <= 2 * CONTEXT) end += run;
      else {
        end = Math.min(ops.length, end + CONTEXT);
        break;
      }
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    const aStart = aCount ? pos[start].a : pos[start].a - 1;
    const bStart = bCount ? pos[start].b : pos[start].b - 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    i = end;
    start = end;
  }
  return out.join('\n');
}

/** The line diff from `before` to `after`. */
export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES)
    return { text: '', added: 0, removed: 0, truncated: true };
  const ops = myers(a, b, MAX_DIFF_EDITS);
  if (!ops) return { text: '', added: 0, removed: 0, truncated: true };
  return {
    text: hunks(ops),
    added: ops.filter((o) => o.t === '+').length,
    removed: ops.filter((o) => o.t === '-').length,
    truncated: false,
  };
}
