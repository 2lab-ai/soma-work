---
name: Vipps
colors:
  brand: '#ff5b24'
  brand-hover: '#ff8c4f'
  brand-pressed: '#d34718'
  content-interactive: '#f05400'
  content-interactive-hover: '#a9330b'
  content-interactive-pressed: '#802000'
  purple: '#722ac9'
  purple-hover: '#8851f6'
  purple-pressed: '#551488'
  lavender: '#f1ebff'
  foreground: '#0f0e0e'
  text-secondary: '#6e6a69'
  text-tertiary: '#b0acab'
  ground: '#fff4ec'
  surface: '#f9f6f6'
  surface-sunken: '#f2eeed'
  surface-branded: '#ffece5'
  toolbar: '#161225'
  canvas: '#ffffff'
  border-subtle: '#d9d5d4'
  focus: '#5a78ff'
  positive: '#006628'
  negative: '#c60000'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: body and navigation
  button:
    fontSize: 16px
    fontWeight: 500
    use: pill buttons
rounded:
  pill: 50px
components:
  button-primary:
    type: button
    backgroundColor: '#722ac9'
    textColor: '#f7f7f5'
    rounded: 50px
    height: 40px
    padding: 4px 16px
    typography: 16px / 500
    hover: '#8851f6'
    pressed: '#551488'
    focus: outline 3px solid rgba(67,47,255,0.6)
    use: Tæpp med Vipps — the purple pill (--button-primary-color-background-*); lighter on hover, darker when pressed, a 3px translucent blue-violet focus outline.
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#722ac9'
    border: '#722ac9'
    rounded: 50px
    height: 40px
    padding: 4px 16px
    typography: 16px / 500
    hover: '#f1ebff'
    pressed: '#ffffff'
    focus: outline 3px solid rgba(67,47,255,0.6)
    use: 'Vipps for bedrifter — white pill with a purple border and label; hover fills lavender #f1ebff.'
  link-toolbar:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    height: 23px
    typography: 16px / 400
    hover: transparent
    pressed: transparent
    focus: 'outline 3px solid #ffffff'
    use: 'Privat / Bedrift / Hjelp on the #161225 toolbar — white text that underlines on hover and press; focus is a 3px white outline.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: VeryVerySans
---

# Vipps

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Vipps; reproduced for educational reference. Full prose: https://oh-my-design.kr/vipps/design.md
