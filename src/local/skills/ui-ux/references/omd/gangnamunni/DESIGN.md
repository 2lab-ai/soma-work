---
name: 강남언니
colors:
  canvas: '#ffffff'
  foreground: '#131517'
  muted: '#697683'
  surface: '#eff2f5'
  border: '#b5bfc9'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 19.6px
  title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 28px
rounded:
  cta: 6px
  card: 20px
  full: 9999px
spacing:
  sm: 8
  md: 12
components:
  outline-cta:
    type: button
    textColor: '#131517'
    border: '1px solid #b5bfc9'
    rounded: 6px
    padding: 8px 12px
    typography: 13px / 600
    pressed: rgba(33, 39, 45, 0.04)
    disabled: '#d8dfe6'
    focus: '#000000'
    states: 'pressed frames exist on home and events (capture 3) and hold the rest values in every dumped property. The pressed, disabled, and focus values were added on 2026-09-16 from a live CSS inspection (commit e8857007) without a recorded property; the July bundle neither confirms nor contradicts them. Corrected 2026-09-29: the July text said no pressed value was retained while one is declared'
    use: Current small outline CTA on home and events
  filter-chip:
    type: button
    backgroundColor: '#eff2f5'
    textColor: '#131517'
    rounded: 9999px
    height: 32px
    padding: 0px 10px
    typography: 14px / 500
    active: '#131517'
    pressed: rgba(33, 39, 45, 0.04)
    disabled: '#f7f9fa'
    focus: '#000000'
    states: selected-false (capture 34) and selected-true (capture 33) variants captured; the bundle holds no pointer-state frame for any chip. The pressed, disabled, and focus values come from the 2026-09-16 live CSS inspection (commit e8857007) without a recorded property and have no bundle counterpart
    use: Current procedure filter chip on home
  media-card-action:
    type: button
    backgroundColor: '#ffffff'
    rounded: 20px
    padding: 0px
    states: default captured; no state frame
    use: 'Home feature-card action (button, rounded-500, eight occurrences) at home::[data-omd-capture="20"]; its 303px rendered height is layout context, and #000000 is the button element''s own colour, not a sampled label colour'
  category-shortcut:
    type: button
    backgroundColor: '#ffffff'
    border: '1px #e4e8ec'
    rounded: 16px
    padding: 6px 16px 6px 8px
    height: 54px
    states: rest captured on fourteen shortcuts (capture 5-18). Each has a pressed frame and capture 9 also a focus frame; those frames hold the rest values in every dumped colour, border, radius, shadow, padding, and type property. Opacity, transform, and overlays are outside the dump, so no pressed or focus value is declared
    use: Home category shortcut link (a.group, text-inherit) at home::[data-omd-capture="5"]; its label colour is inherited and was not sampled
  header-icon-button:
    type: button
    backgroundColor: transparent
    rounded: 0px
    padding: 0px
    size: 44px x 44px
    states: the events copies (surface-2 capture 0 and 2) have pressed frames that hold the rest values in every dumped colour, border, radius, shadow, padding, and type property, so no pressed value is declared; the home copy has no state frame
    use: Header icon button (button.inline-flex, w-[44px]) at home::[data-omd-capture="2"]; icon-only, its glyph colour was not sampled
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#131517'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 16px / 400 / 24px
    states: default captured; no state frame
    use: Home search field (input[type=search].cell-search-input__input, cell-semantic-typography-body-single-lg-subtle) at home::[data-omd-capture="4"]; transparent and borderless inside a wrapper that was not sampled
  link-button:
    type: button
    backgroundColor: transparent
    textColor: '#697683'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 13px / 600 / 20px
    states: default captured; no state frame
    use: Cell link button, size sm (a.cell-link-button--size_sm, cell-semantic-typography-label-sm-strong) at home::[data-omd-capture="180"]; events repeats it (surface-2::[data-omd-capture="58"]); the md size (home::[data-omd-capture="28"]) computes 14px / 600 / 22px
  events-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#697683'
    rounded: 0px
    padding: 12px 0px
    height: 48px
    typography: 16px / 500 / 24px
    selected: 'fg #131517, 16px / 600'
    states: rest (capture 15, typo-label-lg-regular, 14 occurrences) and the emphasised tab (capture 14, typo-label-lg-strong text-fg-neutral-primary) captured; the bundle records no aria-selected, so selected names the class-emphasised tab; no state frame
    use: Events-page tab link at surface-2::[data-omd-capture="15"]
  outline-filter-chip:
    type: button
    backgroundColor: transparent
    textColor: '#697683'
    border: '1px #b5bfc9'
    rounded: 9999px
    padding: 0px 10px
    height: 32px
    typography: 14px / 500 / 19.6px
    states: default captured; no state frame
    use: Events-page filter chip, outline appearance (a.cell-filter-chip--appearance_outline) at surface-2::[data-omd-capture="4"]
fonts:
  roles:
    sans: PretendardVariable
---

# 강남언니

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 강남언니; reproduced for educational reference. Full prose: https://oh-my-design.kr/gangnamunni/design.md
