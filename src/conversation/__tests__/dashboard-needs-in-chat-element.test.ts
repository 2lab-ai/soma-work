// @vitest-environment happy-dom
/**
 * SSOT 2026-11-13 — 입력 필요 as the chat's last message, against the real <ui-conversation> (@2lab.ai/ui).
 *
 * The page hands the element the turn the shipped `needsTurnOf` builds and slots #panel-needs into it
 * (`attachments-panel-needs`). Every approval and question then shows only if the element keeps its side of that
 * contract, so a library bump that drops it must fail here, not on a user's screen:
 *
 *   E1  the zone's turn is the last item; its file row holds the slot and #panel-needs is assigned to it
 *   E2  no 원본 disclosure on that turn (its blank source), and no writing row after it (pending off)
 *   E3  a repaint with a new answer keeps the zone assigned and last; the page's convSlots never drops it
 *
 * The shipped page functions are cut out of renderDashboardPage()'s template literal (the harness of
 * dashboard-needs-in-chat-client.test.ts); the element is the installed library's own build.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const DASHBOARD_TS = readFileSync(join(__dirname, '..', 'dashboard.ts'), 'utf-8');
const TEMPLATE = DASHBOARD_TS.slice(DASHBOARD_TS.indexOf('function renderDashboardPage('));

function cook(fragment: string): string {
  if (fragment.includes('`') || fragment.includes('${')) throw new Error('fragment is not a plain template slice');
  return new Function(`return \`${fragment}\`;`)() as string;
}
function clientFn(name: string): string {
  const start = TEMPLATE.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`client function ${name} not found`);
  const end = TEMPLATE.indexOf('\n}\n', start);
  return cook(TEMPLATE.slice(start + 1, end + 2));
}
function clientVar(name: string): string {
  const m = TEMPLATE.match(new RegExp(`^(var ${name} = .*?;)(?:\\s*//.*)?$`, 'm'));
  if (!m) throw new Error(`client var ${name} not found`);
  return cook(m[1]);
}
function load<T>(fns: string[], vars: string[], inject: Record<string, unknown> = {}): T {
  const names = Object.keys(inject);
  const body = `${vars.map(clientVar).join('\n')}\n${fns.map(clientFn).join('\n')}\nreturn { ${fns.join(', ')} };`;
  return new Function(...names, body)(...names.map((n) => inject[n])) as T;
}

type Turn = Record<string, unknown> & { id: string; role: string };
const page = load<{
  needsTurnOf(bot: string): Turn;
  convSetData(el: unknown, d: unknown): void;
  convSlots(el: unknown, slots: unknown[], cid: string): void;
}>(['needsTurnOf', 'convSetData', 'convSlots'], ['NEEDS_TURN_ID', 'NEEDS_TURN_TEXT'], {
  convWatchAnswers: () => {},
  umRegister: () => {},
});

// The element renders in a microtask after its data is set; give it a turn of the event loop.
const settle = () => new Promise((r) => setTimeout(r, 30));

// The DOM happy-dom provides, typed only as far as this test reads it (the project's tsconfig has no DOM lib).
interface Node0 {
  id: string;
  className: string;
  slot: string;
  innerHTML: string;
  data?: unknown;
  dataset: Record<string, string | undefined>;
  parentElement: Node0 | null;
  classList: { contains(c: string): boolean };
  shadowRoot: { querySelectorAll(sel: string): ArrayLike<Node0> } | null;
  querySelector(sel: string): Node0 | null;
  setAttribute(name: string, value: string): void;
  appendChild(node: Node0): Node0;
  assignedElements(): Node0[];
}
const dom = globalThis as unknown as {
  document: { createElement(tag: string): Node0; body: Node0 };
  customElements: { whenDefined(name: string): Promise<unknown> };
};
// The library's own build, by its package export (a string the type checker does not resolve: node module resolution).
const CONVERSATION = '@2lab.ai/ui/conversation';

let conv: Node0;
let box: Node0;
const items = () => Array.from(conv.shadowRoot?.querySelectorAll('ui-log-scroller > [data-item]') ?? []);
const lastItem = () => items()[items().length - 1];

beforeAll(async () => {
  await import(CONVERSATION);
  await dom.customElements.whenDefined('ui-conversation');
  conv = dom.document.createElement('ui-conversation');
  conv.id = 'panel-conv';
  conv.setAttribute('lang', 'ko');
  dom.document.body.appendChild(conv);
  // The page's box, as placePanelNeeds slots it in.
  box = dom.document.createElement('div');
  box.id = 'panel-needs';
  box.className = 'panel-needs';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', '입력 필요');
  box.slot = 'attachments-panel-needs';
  box.innerHTML = '<div class="panel-question"><button type="button">네, dev 먼저</button></div>';
  conv.appendChild(box);
  page.convSetData(conv, {
    turns: [
      { id: 'u1', role: 'user', name: 'Zhuge', text: '리뷰 반영하고 배포 준비해 줘.' },
      { id: 'a1', role: 'assistant', name: 'Soma', markdown: '리뷰 지적 3개를 반영했습니다.' },
      page.needsTurnOf('Soma'),
    ],
    pending: false,
    label: '지시와 답변',
  });
  await settle();
});

describe('the real <ui-conversation> holds 입력 필요 as its last message', () => {
  it('E1 — the zone’s turn is last, its file row holds the slot, and #panel-needs is assigned to it', () => {
    expect(items().map((x) => x.dataset.item)).toEqual(['u1', 'a1', 'panel-needs']);
    const slot = lastItem().querySelector('slot[name="attachments-panel-needs"]');
    expect(slot).not.toBeNull();
    expect(slot?.parentElement?.classList.contains('cv-files')).toBe(true);
    expect(slot?.assignedElements()).toEqual([box]);
  });

  it('E2 — no 원본 disclosure on the zone’s turn, and no writing row after it', () => {
    expect(lastItem().querySelector('[data-act="raw"]')).toBeNull();
    expect(items().some((x) => x.dataset.role === 'pending')).toBe(false);
  });

  it('E3 — a repaint with a new answer keeps the zone assigned and last; convSlots keeps the box', async () => {
    page.convSlots(conv, [], 'c');
    page.convSetData(conv, {
      turns: [
        { id: 'u1', role: 'user', name: 'Zhuge', text: '리뷰 반영하고 배포 준비해 줘.' },
        { id: 'a1', role: 'assistant', name: 'Soma', markdown: '리뷰 지적 3개를 반영했습니다.' },
        { id: 'a2', role: 'assistant', name: 'Soma', markdown: 'dev 배포 계획을 세웠습니다.' },
        page.needsTurnOf('Soma'),
      ],
      pending: false,
      label: '지시와 답변',
    });
    await settle();
    expect(box.parentElement).toBe(conv);
    expect(items().map((x) => x.dataset.item)).toEqual(['u1', 'a1', 'a2', 'panel-needs']);
    const slot = lastItem().querySelector('slot[name="attachments-panel-needs"]');
    expect(slot?.assignedElements()).toEqual([box]);
  });
});
