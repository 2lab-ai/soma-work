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
/**
 * A line longer than this is body text: never a heading, a rule, a title or a label (trinity R1, fable P1 — a heading
 * regex that backtracked on a long line stalled the server). Every pattern below runs on lines this short, and the
 * structure itself is read with plain string steps, so a whole answer reads in linear time.
 */
const MAX_SCAN_LINE = 500;

const TITLE =
  /^(?:(?:suggested\s+)?next\s+(?:actions?|steps?)|다음\s*(?:행동|액션|단계|할\s*일|작업))(?:\s*[(（][^)）]*[)）])?$/i;
/**
 * The ⚠️ User follow-up required section (auto-es) holds the user's own commands. Its title ends a Next Actions section
 * whatever its form or level — `##`, `###`, bold, or a plain line (trinity R1, P1 from all three panelists).
 */
const FOLLOW_UP_TITLE = /^(?:user\s+)?follow[-\s]?ups?\s+required$|^(?:사용자\s*)?후속\s*(?:조치|작업|확인)?\s*필요$/i;
const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const RECOMMENDED = /\s*[(（]\s*(?:권장|추천|recommended)\s*[)）]/gi;
/** Every `#` level ends at a heading of its own level or higher; a bold title is below them all. */
const EMPHASIS_LEVEL = 7;
/** A rule or a follow-up title ends any section. */
const HARD_END = 0;

interface Mark {
  line: number;
  level: number;
  next: boolean;
}

/** `#`…`######` heading: its level and text (closing `#`s dropped), or null. Linear. */
function atxHeading(line: string): { level: number; text: string } | null {
  if (line.length > MAX_SCAN_LINE) return null;
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  let n = 0;
  while (line[i + n] === '#') n++;
  if (n < 1 || n > 6) return null;
  const rest = line.slice(i + n);
  if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null;
  let text = rest.trim();
  let k = text.length;
  while (k > 0 && text[k - 1] === '#') k--;
  if (k === 0) text = '';
  else if (k < text.length && (text[k - 1] === ' ' || text[k - 1] === '\t')) text = text.slice(0, k).trimEnd();
  return { level: n, text };
}

/** A whole line in `**…**`, `__…__`, `*…*` or `_…_` (a trailing colon allowed): its text, or null. */
function emphasisLine(line: string): string | null {
  if (line.length > MAX_SCAN_LINE) return null;
  let t = line.trim();
  if (t.endsWith(':') || t.endsWith('：')) t = t.slice(0, -1).trimEnd();
  for (const m of ['**', '__', '*', '_']) {
    if (t.length > m.length * 2 && t.startsWith(m) && t.endsWith(m)) {
      // `* note **x**` is a bullet, not `*…*`: a single marker hugs its words (trinity R2, fable P3).
      if (m.length === 1 && (t[1] === ' ' || t[t.length - 2] === ' ')) continue;
      const inner = t.slice(m.length, t.length - m.length).trim();
      return inner || null;
    }
  }
  return null;
}

function isRule(line: string): boolean {
  if (line.length > MAX_SCAN_LINE) return false;
  const t = line.replace(/[ \t]/g, '');
  return t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
}

/** A title's words: emphasis, a trailing colon, a leading emoji or mark and a step number dropped. */
function titleWords(text: string): string {
  return text
    .replace(/\*\*|__/g, '')
    .trim()
    .replace(/[:：]$/, '')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
}

function fenceCloses(line: string, ch: string, len: number): boolean {
  const t = line.trim();
  return t.length >= len && t === ch.repeat(t.length);
}

/** The next non-blank line from `i` opens a fence: a bold line there is the step's label, not a title. */
function labelsABlock(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    return FENCE_OPEN.test(lines[j]);
  }
  return false;
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
    .slice(0, MAX_SCAN_LINE)
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

/** Where sections start and end: headings, bold titles, rules and follow-up titles outside code. */
function sectionMarks(lines: string[]): Mark[] {
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
    if (line.length > MAX_SCAN_LINE) continue;
    if (isRule(line)) {
      marks.push({ line: i, level: HARD_END, next: false });
      continue;
    }
    const atx = atxHeading(line);
    const em = atx ? null : emphasisLine(line);
    const words = titleWords(atx ? atx.text : (em ?? line));
    if (FOLLOW_UP_TITLE.test(words)) {
      marks.push({ line: i, level: HARD_END, next: false });
      continue;
    }
    const next = TITLE.test(words);
    // The ⚠️ mark is reserved for the unfinished-work signal: a heading or bold title that starts with it, however
    // worded, ends the section too (trinity R2, fable P2).
    if (!next && (atx || em !== null) && (atx ? atx.text : (em as string)).startsWith('⚠')) {
      marks.push({ line: i, level: HARD_END, next: false });
      continue;
    }
    if (atx) marks.push({ line: i, level: atx.level, next });
    else if (em !== null) {
      // A bold step label right above its block belongs to the section it sits in.
      if (next || !labelsABlock(lines, i)) marks.push({ line: i, level: EMPHASIS_LEVEL, next });
    }
  }
  return marks;
}

/** The next actions an answer ends with — [] when it has no Next Actions section. */
export function extractNextActions(markdown: string | null | undefined): NextAction[] {
  if (typeof markdown !== 'string' || !markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const marks = sectionMarks(lines);

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
    // A block whose closing fence never comes is a cut-off answer, not a step (trinity R1, fable P3).
    if (j >= end) break;
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

/**
 * The same, for a recorded turn, read once: the conversation route and the live push ask for every answer in their
 * window on every request, and a recorded answer's text never changes (trinity R1, fable P1). Keyed by the turn
 * object the recorder keeps in memory; a turn whose text did change is read again.
 */
const _turnReads = new WeakMap<object, { raw: unknown; value: NextAction[] | undefined }>();
export function nextActionsOfTurn(turn: { rawContent?: string | null } | null | undefined): NextAction[] | undefined {
  if (!turn || typeof turn !== 'object') return undefined;
  const raw = turn.rawContent;
  const hit = _turnReads.get(turn);
  if (hit && hit.raw === raw) return hit.value;
  const value = nextActionsOf(raw);
  _turnReads.set(turn, { raw, value });
  return value;
}
