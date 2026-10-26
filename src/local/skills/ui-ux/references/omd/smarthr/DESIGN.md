---
name: SmartHR
colors:
  brand: '#00c4cc'
  primary: '#0077c7'
  primary-hover: '#0068ae'
  danger: '#e01e5a'
  danger-hover: '#ca1b51'
  canvas: '#ffffff'
  surface: '#f8f7f6'
  surface-hover: '#f2f2f2'
  foreground: '#23221e'
  text-grey: '#706d65'
  body: '#4e4c49'
  muted: '#aaa69f'
  border: '#d6d3d0'
  border-hover: '#cac6c2'
  hairline: '#edebe6'
  success: '#0f7f85'
  warning: '#ffcc17'
  info: '#0077c7'
  link: '#0071c1'
  disabled-bg: '#f2f2f2'
  disabled-fg: '#c1bdb7'
  on-primary: '#ffffff'
typography:
  size-10:
    fontSize: 10px
    use: Smallest published step
  size-11:
    fontSize: 11px
    use: Dense metadata
  size-12:
    fontSize: 12px
    use: Helper and caption text
  size-13:
    fontSize: 13px
    use: Dense table text
  size-14:
    fontSize: 14px
    use: Secondary body
  size-15:
    fontSize: 15px
    use: Body alternate
  size-16:
    fontSize: 16px
    use: Base body and control text
  size-18:
    fontSize: 18px
    use: Sub-heading
  size-20:
    fontSize: 20px
    use: Section heading
  size-24:
    fontSize: 24px
    use: Page heading
  size-26:
    fontSize: 26px
    use: Large heading
  size-28:
    fontSize: 28px
    use: Display heading
  size-36:
    fontSize: 36px
    use: Marketing heading
  size-48:
    fontSize: 48px
    use: Marketing display
  size-52:
    fontSize: 52px
    use: Marketing display, large
  size-54:
    fontSize: 54px
    use: Largest published step
rounded:
  md: 6px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
components:
  button-primary:
    type: button
    backgroundColor: '#0077c7'
    textColor: '#ffffff'
    border: '1px solid #0077c7'
    rounded: 6px
    padding: 12px 16px
    typography: 16px / 700
    hover: '#0068ae'
    pressed: '#0068ae'
    use: Single most important action — 42px tall.
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#23221e'
    border: '1px solid #d6d3d0'
    rounded: 6px
    padding: 12px 16px
    typography: 16px / 700
    hover: '#f2f2f2'
    pressed: '#f2f2f2'
    use: Cancel or secondary action beside a primary.
  button-danger:
    type: button
    backgroundColor: '#e01e5a'
    textColor: '#ffffff'
    border: '1px solid #e01e5a'
    rounded: 6px
    padding: 12px 16px
    typography: 16px / 700
    hover: '#ca1b51'
    pressed: '#ca1b51'
    use: Destructive action.
  button-text:
    type: button
    textColor: '#0071c1'
    rounded: 6px
    typography: 16px / 400
    hover: '#f2f2f2'
    pressed: '#f2f2f2'
    use: Low-emphasis inline action on a transparent fill.
  button-ghost:
    type: button
    textColor: '#23221e'
    rounded: 6px
    typography: 16px / 700
    hover: '#f2f2f2'
    pressed: '#f2f2f2'
    use: Neutral low-emphasis action on a transparent fill.
  button-disabled:
    type: button
    backgroundColor: '#f2f2f2'
    textColor: '#c1bdb7'
    rounded: 6px
    disabled: '#f2f2f2'
    use: Unavailable action — palette swap with cursor not-allowed, no opacity trick.
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#23221e'
    border: '1px solid #d6d3d0'
    rounded: 6px
    focus: outline ring
    use: Form text field, 42px tall.
  status-label:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#706d65'
    border: '1px solid #d6d3d0'
    use: Status chip — 24px tall; semantic variants recolour text and border.
---

# SmartHR

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SmartHR; reproduced for educational reference. Full prose: https://oh-my-design.kr/smarthr/design.md
