/**
 * Plan mode (SSOT 2026-11-02) — the task plan as HTML, drawn by the server
 * from the structured plan the model submitted (task-plan.ts). The model
 * writes no markup: every text is escaped here.
 *
 * Four levels, high-level concept first (T3):
 *   0  the conclusion, the intent, the instruction as given, the intents
 *   1  the phase map — every phase in one line, in order
 *   2  each phase: its goal and its steps
 *   3  each step's detail, deliverable and SSOT / intent refs
 * then the assumptions, risks, what is out of scope and what to settle.
 *
 * `renderTaskPlanHtml` is the fragment the dashboard shows inline in the
 * detail card (its CSS is `TASK_PLAN_CSS`, in the dashboard's stylesheet);
 * `renderTaskPlanPage` wraps it in a whole document for the full-page view.
 */
import type { TaskPlanDoc, TaskPlanState } from '../task-turn/task-plan';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** Text with its line breaks kept. */
const para = (s: string): string => esc(s).replace(/\n/g, '<br>');

export const TASK_PLAN_STATE_LABEL: Record<TaskPlanState, string> = {
  drafting: '계획 작성 중',
  awaiting: '승인 대기',
  approved: '시작됨',
  cancelled: '취소됨',
};

function refsHtml(refs: string[] | undefined): string {
  if (!refs?.length) return '';
  return `<span class="tp-refs">${refs.map((r) => `<span class="tp-ref">${esc(r)}</span>`).join('')}</span>`;
}

function notesHtml(cls: string, label: string, list: string[] | undefined): string {
  if (!list?.length) return '';
  return `<section class="tp-note ${cls}"><h5>${esc(label)}</h5><ul>${list.map((x) => `<li>${para(x)}</li>`).join('')}</ul></section>`;
}

/** The plan fragment: four levels, then the notes. `state` adds the plan's state to its kicker. */
export function renderTaskPlanHtml(plan: TaskPlanDoc, opts: { state?: TaskPlanState } = {}): string {
  const kicker = `작업 계획 v${plan.revision}${opts.state ? ` · ${TASK_PLAN_STATE_LABEL[opts.state]}` : ''}`;
  const l0 = [
    `<header class="tp-l0" data-level="0">`,
    `<p class="tp-kicker">${esc(kicker)}</p>`,
    `<p class="tp-summary">${para(plan.summary)}</p>`,
    `<p class="tp-intent"><span class="tp-label">의도</span>${para(plan.intent)}</p>`,
    plan.ssot?.length
      ? `<details class="tp-ssot"><summary>지시 원문 (SSOT)</summary>${plan.ssot.map((s) => `<blockquote>${para(s)}</blockquote>`).join('')}</details>`
      : '',
    plan.intents?.length
      ? `<ul class="tp-intents">${plan.intents
          .map(
            (i) =>
              `<li><span class="tp-ref">${esc(i.id)}</span><span>${para(i.text)}</span>${i.source ? `<span class="tp-src">${esc(i.source)}</span>` : ''}</li>`,
          )
          .join('')}</ul>`
      : '',
    `</header>`,
  ].join('');
  const map = `<nav class="tp-map" data-level="1" aria-label="단계"><ol>${plan.phases
    .map(
      (p, i) =>
        `<li><span class="tp-n">${i + 1}</span><span class="tp-map-title">${esc(p.title)}</span><span class="tp-count">${p.steps.length}</span></li>`,
    )
    .join('')}</ol></nav>`;
  const phases = plan.phases
    .map((p, i) => {
      const steps = p.steps
        .map((s, j) => {
          const detail =
            s.detail || s.deliverable
              ? `<div class="tp-detail" data-level="3">${s.detail ? `<p>${para(s.detail)}</p>` : ''}${s.deliverable ? `<p class="tp-deliv"><span class="tp-label">산출물</span>${para(s.deliverable)}</p>` : ''}</div>`
              : '';
          return `<li class="tp-step"><div class="tp-step-head"><span class="tp-sn">${i + 1}.${j + 1}</span><span class="tp-step-title">${esc(s.title)}</span>${refsHtml(s.refs)}</div>${detail}</li>`;
        })
        .join('');
      return `<section class="tp-phase" data-level="2"><h4><span class="tp-n">${i + 1}</span>${esc(p.title)}</h4>${p.goal ? `<p class="tp-goal">${para(p.goal)}</p>` : ''}<ol class="tp-steps">${steps}</ol></section>`;
    })
    .join('');
  const notes = [
    notesHtml('tp-questions', '확인할 것', plan.questions),
    notesHtml('tp-assumptions', '가정', plan.assumptions),
    notesHtml('tp-risks', '위험', plan.risks),
    notesHtml('tp-out', '범위 밖', plan.outOfScope),
  ].join('');
  return `<article class="tp" data-revision="${plan.revision}"${opts.state ? ` data-state="${opts.state}"` : ''}>${l0}${map}<div class="tp-phases">${phases}</div>${notes ? `<div class="tp-notes">${notes}</div>` : ''}</article>`;
}

/**
 * The plan's look. Dashboard tokens with fallbacks, so the same rules serve the
 * dashboard (its theme) and the standalone page (its own light / dark).
 */
export const TASK_PLAN_CSS = `
.tp { --tp-text: var(--ib-text, #1d1d1f); --tp-muted: var(--ib-muted, #6e6e73); --tp-line: var(--ib-card-border, #e5e5ea);
  --tp-pill: var(--ib-pill, #f2f2f7); --tp-card: var(--ib-card, #fff); --tp-accent: var(--accent, #0a84ff); --tp-warn: var(--st-wait, #c77700);
  color: var(--tp-text); font-size: 13.5px; line-height: 1.55; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.tp p { margin: 0; }
.tp-l0 { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-radius: 12px;
  background: color-mix(in srgb, var(--tp-accent) 7%, var(--tp-card)); border: 1px solid color-mix(in srgb, var(--tp-accent) 22%, var(--tp-line)); }
.tp-kicker { font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; color: color-mix(in srgb, var(--tp-accent) 70%, var(--tp-text)); }
.tp-summary { font-size: 16.5px; font-weight: 650; line-height: 1.4; letter-spacing: -0.01em; text-wrap: balance; }
.tp-intent { color: var(--tp-text); }
.tp-label { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: 5px; background: var(--tp-pill); color: var(--tp-muted); font-size: 11.5px; font-weight: 600; }
.tp-ssot summary { cursor: pointer; color: var(--tp-muted); font-size: 12.5px; }
.tp-ssot blockquote { margin: 6px 0 0; padding: 6px 10px; border-left: 3px solid var(--tp-line); color: var(--tp-muted); white-space: normal; overflow-wrap: anywhere; }
.tp-intents { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.tp-intents li { display: flex; gap: 8px; align-items: baseline; }
.tp-src { margin-left: auto; color: var(--tp-muted); font-size: 11.5px; white-space: nowrap; }
.tp-ref { display: inline-block; padding: 0 6px; border-radius: 999px; background: var(--tp-pill); color: var(--tp-muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tp-map ol { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 4px; align-items: center; }
.tp-map li { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px 4px 4px; border-radius: 999px; border: 1px solid var(--tp-line); background: var(--tp-card); max-width: 100%; }
.tp-map li + li::before { content: '→'; margin: 0 4px 0 -2px; color: var(--tp-muted); order: -1; }
.tp-map-title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-count { color: var(--tp-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.tp-n { flex: none; display: inline-grid; place-items: center; inline-size: 20px; block-size: 20px; border-radius: 50%;
  background: var(--tp-text); color: var(--tp-card); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.tp-phases { display: flex; flex-direction: column; gap: 12px; }
.tp-phase { position: relative; padding-left: 30px; }
.tp-phase::before { content: ''; position: absolute; left: 9.5px; top: 24px; bottom: -6px; width: 1px; background: var(--tp-line); }
.tp-phase:last-child::before { display: none; }
.tp-phase h4 { margin: 0 0 4px -30px; display: flex; align-items: center; gap: 10px; font-size: 14.5px; font-weight: 650; }
.tp-goal { color: var(--tp-muted); margin-bottom: 6px !important; }
.tp-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tp-step { padding: 8px 10px; border-radius: 9px; background: var(--tp-pill); }
.tp-step-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.tp-sn { color: var(--tp-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.tp-step-title { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.tp-refs { display: inline-flex; gap: 4px; margin-left: auto; }
.tp-step .tp-ref { background: var(--tp-card); }
.tp-detail { margin-top: 4px; padding-left: 10px; border-left: 2px solid var(--tp-line); color: var(--tp-muted); display: flex; flex-direction: column; gap: 3px; overflow-wrap: anywhere; }
.tp-notes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; }
.tp-note { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--tp-line); }
.tp-note h5 { margin: 0 0 4px; font-size: 12px; font-weight: 650; color: var(--tp-muted); }
.tp-note ul { margin: 0; padding-left: 18px; }
.tp-questions { border-color: color-mix(in srgb, var(--tp-accent) 40%, var(--tp-line)); }
.tp-questions h5 { color: color-mix(in srgb, var(--tp-accent) 75%, var(--tp-text)); }
.tp-risks { border-color: color-mix(in srgb, var(--tp-warn) 45%, var(--tp-line)); }
.tp-risks h5 { color: color-mix(in srgb, var(--tp-warn) 75%, var(--tp-text)); }
`;

/** The full-page view's content policy: no script, no network, inline style only. */
export const TASK_PLAN_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** The plan as a whole document (the full-page view): the task's title, the plan's state, the fragment. */
export function renderTaskPlanPage(plan: TaskPlanDoc, meta: { title: string; state: TaskPlanState }): string {
  return [
    '<!doctype html>',
    '<html lang="ko"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(`작업 계획 v${plan.revision} — ${meta.title}`)}</title>`,
    `<style>
:root { color-scheme: light dark; }
body { margin: 0; background: #f5f5f7; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 860px; margin: 0 auto; padding: 32px 20px 56px; display: flex; flex-direction: column; gap: 12px; }
.tp-page-task { margin: 0; font-size: 13px; color: #6e6e73; }
@media (prefers-color-scheme: dark) {
  body { background: #000; }
  .tp { --tp-text: #f5f5f7; --tp-muted: #a1a1a6; --tp-line: #38383a; --tp-pill: #1c1c1e; --tp-card: #111113; }
}
${TASK_PLAN_CSS}</style>`,
    '</head><body><main>',
    `<p class="tp-page-task">${esc(meta.title)}</p>`,
    renderTaskPlanHtml(plan, { state: meta.state }),
    '</main></body></html>',
  ].join('\n');
}
