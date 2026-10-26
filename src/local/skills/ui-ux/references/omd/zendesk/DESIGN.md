---
name: Zendesk Garden
colors:
  primary: '#1f73b7'
  canvas: '#ffffff'
  foreground: '#293239'
  muted: '#5c6970'
  border: '#b0b8be'
  success: '#4eab89'
  danger: '#cd3642'
typography:
  display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.17
    use: Observed 48px/700/56px h1 on the supplied Garden home route
  section-heading:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.22
    use: Observed documentation h2 on the supplied button route
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Repeated body, navigation, list-item, and control text; family omitted because the capture resolves only to a system stack
rounded:
  control: 4px
  icon-control: 100px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 20
  xl: 36
components:
  primary-doc-button:
    type: button
    backgroundColor: '#1f73b7'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 15px
    height: 40
    states: Default only; no hover, focus, pressed, disabled, or loading state was observed
    use: Native button on the public button-documentation route; selector surface-2::[data-omd-capture="90"]
    typography: 14px / 400
    pressed: 'bg #0f3655 (:hover + :active)'
    focus: 'shadow #ffffff 0px 0px 0px 1px, #1f73b7 0px 0px 0px 3px on :focus-visible'
  icon-button:
    type: button
    textColor: '#5c6970'
    rounded: 4px
    height: 40
    states: Default only; no hover, focus, pressed, disabled, or loading state was observed
    use: Native icon button on the public button-documentation route; selector surface-2::[data-omd-capture="64"]
  sidebar-list-item:
    type: listItem
    textColor: '#293239'
    rounded: 0px
    height: 32
    use: Static documentation sidebar row; selector surface-2::li
---

# Zendesk Garden

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Zendesk Garden; reproduced for educational reference. Full prose: https://oh-my-design.kr/zendesk/design.md
