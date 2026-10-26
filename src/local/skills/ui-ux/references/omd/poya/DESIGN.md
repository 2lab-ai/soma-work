---
name: 寶雅
colors:
  primary: '#dd006f'
  primary-soft: '#fff1f5'
  foreground: '#231815'
  foreground-soft: '#5e4d48'
  canvas: '#ffffff'
  hairline: '#cfcfcf'
  on-primary: '#ffffff'
typography:
  action:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    use: Observed 45px pink pill action on all three supplied public surfaces
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    use: Observed Traditional-Chinese story/timeline body samples; family is surface-specific
  heading:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 27
    use: Observed public content heading/text samples; not a complete display scale
rounded:
  pill: 99px
spacing:
  xs: 5
  sm: 8
  md: 10
  lg: 15
  xl: 20
  xxl: 25
components:
  primary-pill-action:
    type: button
    backgroundColor: '#dd006f'
    textColor: '#ffffff'
    border: '1px solid #dd006f'
    rounded: 99px
    padding: 8px 20px
    height: 45px
    typography: 16px / 400 / 24px PT Serif
    states: Default geometry observed on three public surfaces; interactionCount is 0, so hover, focus, pressed, disabled, and error values are absent.
    use: Selector-backed .btn action on the public home, brand-story, and timeline routes
    pressed: 'bg #ffffff, label #dd006f (:hover + :active)'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  search-field:
    type: input
    backgroundColor: '#fff1f5'
    textColor: '#5e4d48'
    border: '0px #5e4d48'
    rounded: 99px
    padding: 0px 40px 0px 25px
    height: 45px
    typography: 16px / 400 / 24px PT Serif
    states: Default geometry observed on three public surfaces; interactionCount is 0, so hover, focus, pressed, disabled, and error values are absent.
    use: Selector-backed .searchInput field in the shared public header
fonts:
  roles:
    ui: PT Serif
    cjk: Noto Sans TC
---

# 寶雅

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 寶雅; reproduced for educational reference. Full prose: https://oh-my-design.kr/poya/design.md
