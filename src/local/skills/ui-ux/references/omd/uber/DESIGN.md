---
name: Uber
colors:
  primary: '#000000'
  canvas: '#ffffff'
  on-primary: '#ffffff'
  surface-soft: '#efefef'
  surface-hover: '#e2e2e2'
  foreground: '#000000'
  muted: '#757575'
  subtle: '#afafaf'
typography:
  display:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.23
    use: Public marketing/corporate h1
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.22
    use: Public marketing/corporate h2
  heading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Observed h2/h3
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed body copy
  body-strong:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.25
    use: Observed UI text
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.14
    use: Header button labels
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Menu item labels
  fine-print:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.67
    use: Observed small body copy
rounded:
  none: 0px
  card: 8px
  pill: 999px
spacing:
  xs: 4
  sm: 8
  control-x: 10
  control-y: 12
  md: 14
  base: 16
  lg: 20
  control-wide: 25
  xl: 48
components:
  header-dark-control:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 999px
    padding: 10px 12px
    typography: 14px/500
    states: hover white 0.1 inset overlay; pressed white 0.2 inset overlay
    use: Public-site header control
  header-light-menu-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 999px
    padding: 10px 12px
    typography: 14px/500
    states: 'focus #fbfbfb/#fdfdfd; pressed white 0.2 inset overlay'
    use: Public-site header menu trigger
  soft-pill-control:
    type: button
    backgroundColor: '#efefef'
    textColor: '#000000'
    rounded: 999px
    padding: 14px 16px
    typography: 16px/500
    states: hover black 0.04 inset overlay; pressed black 0.08 inset overlay
    use: Home public-surface control
fonts:
  roles:
    display: UberMove
    ui: UberMoveText
---

# Uber

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Uber; reproduced for educational reference. Full prose: https://oh-my-design.kr/uber/design.md
