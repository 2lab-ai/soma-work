/**
 * SSOT 2026-11-02 T2–T4 — the dashboard shows a prompt's AI advice in full.
 *
 * The card shows one line, so the page puts a box under it (acPaintAdvice): the
 * recommendation, what the call does and why it is risky — red or green — and
 * colours the card itself through data-ai (its Approve turns red or green). The
 * box is filled with text nodes only: model text never becomes markup. Runs the
 * shipped client code, cut out of renderDashboardPage().
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
  const at = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`client function ${name} not found`);
  return cook(TEMPLATE.slice(at + 1, TEMPLATE.indexOf('\n}\n', at) + 2));
}

/** A minimal element: attributes, a class list, children as text — enough for acPaintAdvice. */
class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  hidden = false;
  className = '';
  text = '';
  _adviceSig?: string;
  nextElementSibling: FakeEl | null = null;
  classList = { contains: (c: string) => this.className.split(' ').includes(c) };
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  /** Markup was never written into this element. */
  innerHTML = '';
}
const doc = {
  createElement: () => new FakeEl(),
  createTextNode: (t: string) => Object.assign(new FakeEl(), { text: t }),
};

function load(viewer: string, details: Record<string, unknown>) {
  const names = ['document', '_viewerUserId', 'isSiblingSession', '_permDetails', 'toNum'];
  const body = `${[
    'isPermissionRequester',
    'acPermissionLock',
    'acPermissionAdvice',
    'acPaintAdvice',
    'acSlotHtml',
    'escAttr',
    'esc',
  ]
    .map(clientFn)
    .join('\n')}\nreturn { acPermissionAdvice, acPaintAdvice, acSlotHtml };`;
  return new Function(...names, body)(
    doc,
    viewer,
    () => false,
    details,
    (v: unknown) => Number(v) || 0,
  ) as {
    acPermissionAdvice(s: unknown, p: unknown): Record<string, string> | null;
    acPaintAdvice(el: FakeEl, a: unknown): void;
    acSlotHtml(key: string, kind: string, mk: string, id: string, fallback: string): string;
  };
}

const RED = { recommendation: 'deny', summary: '<b>홈 폴더</b>를 지웁니다', risk: '되돌릴 수 없습니다' };
const s = { key: 'C1:t1' };
const p = (rec: string) => ({ approvalId: 'ap1', toolName: 'Bash', requesterId: 'U1', aiRecommendation: rec });

function slot() {
  const card = new FakeEl();
  const box = Object.assign(new FakeEl(), { className: 'ac-advice', hidden: true });
  card.nextElementSibling = box;
  return { card, box };
}

describe('dashboard permission advice box', () => {
  it('a permission slot carries an empty advice box after its card; other slots do not', () => {
    const c = load('U1', {});
    expect(c.acSlotHtml('k', 'perm', 'p|ap1', 'ap1', 'x')).toContain(
      '</ui-approval-card><div class="ac-advice" hidden></div></div>',
    );
    expect(c.acSlotHtml('k', 'question', 'q', '', 'x')).not.toContain('ac-advice');
  });

  it('T4 red: the requester sees the head, what it does, why it is risky and the second-ask note; the card is red', () => {
    const c = load('U1', { ap1: { input: '{}', advice: RED } });
    const { card, box } = slot();
    c.acPaintAdvice(card, c.acPermissionAdvice(s, p('deny')));
    expect(card.attrs['data-ai']).toBe('deny');
    expect(box.hidden).toBe(false);
    expect(box.attrs['data-ai']).toBe('deny');
    const all = box.textContent;
    expect(all).toContain('🔴 AI 권고: 실행하지 마세요');
    expect(all).toContain('무엇을 하나');
    expect(all).toContain('<b>홈 폴더</b>를 지웁니다'); // as text, never markup
    expect(all).toContain('되돌릴 수 없습니다');
    expect(all).toContain('승인하면 한 번 더 묻습니다');
    expect(box.innerHTML).toBe('');
  });

  it('T3 green: the card and the box are green', () => {
    const c = load('U1', { ap1: { input: '{}', advice: { recommendation: 'approve', summary: 's', risk: 'r' } } });
    const { card, box } = slot();
    c.acPaintAdvice(card, c.acPermissionAdvice(s, p('approve')));
    expect(card.attrs['data-ai']).toBe('approve');
    expect(box.textContent).toContain('🟢 AI 추천: 승인해도 됩니다');
  });

  it('another viewer sees the recommendation only — the reasons are requester-only', () => {
    const c = load('U2', { ap1: { input: '{}', advice: RED } });
    const { card, box } = slot();
    c.acPaintAdvice(card, c.acPermissionAdvice(s, p('deny')));
    expect(box.textContent).toContain('🔴 AI 권고');
    expect(box.textContent).not.toContain('되돌릴 수 없습니다');
  });

  it('no advice: the box stays hidden and the card has no colour', () => {
    const c = load('U1', {});
    const { card, box } = slot();
    card.setAttribute('data-ai', 'deny');
    c.acPaintAdvice(card, c.acPermissionAdvice(s, { approvalId: 'ap1', requesterId: 'U1' }));
    expect(card.attrs['data-ai']).toBeUndefined();
    expect(box.hidden).toBe(true);
  });

  it('the page colours the card through its own tokens, by data-ai', () => {
    expect(TEMPLATE).toContain('ui-approval-card[data-ai="deny"] { --ac-primary: var(--st-fail);');
    expect(TEMPLATE).toContain('ui-approval-card[data-ai="approve"] { --ac-primary: var(--st-done);');
  });
});
