/**
 * Next actions as buttons (SSOT 2026-11-11, Z): "이렇게 대화 완료(대기)처리된후에 다음 행동을 3개씩 주는데 이걸
 * 버튼으로 표현해줘. 카드 펼쳤을때랑 디테일에 버튼으로 보여줘. 기존 입력처림할지 어떻게 할지는 니가 리서치해서 알아서
 * 1안으로 처리"
 *
 * An Executive Summary ends with its Next Actions: up to 3 steps (epic: 5), each in its own fenced block, usually under
 * a line that says what it does (`src/local/skills/es/reference/templates/*.md`, summary-service MODE_TEMPLATES). This
 * reads them out of an answer's markdown, so the open task card and the detail card can draw them as buttons; a press
 * sends the block as the viewer's instruction on the session's command route — the composer's own path.
 *
 * Pure and tolerant: `#` headings or a whole-line bold title, numbered or indented steps, a language tag on the fence.
 * Only the last Next Actions section counts (the summary closes the answer), and it ends at the next heading of its
 * level or higher, or a rule — the ⚠️ User follow-up required section after it holds the user's own commands, not
 * next actions.
 */

export interface NextAction {
  /** What the step does — the text line above its block, without list marker, emphasis or trailing colon. '' when none. */
  label: string;
  /** The block's text, dedented: what a press sends. */
  command: string;
  /** The label said it is the recommended one: (권장) · (추천) · (recommended). */
  recommended?: true;
}

/** The es templates allow 3 steps (brief, issue) or 5 (epic). */
export const NEXT_ACTIONS_MAX = 5;
/** A block longer than this is a listing, not a step to send. */
const COMMAND_MAX_CHARS = 2000;
const LABEL_MAX_CHARS = 120;

const TITLE =
  /^(?:(?:suggested\s+)?next\s+(?:actions?|steps?)|다음\s*(?:행동|액션|단계|할\s*일|작업))(?:\s*[(（][^)）]*[)）])?$/i;
const ATX_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const RULE = /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const RECOMMENDED = /\s*[(（]\s*(?:권장|추천|recommended)\s*[)）]/gi;
/** A bold line is a heading below every `#` level: it ends only a bold-titled section. */
const BOLD_LEVEL = 7;
const RULE_LEVEL = 0;

interface Mark {
  line: number;
  level: number;
  next: boolean;
}

function isNextTitle(text: string): boolean {
  const t = text
    .replace(/\*\*|__/g, '')
    .replace(/[:：]\s*$/, '')
    .trim()
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  return TITLE.test(t);
}

function fenceCloses(line: string, ch: string, len: number): boolean {
  const t = line.trim();
  return t.length >= len && t === ch.repeat(t.length);
}

function dedent(lines: string[]): string {
  let min = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    if (!l.trim()) continue;
    const n = l.length - l.trimStart().length;
    if (n < min) min = n;
  }
  const cut = Number.isFinite(min) ? min : 0;
  return lines
    .map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length)))
    .join('\n')
    .trim();
}

function cleanLabel(raw: string): { label: string; recommended: boolean } {
  let t = raw
    .trim()
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[:：]$/, '')
    .trim();
  const recommended = RECOMMENDED.test(t);
  RECOMMENDED.lastIndex = 0;
  t = t.replace(RECOMMENDED, '').trim();
  const chars = Array.from(t);
  if (chars.length > LABEL_MAX_CHARS)
    t = `${chars
      .slice(0, LABEL_MAX_CHARS - 1)
      .join('')
      .trimEnd()}…`;
  return { label: t, recommended };
}

/** The next actions an answer ends with — [] when it has no Next Actions section. */
export function extractNextActions(markdown: string | null | undefined): NextAction[] {
  if (typeof markdown !== 'string' || !markdown) return [];
  const lines = markdown.split(/\r?\n/);

  // Headings and rules outside code: where sections start and end.
  const marks: Mark[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (fenceCloses(line, fence.ch, fence.len)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { ch: open[2][0], len: open[2].length };
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    if (atx) {
      marks.push({ line: i, level: atx[1].length, next: isNextTitle(atx[2]) });
      continue;
    }
    const bold = BOLD_LINE.exec(line);
    if (bold) {
      marks.push({ line: i, level: BOLD_LEVEL, next: isNextTitle(bold[1]) });
      continue;
    }
    if (RULE.test(line)) marks.push({ line: i, level: RULE_LEVEL, next: false });
  }

  let head = -1;
  for (let m = marks.length - 1; m >= 0; m--) {
    if (marks[m].next) {
      head = m;
      break;
    }
  }
  if (head < 0) return [];
  const start = marks[head].line + 1;
  let end = lines.length;
  for (let m = head + 1; m < marks.length; m++) {
    if (marks[m].level <= marks[head].level) {
      end = marks[m].line;
      break;
    }
  }

  // Each block, with the nearest text line above it as its label.
  const out: NextAction[] = [];
  let label = '';
  for (let i = start; i < end && out.length < NEXT_ACTIONS_MAX; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      if (lines[i].trim()) label = lines[i];
      continue;
    }
    const ch = open[2][0];
    const len = open[2].length;
    const body: string[] = [];
    let j = i + 1;
    while (j < end && !fenceCloses(lines[j], ch, len)) body.push(lines[j++]);
    i = j;
    const command = dedent(body);
    if (command && command.length <= COMMAND_MAX_CHARS) {
      const c = cleanLabel(label);
      out.push(c.recommended ? { label: c.label, command, recommended: true } : { label: c.label, command });
    }
    label = '';
  }
  return out;
}

/** For a turn projection: the answer's next actions, or undefined when it has none (the field stays off the wire). */
export function nextActionsOf(markdown: string | null | undefined): NextAction[] | undefined {
  const list = extractNextActions(markdown);
  return list.length ? list : undefined;
}
