---
name: Supabase
colors:
  primary: '#72e3ad'
typography:
  display:
    fontSize: 46px
    fontWeight: 500
    lineHeight: 1
    use: Home h1 only; not a complete display scale
  body:
    fontSize: 16px
    fontWeight: 450
    lineHeight: 1.5
    use: Repeated public-route Inter text and list items
  control:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.14
    use: Observed public navigation/control sample
rounded:
  focus: 2px
  control: 6px
  overlay: 8px
spacing:
  xs: 4
  sm: 8
  md: 12
  control: 16
  lg: 24
  xl: 32
components:
  green-form-submit:
    type: button
    backgroundColor: '#72e3ad'
    textColor: oklch(0.1 0 34)
    border: 1px solid oklab(0.685565 -0.144466 0.057858 / 0.75)
    rounded: 6px
    padding: 4px 10px
    typography: 12px / 450 / Inter
    states: dialog-open capture context
    use: home::[data-omd-capture="75"] public form submit
  dark-compact-action:
    type: button
    backgroundColor: oklch(0.1 0 34)
    textColor: oklch(0.995 0 34)
    border: 1px solid oklch(0.394455 0 34)
    rounded: 6px
    padding: 4px 10px
    typography: 12px / 450 / Inter
    states: focus, hover, and pressed computed snapshots
    use: pricing::[data-omd-capture="17"] compact public action
  selected-pill-tab:
    type: tab
    backgroundColor: oklch(0.995 0 34)
    textColor: oklch(0.1 0 34)
    border: 1px solid oklch(0.1 0 34)
    rounded: 3.35544e+07px
    padding: 8px 32px
    typography: 14px / 450 / Inter
    states: selected and tab-selected
    use: home::[data-omd-capture="19"] selected public tab
  public-input:
    type: input
    backgroundColor: oklab(0.1 0 0 / 0.026)
    textColor: oklch(0.1 0 34)
    border: 1px solid oklch(0.1 0 34 / 0.146418)
    rounded: 6px
    padding: 8px
    typography: 14px / 450 / Inter
    states: error capture; no changed error color is asserted
    use: home::[data-omd-capture="74"] public email input
  public-dialog:
    type: dialog
    backgroundColor: oklch(0.995 0 34)
    textColor: oklch(0.1 0 34)
    border: 1px solid oklch(0.1 0 34 / 0.0812725)
    rounded: 8px
    states: dialog-open
    use: home::[data-omd-interaction-capture="dialog-1-0"] public dialog
fonts:
  roles:
    ui: Inter
    display: Manrope
    mono: Source Code Pro
---

# Supabase

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Supabase; reproduced for educational reference. Full prose: https://oh-my-design.kr/supabase/design.md
