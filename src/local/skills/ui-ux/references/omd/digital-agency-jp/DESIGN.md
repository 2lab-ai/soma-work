---
name: Digital Agency Design System (DADS)
colors:
  primary: '#0017c1'
  primary-hover: '#00118f'
  link: '#00118f'
  canvas: '#ffffff'
  ink: '#333333'
  ink-strong: '#1a1a1a'
  ink-pure: '#000000'
  muted: '#666666'
  muted-alt: '#767676'
  hairline: '#949494'
  surface: '#f2f2f2'
  surface-alt: '#e6e6e6'
  tint-blue: '#e8f1fe'
  tint-blue-selected: '#d9e6ff'
  error: '#ec0000'
  success: '#197a4b'
  on-primary: '#ffffff'
typography:
  display:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    use: Section headline (H2), Noto Sans JP Bold
  heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Page title (H1) / card heading (H3)
  body-lg:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.7
    use: Default body text, generous CJK line-height
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: UI text, nav links, button labels
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Header nav items
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Button label, Bold
rounded:
  sm: 8px
  md: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-filled:
    type: button
    backgroundColor: '#0017c1'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 8px 16px
    typography: 16px / 700 Noto Sans JP
    use: Primary filled action — search submit, key CTA
    states: 'hover #00118f'
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0017c1'
    border: '1px solid #0017c1'
    rounded: 8px
    height: 56px
    padding: 12px 16px
    typography: 16px / 700 Noto Sans JP
    use: Secondary outline action — section anchors
    states: 'hover bg #e8f1fe'
  button-text:
    type: button
    textColor: '#00118f'
    typography: 17px / 400 Noto Sans JP
    use: Inline text link button (e.g. Figma file link)
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    border: '1px solid #666666'
    rounded: 8px
    height: 48px
    padding: 0 16px
    typography: 16px / 400 Noto Sans JP
    use: 'Search box / text input, focus blue #0017c1'
  card-canvas:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #949494'
    rounded: 16px
    padding: 24px
    use: 'Content navigation card, no shadow, #00118f heading'
  nav-link:
    type: tab
    textColor: '#333333'
    typography: 16px / 400 Noto Sans JP
    padding: 10px 16px
    active: 'text #00118f + 2px bottom border #0017c1'
    use: Header navigation item
  chip-blue:
    type: badge
    backgroundColor: '#e8f1fe'
    textColor: '#00118f'
    rounded: 8px
    typography: 16px / 400 Noto Sans JP
    use: Selected / informational chip tint
  error-text:
    type: badge
    textColor: '#ec0000'
    typography: 16px / 400 Noto Sans JP
    use: Field-level error message colour
fonts:
  roles:
    sans: Noto Sans JP
---

# Digital Agency Design System (DADS)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Digital Agency Design System (DADS); reproduced for educational reference. Full prose: https://oh-my-design.kr/digital-agency-jp/design.md
