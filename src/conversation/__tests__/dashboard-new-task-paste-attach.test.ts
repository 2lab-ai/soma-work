/**
 * Dashboard "New task" — a paste too long for the instruction goes in as a text file (SSOT 2026-11-04).
 *
 * "지금 new task에서 12000자 이상 못넣는데 만약 붙여넣는데 너무 크면 첨부 파일로 처리해줘. pasted text 첨부 파일 처리"
 *
 * The instruction is capped at NEW_TASK_LIMITS.maxPromptChars (12,000). A plain-text paste that would take the field
 * past it is attached as `pasted-text-<stamp>.txt` instead of going into the field, so the task still starts with
 * the whole text (file-handler.ts gives the session its path). A dashboard task takes no attachments yet (D8): its
 * paste is left alone and the limit is said on send.
 *
 * Same harness as dashboard-new-task-client.test.ts: the shipped client functions are cut out of
 * renderDashboardPage()'s template literal, cooked as the browser receives them, and run against fakes.
 *
 * Test ids map to the INTENT-TASK-TREE: I1.1 the paste becomes an attachment.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const plain = TEMPLATE.indexOf(`\nfunction ${name}(`);
  const start = plain >= 0 ? plain : TEMPLATE.indexOf(`\nasync function ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function loadWith<T>(fns: string[], globals: Record<string, unknown>): T {
  const names = Object.keys(globals);
  const body = `${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => globals[n])) as T;
}

const LIMITS = { maxPromptChars: 12000, maxFiles: 10, maxFileBytes: 20971520, maxTotalBytes: 31457280 };

/** A <ui-composer> as the handler sees it: its value, its data, and addFiles taking what it is given. */
function fakeComposer(value: string, opts: { disabled?: boolean; refuse?: boolean } = {}) {
  const added: File[][] = [];
  return {
    value,
    data: opts.disabled ? { disabled: true } : {},
    added,
    addFiles(list: File[]) {
      added.push(list);
      return opts.refuse ? [] : list;
    },
  };
}

/** A paste event at the composer host: the clipboard, the field it lands in (composedPath()[0]) and its selection. */
function pasteEvent(
  composer: ReturnType<typeof fakeComposer>,
  text: string,
  opts: { files?: File[]; selection?: [number, number] } = {},
) {
  const at = composer.value.length;
  const [selectionStart, selectionEnd] = opts.selection ?? [at, at];
  // The textarea: setRangeText edits its text (and the composer's value with it), an input event follows.
  const field = {
    selectionStart,
    selectionEnd,
    inputs: 0,
    setRangeText(text: string, start: number, end: number) {
      composer.value = composer.value.slice(0, start) + text + composer.value.slice(end);
    },
    dispatchEvent(ev: Event) {
      if (ev.type === 'input') field.inputs++;
      return true;
    },
  };
  const ev = {
    prevented: false,
    currentTarget: composer,
    clipboardData: {
      files: opts.files ?? [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
    composedPath: () => [field, composer],
    preventDefault() {
      ev.prevented = true;
    },
    field,
  };
  return ev;
}

type Api = {
  ntOnComposerPaste(e: unknown): void;
  ntPasteOverflows(value: string, selStart: unknown, selEnd: unknown, pasted: string, max: number): boolean;
  ntPastedTextName(d: Date): string;
};
function api(state: Record<string, unknown> | null, limits: unknown = LIMITS): Api {
  return loadWith<Api>(['ntOnComposerPaste', 'ntPasteOverflows', 'ntPastedTextName'], {
    _ntState: state,
    _ntCtx: { limits },
  });
}

describe('I1.1 — a paste that would take the instruction past 12,000 characters is attached as a text file', () => {
  it('the overflow is the field after the paste: its text, less a selection the paste replaces, plus the paste', () => {
    const { ntPasteOverflows } = api({ destination: 'slack' });
    expect(ntPasteOverflows('a'.repeat(11000), 11000, 11000, 'b'.repeat(1000), 12000)).toBe(false);
    expect(ntPasteOverflows('a'.repeat(11000), 11000, 11000, 'b'.repeat(1001), 12000)).toBe(true);
    expect(ntPasteOverflows('', 0, 0, 'b'.repeat(12001), 12000)).toBe(true);
    // The whole field selected: the paste replaces it.
    expect(ntPasteOverflows('a'.repeat(12000), 0, 12000, 'b'.repeat(5000), 12000)).toBe(false);
    // No selection known: the paste goes at the end.
    expect(ntPasteOverflows('a'.repeat(11000), undefined, undefined, 'b'.repeat(1001), 12000)).toBe(true);
    // No limit known: nothing overflows.
    expect(ntPasteOverflows('', 0, 0, 'b'.repeat(50000), 0)).toBe(false);
  });

  it('names the file pasted-text-<date>-<time>.txt (the composer names a pasted screenshot the same way)', () => {
    const { ntPastedTextName } = api({ destination: 'slack' });
    expect(ntPastedTextName(new Date(2026, 10, 4, 9, 5, 7))).toBe('pasted-text-20261104-090507.txt');
  });

  it('a long paste into a Slack task: the text does not go into the field, a text/plain file with all of it is attached', async () => {
    const composer = fakeComposer('지시: 아래 로그 분석해줘\n');
    const big = '로그 한 줄\n'.repeat(3000); // 21,000 characters
    const ev = pasteEvent(composer, big);
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(true);
    expect(composer.added).toHaveLength(1);
    const [file] = composer.added[0];
    expect(file.name).toMatch(/^pasted-text-\d{8}-\d{6}\.txt$/);
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe(big);
  });

  it('a file the composer refuses (10 files already, or over a size cap): the paste goes into the field, never lost', () => {
    const composer = fakeComposer('', { refuse: true });
    const ev = pasteEvent(composer, 'x'.repeat(13000));
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(composer.added).toHaveLength(1); // it was offered
    expect(ev.prevented).toBe(false); // and, refused, the text is pasted as usual
  });

  it('a long paste over a selection replaces it: the selected text leaves the field, the paste is the file', () => {
    const composer = fakeComposer('keep me OLD instruction to replace');
    const ev = pasteEvent(composer, 'x'.repeat(13000), { selection: [8, 34] });
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(true);
    expect(composer.added).toHaveLength(1);
    expect(composer.value).toBe('keep me ');
    expect(ev.field.inputs).toBe(1); // the composer's counter and the draft follow (ui-input)
  });

  it('with no selection the field is not touched', () => {
    const composer = fakeComposer('지시');
    const ev = pasteEvent(composer, 'x'.repeat(13000));
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(composer.value).toBe('지시');
    expect(ev.field.inputs).toBe(0);
  });

  it('a paste that fits is left to the field', () => {
    const composer = fakeComposer('짧은 지시');
    const ev = pasteEvent(composer, '조금 더');
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(false);
    expect(composer.added).toHaveLength(0);
  });

  it('a paste that replaces a selection and then fits is left to the field', () => {
    const composer = fakeComposer('a'.repeat(12000));
    const ev = pasteEvent(composer, 'b'.repeat(5000), { selection: [0, 12000] });
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(false);
    expect(composer.added).toHaveLength(0);
  });

  it('clipboard files are the composer’s own (it attaches them); the handler leaves that paste alone', () => {
    const composer = fakeComposer('');
    const shot = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
    const ev = pasteEvent(composer, 'x'.repeat(13000), { files: [shot] });
    api({ destination: 'slack' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(false);
    expect(composer.added).toHaveLength(0);
  });

  it('a dashboard task takes no attachments yet (D8): its long paste goes into the field and the limit is said on send', () => {
    const composer = fakeComposer('');
    const ev = pasteEvent(composer, 'x'.repeat(13000));
    api({ destination: 'task' }).ntOnComposerPaste(ev);
    expect(ev.prevented).toBe(false);
    expect(composer.added).toHaveLength(0);
  });

  it('a disabled composer, or no limits yet: nothing happens', () => {
    const off = fakeComposer('', { disabled: true });
    const ev1 = pasteEvent(off, 'x'.repeat(13000));
    api({ destination: 'slack' }).ntOnComposerPaste(ev1);
    expect(ev1.prevented).toBe(false);
    expect(off.added).toHaveLength(0);

    const composer = fakeComposer('');
    const ev2 = pasteEvent(composer, 'x'.repeat(13000));
    api({ destination: 'slack' }, null).ntOnComposerPaste(ev2);
    expect(ev2.prevented).toBe(false);
    expect(composer.added).toHaveLength(0);
  });

  it('the new task composer listens for the paste (ntInit wires it)', () => {
    expect(clientFn('ntInit')).toContain("composer.addEventListener('paste', ntOnComposerPaste)");
  });
});
