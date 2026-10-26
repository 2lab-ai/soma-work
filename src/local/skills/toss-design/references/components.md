# toss-design — component recipes (plain HTML + CSS)

Every recipe reads only the semantic and raw tokens defined in `themes/<name>/tokens.css`. Swap the tokens file and every component re-themes. Values trace to `references/tds-source-notes.md` (the evidence file; a copy of the bundle's top-level `tds-source-notes.md`). Section numbers like "notes §3.7" point there. `[inferred]` marks a skill decision that no TDS source states.

How to use this file:

1. Inline `themes/<name>/tokens.css` in a `<style>` block.
2. Inline the **Recipe kit CSS** below (copy it whole; it is about 330 lines and has no dependencies).
3. Write markup with the class names in the per-component sections.
4. Keep one mobile column (`.screen`, max 480px) unless the desktop rule in SKILL.md says otherwise.

Recipes are TDS look-alikes written from public docs. They are not the `@toss/tds-mobile` React components and do not reuse their code.

## Contents

- Recipe kit CSS (copy whole)
- Screen and TopNavigation
- Top (page title area)
- ListHeader
- ListRow (+ assets, ListRow.Texts presets)
- Button (sizes × colours × variants)
- BottomCTA (Single, Double)
- Badge
- Tab
- TextField
- Switch and Checkbox
- Toast
- Dialog (Alert / Confirm)
- BottomSheet
- Border / section gap
- Skeleton
- Icons
- Theme differences per component

---

## Recipe kit CSS (copy whole)

```css
/* toss-design recipe kit — plain CSS on top of themes/<name>/tokens.css.
   Values come from tds-source-notes.md; [inferred] marks skill decisions. */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text-strong);
  font-family: var(--font-sans);
  font-size: var(--t5-size);
  line-height: var(--t5-lh);
  -webkit-font-smoothing: antialiased;
  word-break: keep-all;          /* TDS Paragraph */
  overflow-wrap: anywhere;
}
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; } /* [inferred] */
button { font: inherit; color: inherit; }

/* Typography helpers: size + line-height always travel together */
.t1 { font-size: var(--t1-size); line-height: var(--t1-lh); }
.t2 { font-size: var(--t2-size); line-height: var(--t2-lh); }
.t3 { font-size: var(--t3-size); line-height: var(--t3-lh); }
.t4 { font-size: var(--t4-size); line-height: var(--t4-lh); }
.t5 { font-size: var(--t5-size); line-height: var(--t5-lh); }
.t6 { font-size: var(--t6-size); line-height: var(--t6-lh); }
.t7 { font-size: var(--t7-size); line-height: var(--t7-lh); }
.st2 { font-size: var(--st2-size); line-height: var(--st2-lh); }
.st11 { font-size: var(--st11-size); line-height: var(--st11-lh); }
.fw-regular { font-weight: var(--fw-regular); }
.fw-medium { font-weight: var(--fw-medium); }
.fw-semibold { font-weight: var(--fw-semibold); }
.fw-bold { font-weight: var(--fw-bold); }
.num { font-variant-numeric: tabular-nums; }

/* Screen: one mobile column */
.screen {
  position: relative;
  max-width: var(--mobile-max);
  min-height: 100dvh;
  margin: 0 auto;
  background: var(--color-bg);
  padding-bottom: calc(36px + var(--button-h-xl) + var(--gutter-cta)); /* room for BottomCTA */
}

/* TopNavigation (bar) — height observed, title style [inferred] */
.nav {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center;
  height: var(--nav-h-ios);
  padding: 0 8px;
  background: var(--color-bg);
}
.nav__btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: var(--touch-min); height: var(--touch-min);
  border: 0; background: none; border-radius: 12px; cursor: pointer;
  color: var(--color-text-strong);
}
.nav__title {
  flex: 1; text-align: center; margin: 0;
  font-size: var(--t5-size); line-height: var(--t5-lh); font-weight: var(--fw-semibold);
  color: var(--color-text-strong);
}
.nav__spacer { width: var(--touch-min); }

/* Top — page title area */
.top { padding: 24px var(--gutter) 24px; }           /* upperGap / lowerGap 24 */
.top__title {
  margin: 0; color: var(--color-text); font-weight: var(--fw-bold);
  font-size: var(--t3-size); line-height: var(--t3-lh);           /* size 22 = t3 */
}
.top__title--28 { font-size: var(--st2-size); line-height: var(--st2-lh); } /* size 28 = st2 */
.top__subtitle {
  margin: 0; padding-top: 4px; color: var(--color-text-secondary);
  font-size: var(--t5-size); line-height: var(--t5-lh); font-weight: var(--fw-medium);
}
.top__subtitle--15 { font-size: var(--t6-size); line-height: var(--t6-lh); font-weight: var(--fw-regular); }
.top__lower { margin-top: 16px; display: flex; gap: 8px; }

/* ListHeader */
.list-header { padding: 24px 0 8px; }
.list-header__desc {
  margin: 0; padding: 0 var(--gutter); color: var(--color-text-sub);
  font-size: var(--t7-size); line-height: var(--t7-lh);
}
.list-header__row { display: flex; align-items: center; justify-content: space-between; }
.list-header__title {
  margin: 0; padding-left: var(--gutter); width: 66%;
  color: var(--color-text); font-weight: var(--fw-bold);
  font-size: var(--t5-size); line-height: var(--t5-lh);
}
.list-header__right {
  margin-right: var(--gutter); color: var(--color-text-secondary);
  font-size: var(--t7-size); line-height: var(--t7-lh);
  display: inline-flex; align-items: center; gap: 2px;
  background: none; border: 0; padding: 0; cursor: pointer;
}

/* ListRow */
.list { margin: 0; padding: 0; list-style: none; }
.list-row {
  position: relative; display: flex; align-items: center;
  min-height: var(--row-min-h); list-style: none; isolation: isolate;
}
.list-row--indented::before {               /* 0.5px hairline, indented 24px */
  content: ""; position: absolute; top: 0; left: var(--gutter); right: 0; height: 1px;
  background: linear-gradient(to bottom, var(--color-hairline) 50%, transparent 50%);
}
.list-row__inner {
  display: flex; flex: 1; align-items: center; min-width: 0;
  padding: 12px var(--gutter);              /* verticalPadding medium / horizontalPadding medium */
}
.list-row--pad-s .list-row__inner { padding-top: 8px; padding-bottom: 8px; }
.list-row--pad-l .list-row__inner { padding-top: 16px; padding-bottom: 16px; }
.list-row--pad-xl .list-row__inner { padding-top: 24px; padding-bottom: 24px; }
.list-row__left { flex: none; margin-right: 12px; display: flex; }   /* leftGap 12 */
.list-row__contents { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.list-row__right { flex: none; margin-left: 16px; display: flex; flex-direction: column; align-items: flex-end; } /* gap 16 */
.list-row__top { color: var(--color-text); font-size: var(--t5-size); line-height: var(--lh-s); font-weight: var(--fw-bold); }
.list-row__bottom { color: var(--color-text-sub); font-size: var(--t6-size); line-height: var(--lh-s); }
.list-row__value { color: var(--color-text); font-size: var(--t5-size); line-height: var(--lh-s); font-weight: var(--fw-bold); }
.list-row__meta { color: var(--color-text-sub); font-size: var(--t7-size); line-height: var(--lh-s); }
.list-row__arrow { flex: none; width: 24px; height: 24px; margin-left: 4px; margin-right: -8px; color: var(--color-icon); }
.list-row--touch { cursor: pointer; }
.list-row--touch::after {                   /* touch layer: greyOpacity100, radius 12 */
  content: ""; position: absolute; inset: 0; z-index: -1; border-radius: var(--radius-row-touch);
  background: var(--tds-grey-opacity-100); opacity: 0; transition: opacity var(--dur-color) ease-in-out;
}
.list-row--touch:active::after { opacity: 1; }
@media (hover: hover) { .list-row--touch:hover::after { opacity: .6; } } /* [inferred] desktop hover */

/* Assets (left of ListRow) — circle 40 observed; squircle radius [inferred] */
.asset {
  width: 40px; height: 40px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--tds-grey-opacity-100); color: var(--color-icon-strong);
}
.asset--circle { border-radius: 50%; }
.asset--squircle { border-radius: 32%; }
.asset svg { width: 24px; height: 24px; }

/* Badge */
.badge {
  display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;
  font-weight: var(--fw-bold); line-height: 1.5em; white-space: nowrap;
  font-size: 13px; padding: 3px 7px; border-radius: 12px;           /* medium */
}
.badge--xs { font-size: 10px; padding: 3px 7px; border-radius: 9px; font-weight: var(--fw-semibold); }
.badge--s  { font-size: 12px; padding: 3px 7px; border-radius: 11px; }
.badge--l  { font-size: 14px; padding: 4px 8px; border-radius: 13px; }
.badge--brand { background: var(--color-badge-brand-bg); color: var(--color-badge-brand-text); }
.badge--blue-fill { background: var(--tds-blue-500); color: var(--tds-white); }
.badge--blue-weak { background: rgba(49,130,246,0.16); color: var(--tds-blue-700); }
.badge--teal-weak { background: rgba(0,129,138,0.16); color: var(--tds-teal-700); }
.badge--green-weak { background: rgba(2,162,98,0.16); color: var(--tds-green-700); }
.badge--red-weak { background: rgba(244,67,54,0.16); color: var(--tds-red-700); }
.badge--yellow-fill { background: var(--tds-yellow-500); color: var(--tds-grey-800); }
.badge--elephant-weak { background: rgba(78,89,104,0.16); color: var(--tds-grey-700); }
.badge--elephant-fill { background: var(--tds-grey-700); color: var(--tds-white); }

/* Button */
.btn {
  --btn-bg: var(--color-primary); --btn-fg: var(--color-on-primary); --btn-dim: #000;
  position: relative; display: inline-flex; align-items: center; justify-content: center;
  min-width: 96px; min-height: var(--button-h-xl); padding: 0 28px;          /* xlarge (default) */
  border: 0; border-radius: var(--radius-button-xl);
  background: var(--btn-bg); color: var(--btn-fg);
  font-size: var(--t5-size); line-height: var(--lh-xs); font-weight: var(--fw-semibold);
  white-space: nowrap; cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent;
  transition: background-color var(--dur-color) ease-in-out, color var(--dur-color) ease-in-out,
              opacity var(--dur-color) ease-in-out, transform var(--dur-spring-quick) var(--ease-out);
}
.btn::after {                                  /* press dim: opacity .26 */
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: var(--btn-dim); opacity: 0; transition: opacity var(--dur-color) ease-in-out; pointer-events: none;
}
.btn:active { transform: scale(var(--press-scale)); transition-duration: var(--dur-spring-rapid); }
.btn:active::after { opacity: .26; }
.btn--l { min-width: 80px; min-height: var(--button-h-l); padding: 0 16px; border-radius: var(--radius-button-l); }
.btn--m { min-width: 64px; min-height: var(--button-h-m); padding: 0 16px; border-radius: var(--radius-button-m);
          font-size: var(--t6-size); }
.btn--s { min-width: 52px; min-height: var(--button-h-s); padding: 0 10px; border-radius: var(--radius-button-s);
          font-size: var(--t7-size); }
.btn--m::before, .btn--s::before {            /* extend hit area to 44px [inferred] */
  content: ""; position: absolute; left: 0; right: 0; top: 50%; height: var(--touch-min); transform: translateY(-50%);
}
.btn--block { display: flex; width: 100%; }
.btn--full { display: flex; width: 100%; border-radius: 0; }
.btn--full:active { transform: none; }
.btn--weak { --btn-bg: var(--color-primary-weak); --btn-fg: var(--color-on-primary-weak); --btn-dim: var(--color-primary); }
.btn--dark { --btn-bg: var(--color-neutral); --btn-fg: var(--color-on-neutral); }
.btn--dark.btn--weak { --btn-bg: var(--color-neutral-weak); --btn-fg: var(--color-on-neutral-weak); --btn-dim: var(--color-neutral); }
.btn--danger { --btn-bg: var(--color-danger); --btn-fg: var(--color-on-danger); }
.btn--danger.btn--weak { --btn-bg: var(--color-danger-weak); --btn-fg: var(--color-on-danger-weak); --btn-dim: var(--color-danger); }
.btn--light { --btn-bg: var(--tds-white); --btn-fg: var(--tds-blue-700); }
.btn--light.btn--weak { --btn-bg: rgba(222,222,255,0.19); --btn-fg: var(--tds-white); --btn-dim: var(--tds-white); }
.btn:disabled { cursor: default; pointer-events: none; opacity: .3; }
.btn--weak:disabled { opacity: 1; color: color-mix(in srgb, var(--btn-fg) 30%, transparent); }

/* BottomCTA (fixed) */
.bottom-cta {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
  max-width: var(--mobile-max); margin: 0 auto; pointer-events: none;
}
.bottom-cta__fade { height: 36px; background: linear-gradient(to top, var(--color-bg) 25%, rgba(255,255,255,0)); }
.bottom-cta__content {
  pointer-events: auto; background: var(--color-bg);
  padding: 0 var(--gutter-cta) max(env(safe-area-inset-bottom), var(--gutter-cta));
}
.bottom-cta__row { display: flex; gap: 8px; }
.bottom-cta__row > * { flex: 1 1 0; min-width: 0; }

/* Tab */
.tab { position: relative; display: flex; padding: 0 20px; background: var(--color-bg); }
.tab::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
  background: linear-gradient(to top, var(--color-hairline) 50%, transparent 50%);
}
.tab__item {
  position: relative; flex: 1; min-width: 64px; padding: 0 8px;
  border: 0; background: none; cursor: pointer;
  font-size: var(--t5-size); line-height: var(--lh-xs); font-weight: var(--fw-semibold);
  color: var(--color-tab-text); transition: color var(--dur-tab) ease;
}
.tab__item > span { display: block; padding: 12px 0 14px; }
.tab__item[aria-selected="true"] { color: var(--color-tab-text-selected); font-weight: var(--fw-bold); }
.tab__item[aria-selected="true"]::after {
  content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; z-index: 1;
  border-radius: 1px; background: var(--color-tab-indicator);
}
.tab--small .tab__item { font-size: var(--t6-size); }
.tab--small .tab__item > span { padding: 8px 0; }

/* TextField (box) */
.field { display: block; padding: 8px 0; }
.field__label { display: block; padding: 0 var(--gutter) 6px; color: var(--color-text);
  font-size: var(--t7-size); line-height: var(--t7-lh); }
.field__wrap { display: block; padding: 0 var(--gutter-cta); }
.field__box {
  position: relative; display: flex; align-items: center; overflow: hidden;
  padding: 14px 16px; border: 1px solid var(--tds-grey-opacity-100); border-radius: var(--radius-field);
  background: var(--tds-grey-opacity-50);
}
.field__box::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: var(--color-field-focus-overlay); opacity: 0;
  transition: opacity var(--dur-field) ease;
}
.field__input {
  flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; padding: 0;
  font: inherit; font-size: var(--t5-size); line-height: var(--t5-lh); color: var(--color-text);
}
.field__input::placeholder { color: var(--color-text-placeholder); }
.field:focus-within .field__label { color: var(--color-field-focus-label); }
.field:focus-within .field__box::before { opacity: 1; }
.field:focus-within .field__box { outline: 2px solid var(--color-focus); outline-offset: -1px; } /* [inferred] */
.field__help { display: block; padding: 6px var(--gutter) 0; color: var(--color-text-sub);
  font-size: var(--t7-size); line-height: var(--t7-lh); }
.field--error .field__label, .field--error .field__help { color: var(--color-danger-text); }
.field--error .field__box::before { background: rgba(165,25,38,0.05); opacity: 1; } /* red900 @ .05 */

/* Switch */
.switch { position: relative; display: inline-flex; flex: none; width: var(--switch-w); height: var(--switch-h);
  border-radius: var(--radius-switch); background: var(--color-switch-off); cursor: pointer; }
.switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
.switch__knob { position: absolute; left: 7px; top: 50%; width: 16px; height: 16px; border-radius: 50%;
  background: var(--tds-white); transform: translate(0, -50%);
  transition: all var(--dur-spring-medium) var(--ease-out); pointer-events: none; }
.switch:has(input:checked) { background: var(--color-selected); }
.switch:has(input:checked) .switch__knob { width: 24px; height: 24px; transform: translate(16px, -50%); }
.switch:has(input:disabled) { opacity: .3; cursor: default; }
.switch:has(input:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; }

/* Toast */
.toast {
  position: fixed; left: 50%; bottom: calc(36px + var(--button-h-xl) + 28px); z-index: 30000; /* above CTA [inferred] */
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  width: max-content; max-width: min(375px, calc(100vw - 36px));
  padding: 12px 16px; border-radius: var(--radius-toast);
  background: var(--color-toast-bg); color: var(--color-toast-text); box-shadow: var(--shadow-weak);
  font-size: var(--t6-size); line-height: var(--t6-lh); font-weight: var(--fw-semibold);
}
.toast--multi { border-radius: var(--radius-toast-multi); }
.toast--icon { padding-left: 12px; }
.toast svg { width: 24px; height: 24px; flex: none; }

/* Dialog */
.dim { position: fixed; inset: 0; z-index: 10000; background: var(--color-dim); }
.dialog {
  position: fixed; top: 50%; left: 50%; z-index: 10001; transform: translate(-50%, -50%);
  width: calc(100vw - 64px); max-width: 320px; max-height: calc(100vh - 160px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--color-surface-float); border-radius: var(--radius-dialog);
}
.dialog__body { display: flex; flex-direction: column; gap: 8px; padding: 22px 22px 0; overflow: auto; }
.dialog__title { margin: 0; color: var(--color-text); font-size: var(--t4-size); line-height: var(--lh-s); font-weight: var(--fw-bold); }
.dialog__desc { margin: 0; color: var(--color-text-sub); font-size: var(--t6-size); line-height: var(--lh-m); font-weight: var(--fw-medium); }
.dialog__footer { display: flex; flex-wrap: wrap-reverse; gap: 8px; margin: 20px 16px 16px; }
.dialog__footer > * { flex-grow: 1; min-width: calc(50% - 8px); }

/* BottomSheet (floating) */
.sheet {
  position: fixed; left: 10px; right: 10px; bottom: 10px; z-index: 10001;
  max-width: calc(var(--mobile-max) - 20px); margin: 0 auto;
  background: var(--color-surface); border-radius: var(--radius-sheet); overflow: hidden;
}
.sheet__handle { position: relative; height: 16px; }
.sheet__handle::after { content: ""; position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
  width: 48px; height: 4px; border-radius: 2px; background: var(--tds-grey-200); } /* bar colour [inferred] */
.sheet__header { padding: 21px var(--gutter) 13px; margin: 0; color: var(--color-text);
  font-size: var(--t4-size); line-height: var(--lh-s); font-weight: var(--fw-bold); } /* type [inferred] */
.sheet__cta { padding: 0 var(--gutter-cta) var(--gutter-cta); }

/* Border */
.divider { height: 1px; border: 0; margin: 0; background: linear-gradient(to bottom, var(--color-hairline) 50%, transparent 50%); }
.divider--inset { margin-left: var(--gutter); }
.section-gap { height: var(--section-gap); background: var(--color-bg-grey); border: 0; margin: 0; }

/* Skeleton */
.skeleton { padding: 0 var(--gutter);
  -webkit-mask-image: linear-gradient(110deg, #000, transparent); mask-image: linear-gradient(110deg, #000, transparent); }
.skeleton__title, .skeleton__subtitle, .skeleton__list { background: var(--color-skeleton);
  animation: tds-skeleton .6s var(--ease-tds) infinite alternate; }
.skeleton__title { width: 50%; height: 30px; border-radius: 11px; margin-bottom: 12px; }
.skeleton__subtitle { width: 33%; height: 22px; border-radius: 9px; margin-bottom: 12px; }
.skeleton__list { width: 100%; height: 64px; border-radius: 18px; margin-bottom: 16px; }
.skeleton > :nth-child(2) { animation-delay: .1s; } .skeleton > :nth-child(3) { animation-delay: .2s; }
.skeleton > :nth-child(4) { animation-delay: .3s; } .skeleton > :nth-child(5) { animation-delay: .4s; }
@keyframes tds-skeleton { from { opacity: .2; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
}
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

---

## Screen and TopNavigation

- The screen is one column, `max-width: var(--mobile-max)` (480px) [inferred], white canvas (`--color-bg`).
- TopNavigation height: 44px on iOS, 54px on Android (notes §3.5). In Apps in Toss the host app draws the real nav bar, so in a mini-app you usually start with `Top`. In a standalone mock or HTML report, draw `.nav` at 44px.
- Back button: a 24px chevron in a 44×44 hit area, colour `--color-text-strong` (TDS back icon is grey900). Nav title styling (t5, semibold, centred) is [inferred]: TDS did not publish it.

```html
<div class="screen">
  <nav class="nav" aria-label="상단 내비게이션">
    <button class="nav__btn" type="button" aria-label="뒤로 가기">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <p class="nav__title">화면 이름</p>
    <span class="nav__spacer" aria-hidden="true"></span>
  </nav>
  <!-- Top, lists, … -->
</div>
```

## Top (page title area)

TDS `Top` is the big left-aligned page title, not a nav bar (notes §3.4).

| Part | Spec | Source |
|---|---|---|
| Padding | upperGap 24px, lowerGap 24px, left 24px | observed |
| Title | t3 22/31, bold, grey800 (`--color-text`); large variant st2 28/37 | observed |
| Subtitle | t5 17/25.5 medium grey700 (`--color-text-secondary`), 4px above; small variant t6 regular | observed |
| Lower button | `Top.LowerButton` small; `Top.LowerCTAButton` large | observed |
| Right asset/button | gap 8px; button margin `0 24px 0 8px`; RightButton medium | observed |

```html
<header class="top">
  <h1 class="top__title">이번 달 고정 지출을<br>정리했어요</h1>
  <p class="top__subtitle">결제일이 가까운 순서로 보여드려요</p>
  <div class="top__lower"><button class="btn btn--l btn--weak" type="button">항목 추가하기</button></div>
</header>
```

Write the title as one plain sentence that ends in 해요체. Break the line by meaning (`<br>`), not by width.

## ListHeader

| Part | Spec | Source |
|---|---|---|
| Container | `padding: 24px 0 8px` | observed |
| Title | `padding-left: 24px`, width 66%, typography t4 / t5 / t7, weight bold / medium / regular, grey800 | observed |
| Description | t7 grey600, `padding: 0 24px`, above the title by default (`descriptionPosition="top"`) | observed |
| Right | `RightText` / `RightArrow`: t7 or t6, grey700 text, grey400 arrow, `margin-right: 24px` | observed |

```html
<div class="list-header">
  <p class="list-header__desc">보조 설명</p>
  <div class="list-header__row">
    <h2 class="list-header__title">자동이체 4건</h2>
    <button class="list-header__right" type="button">전체 보기
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </div>
</div>
```

## ListRow

| Part | Spec | Source |
|---|---|---|
| Row | flex, `min-height: 44px` | observed (pkg) |
| Padding | vertical small 8 / **medium 12** / large 16 / xlarge 24; horizontal small 20 / **medium 24** | observed (docs) |
| Divider | `border="indented"`: 0.5px hairline `rgba(0,0,33,0.07)` from x=24px to the right edge, drawn on top of the row; `none` = no line | observed |
| Left → contents gap | 12px | observed (pkg) |
| Contents → right gap | 16px | observed (pkg); mapping of the two gaps [inferred] |
| Arrow | `icon-arrow-right-mono` 24px grey400, `margin-left: 4px; margin-right: -8px` | observed (pkg) |
| Touch | layer `greyOpacity100`, radius 12px, fades in on press | observed (pkg) |
| Text line-height | 1.35 × size | observed (pkg) |

```html
<ul class="list">
  <li class="list-row list-row--touch" tabindex="0" role="button">
    <div class="list-row__inner">
      <span class="list-row__left asset asset--squircle"><!-- 24px line icon svg --></span>
      <div class="list-row__contents">
        <span class="list-row__top">통신비</span>
        <span class="list-row__bottom">매달 3일 · 자동이체</span>
      </div>
      <div class="list-row__right">
        <span class="list-row__value num">59,000원</span>
        <span class="badge badge--xs badge--brand">곧 결제</span>
      </div>
      <svg class="list-row__arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  </li>
  <li class="list-row list-row--indented"> … </li>
</ul>
```

Put `list-row--indented` on every row except the first in a group. Rows that do nothing on tap get no `--touch`, no `role="button"`, no arrow.

### ListRow.Texts presets (copy the style set, not the name)

`top / bottom` = typography, colour, weight (notes §3.7). The default recipe above is **2RowTypeA**.

| Preset | Top line | Bottom line | Use |
|---|---|---|---|
| 1RowTypeA | t5 grey700 medium | — | plain setting row |
| 1RowTypeC | t5 grey800 bold | — | emphasised single line |
| 2RowTypeA | t5 grey800 bold | t6 grey600 regular | title + description (default) |
| 2RowTypeB | t4 grey800 semibold | t6 grey600 regular | larger title |
| 2RowTypeD | t6 grey600 regular | t5 grey800 bold | label above value |
| 2RowTypeF | t7 grey600 medium | t5 grey800 bold | small label above value |
| Right1RowTypeE | t5 grey800 bold | — | right-aligned amount |
| Right2RowTypeB | t5 grey800 bold | t7 grey600 regular | amount + small note |
| 3RowTypeA | t5 grey800 bold, then t7 grey600 medium ×2 | | three-line item |

### Assets

- `ListRow.AssetImage` circle 40×40, square 52×52; image original height 56; 3D emoji 40; 2D emoji 24 (observed).
- Icon tile: 40px, background `greyOpacity100`, 24px icon in `--color-icon-strong`. The squircle is approximated with `border-radius: 32%` [inferred].
- `ListRow.AssetText` (order numbers): text `blue500` on `greyOpacity100` in TDS. In toss-black use `--color-primary` [inferred].

## Button

Sizes (notes §3.1, observed):

| Class | Size | Height | Min width | Padding | Radius | Font |
|---|---|---|---|---|---|---|
| `.btn` | xlarge (TDS default) | 56px | 96px | 0 28px | 16px | t5 17px / 600 |
| `.btn--l` | large | 48px | 80px | 0 16px | 14px | t5 17px / 600 |
| `.btn--m` | medium | 38px | 64px | 0 16px | 10px | t6 15px / 600 |
| `.btn--s` | small | 32px | 52px | 0 10px | 8px | t7 13px / 600 |

Line-height 1.252. Medium and small sit below 44px, so the kit adds an invisible 44px hit area (`::before`) [inferred].

Colours (`color` × `variant`):

| Classes | Background | Label | Press dim |
|---|---|---|---|
| `.btn` (primary fill) | `--color-primary` | `--color-on-primary` | black, opacity 0.26 |
| `.btn.btn--weak` | `--color-primary-weak` | `--color-on-primary-weak` | primary, 0.26 |
| `.btn.btn--dark` | `--color-neutral` (grey700) | white | black, 0.26 |
| `.btn.btn--dark.btn--weak` | `--color-neutral-weak` (greyOpacity100) | grey700 | grey700, 0.26 |
| `.btn.btn--danger` | `--color-danger` (red500) | white | black, 0.26 |
| `.btn.btn--danger.btn--weak` | `--color-danger-weak` | `--color-on-danger-weak` | red500, 0.26 |
| `.btn.btn--light` | white (on coloured backgrounds only) | blue700 | black, 0.26 |
| `.btn.btn--light.btn--weak` | `rgba(222,222,255,0.19)` | white | white, 0.26 |

Display: default inline; `.btn--block` = full width with radius kept; `.btn--full` = full width, radius 0, no press scale.
States: press scales to 0.96 (`--press-scale`); disabled fill opacity 0.3; disabled weak keeps the background and fades the label to 30%. Loading: keep the width and replace the label with three 8px dots (5px on medium/small) that pulse 0.2→1 opacity, 0.3s, staggered 0.1s; set `aria-busy="true"`.

```html
<button class="btn btn--block" type="button">자동이체 한 번에 관리하기</button>
<button class="btn btn--l btn--weak" type="button">항목 추가하기</button>
<button class="btn btn--m btn--dark btn--weak" type="button">닫기</button>
```

One primary fill per screen. Pair it with a `dark weak` button for the secondary choice, as TDS's Double CTA does.

## BottomCTA (Single, Double)

| Part | Spec | Source |
|---|---|---|
| Position | fixed to the bottom of the mobile column | observed (`fixed`) |
| Fade strip | 36px, `linear-gradient(to top, bg 25%, transparent)` | observed |
| Content | `padding: 0 20px 20px`, bottom = `max(safe-area, 20px)`, background `--color-bg` | observed |
| Button | xlarge, block (56px, radius 16) | observed |
| Double | gap 8px, two equal columns; left = dark weak, right = primary fill | observed |

```html
<div class="bottom-cta">
  <div class="bottom-cta__fade"></div>
  <div class="bottom-cta__content">
    <div class="bottom-cta__row">
      <button class="btn btn--dark btn--weak" type="button">닫기</button>
      <button class="btn" type="button">다음</button>
    </div>
  </div>
</div>
```

`.screen` reserves `36 + 56 + 20px` at the bottom so content never hides under the CTA.

## Badge

| Class | TDS size | Font | Padding | Radius | Weight |
|---|---|---|---|---|---|
| `.badge--xs` | xsmall | 10px | 3px 7px | 9px | 600 |
| `.badge--s` | small | 12px | 3px 7px | 11px | 700 |
| `.badge` | medium | 13px | 3px 7px | 12px | 700 |
| `.badge--l` | large | 14px | 4px 8px | 13px | 700 |

Line-height 1.5em. Colours: blue / teal / green / red / yellow / elephant × fill / weak (notes §3.8, §1.3). `.badge--brand` is the theme-aware one: Toss Blue weak in toss-blue, elephant weak in toss-black. Status hues (red, green, yellow) stay the same in both themes. A badge is a supplementary label: never let it be the only carrier of critical information.

## Tab

| Part | Spec | Source |
|---|---|---|
| Container | white, 1px hairline at the bottom, side padding 20px (large) | observed |
| Item | `min-width: 64px`, padding `0 8px`, label padding `12px 0 14px` (large) / `8px 0` (small) | observed |
| Label | t5 (large) / t6 (small); selected grey800 bold 700, unselected grey600 semibold 600; colour transition 0.3s | observed |
| Indicator | 2px tall, radius 1px, inset 10px, `--color-tab-indicator` | observed (grey800) |
| Red dot | 6px `#f44336` at the top right | observed |

```html
<div class="tab" role="tablist" aria-label="기간">
  <button class="tab__item" role="tab" aria-selected="true"><span>이번 달</span></button>
  <button class="tab__item" role="tab" aria-selected="false"><span>지난달</span></button>
  <button class="tab__item" role="tab" aria-selected="false"><span>올해</span></button>
</div>
```

Up to 4 items share the width equally; more than 4 → scrolling (`fluid`) tabs with item padding `0 12px`.

## TextField

Box variant (notes §3.13): label t7 above (`padding: 0 24px 6px`), field box `padding: 14px 16px`, radius 14px, 1px `greyOpacity100` border, `greyOpacity50` fill, text t5 grey800, placeholder grey500, help t7 grey600 below (`padding: 6px 24px 0`). Focus: label turns `--color-field-focus-label`, a 5% tint overlays the box, plus the skill's 2px focus ring [inferred]. Error: label and help in `--color-danger-text`, red 5% overlay. Disabled: box grey200, text grey400.
Line / big / hero variants: no box, 2px bottom border grey100 → `--color-field-focus-line` on focus → red600 on error; t3 (line) or t1 (big, hero); weight 600.

```html
<label class="field">
  <span class="field__label">받는 분 이름</span>
  <span class="field__wrap"><span class="field__box">
    <input class="field__input" placeholder="예: 김토스" autocomplete="name">
  </span></span>
  <span class="field__help">통장에 표시될 이름이에요</span>
</label>
```

Always show a label. The placeholder is a hint, never the only label.

## Switch and Checkbox

Switch (notes §3.14): track 50×30, radius 15; off `grey200`; on `--color-selected`; knob white, 16px off → 24px on, slides 16px; disabled opacity 0.3.

```html
<label class="switch"><input type="checkbox" role="switch" aria-label="결제 전날 알림"><span class="switch__knob"></span></label>
```

Checkbox (notes §3.15): circle or line style; checked fill `--color-selected`, unchecked `grey200`; press scale 0.9. Always give an `aria-label` that does not repeat the word "체크박스".

## Toast

Spec (notes §3.9): pill (radius 100px; 20px when multi-line), white background, `greyOpacity800` text, t6 semibold, padding `12px 16px` (`12px 16px 12px 12px` with a 24px left icon + 8px gap), `max-width: min(375px, 100vw - 36px)`, shadow `0 2px 30px greyOpacity200`. Duration 3s (5s with a button). Bottom placement above the CTA (offset) is [inferred].

```html
<div class="toast toast--icon" role="status" aria-live="polite">
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" style="fill:var(--color-success)"/><path d="M8 12.5l2.5 2.5L16 9.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  자동이체를 등록했어요
</div>
```

## Dialog (Alert / Confirm)

Spec (notes §3.10): scrim black at 20%; box `width: calc(100vw - 64px)`, max 320px, radius 24px, white; body `padding: 22px 22px 0`, gap 8px; title t4 bold grey800 (line-height 1.35); description t6 medium grey600 (line-height 1.5). Confirm footer: `margin: 20px 16px 16px`, gap 8px, two large buttons — left `dark weak` labelled **닫기**, right primary fill. Long labels wrap to a vertical stack (`flex-wrap: wrap-reverse`). Alert footer: one right-aligned text-style button, `margin: 14px 16px 16px`.

```html
<div class="dim" aria-hidden="true"></div>
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-d">
  <div class="dialog__body">
    <h2 class="dialog__title" id="dlg-t">자동이체를 해지할까요?</h2>
    <p class="dialog__desc" id="dlg-d">해지하면 다음 달부터 직접 납부해야 해요.</p>
  </div>
  <div class="dialog__footer">
    <button class="btn btn--l btn--dark btn--weak" type="button">닫기</button>
    <button class="btn btn--l btn--danger" type="button">해지하기</button>
  </div>
</div>
```

## BottomSheet

Spec (notes §3.11): floating sheet inset 10px from the sides (`width: calc(100% - 20px)`), radius 28px, white; 16px handle area with a 48×4px bar; header padding `21px 0 13px`; content bottom padding 16px with a 16px fade above the CTA; drag down 50px to close. Header typography (t4 bold) and handle colour (grey200) are [inferred].
Apps in Toss rule: never open a sheet on entry or on back (dark pattern, notes §10).

```html
<div class="dim" aria-hidden="true"></div>
<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
  <div class="sheet__handle" aria-hidden="true"></div>
  <h2 class="sheet__header" id="sh-t">결제일을 골라 주세요</h2>
  <ul class="list"><!-- ListRows --></ul>
  <div class="sheet__cta"><button class="btn btn--block" type="button">선택하기</button></div>
</div>
```

## Border / section gap

- Between items: `<hr class="divider">` (full) or `<hr class="divider divider--inset">` (24px left inset) — 0.5px hairline (observed).
- Between sections: `<hr class="section-gap">` — 16px of `--color-bg-grey` (TDS `Border variant="height16"`, observed).
- Toss screens separate content with whitespace, hairlines and grey gaps. Do not add card borders or drop shadows to list content.

## Skeleton

Spec (notes §3.16): side padding 24px; blocks in `--color-skeleton` (grey100); title 50%×30px r11; subtitle 33%×22px r9; list row 100%×64px r18 with 16px gap; card 100%×240px r38; pulse opacity 0.2→1 and scale 0.96→1, 0.6s `cubic-bezier(.6,0,0,.6)`, alternating, 0.1s stagger; a 110° fade mask.

```html
<div class="skeleton" aria-busy="true" aria-label="불러오는 중">
  <div class="skeleton__title"></div>
  <div class="skeleton__subtitle"></div>
  <div style="height:24px"></div>
  <div class="skeleton__list"></div><div class="skeleton__list"></div><div class="skeleton__list"></div>
</div>
```

## Icons

- TDS icons are a closed set (about 7,000 icons/emoji, Apps in Toss only). Do not copy them. Draw simple 24px line icons yourself: `viewBox="0 0 24 24"`, `stroke="currentColor"`, stroke width 1.8–2, round caps and joins [inferred style].
- Sizes: 24px in rows, nav and toasts; Apps in Toss asks for 24–40px on screen (observed). One icon at a time — don't place icons or emoji side by side as a combo.
- Colour: decorative chevrons `--color-icon` (grey400); meaningful icons `--color-icon-strong` (grey600) or text colour.
- Never use emoji as icons.

## Theme differences per component

| Component | toss-blue | toss-black |
|---|---|---|
| Primary button / BottomCTA | blue500 fill, white label | grey900 fill, white label |
| Weak primary button | blue tint `rgba(100,168,255,.15)`, blue700 label | grey tint `rgba(78,89,104,.07)`, grey700 label (TDS rule) |
| Switch on / checkbox / radio | blue500 | grey900 [skill extension] |
| Tab indicator | grey800 (TDS) | grey900 |
| TextField focus | blue700 label, blue400 line, blue tint | grey900 label, grey900 line, grey tint |
| Links | blue700 text (underline optional) | grey900 text, **underline required** |
| Brand badge | blue weak | elephant weak |
| Status colours (danger, success, warning) | unchanged | unchanged |
| Canvas, text greys, hairlines, radius, type, motion | unchanged | unchanged |
