---
name: Wadiz
colors:
  primary: '#00c4c4'
  primary-hover: '#07abae'
  tint: '#e6fafa'
  tint-accent: '#bef5f5'
  heading: '#191f28'
  body: '#333d4b'
  muted: '#4e5968'
  subtle: '#6b7684'
  placeholder: '#8b95a1'
  disabled: '#b1b8c3'
  canvas: '#ffffff'
  surface-alt: '#fafbfd'
  surface-neutral: '#f2f5f8'
  divider: '#e3e7ee'
  border: '#ced4de'
  success: '#00af84'
  alert: '#ff5959'
  info: '#4672f9'
  promo: '#fcc500'
  on-primary: '#ffffff'
typography:
  hero-numeral:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.1
    use: Funded amount % on detail pages
  h1:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.2
    use: Home banner, category landing
  h2:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.25
    use: Section titles
  h3:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.3
    use: Maker name, modal headings
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.35
    use: Reward card project title
  lead:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
    use: Short paragraph leads
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
    use: Description text, body copy
  label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Time-remaining, supporter count
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Helper text, fine print
  small:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.3
    use: Badge text, micro-tags
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#00c4c4'
    textColor: '#ffffff'
    rounded: 8px
    use: 'Filled mint contained CTA; active #07abae family'
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#00c4c4'
    rounded: 8px
    use: 'Outlined mint; 1px #00c4c4 border, hover #e6fafa'
  button-tint:
    type: button
    backgroundColor: '#e6fafa'
    textColor: '#00c4c4'
    rounded: 8px
    use: 'Wadiz signature tint button; hover #bef5f5'
  label-badge-solid:
    type: badge
    backgroundColor: '#00c4c4'
    textColor: '#ffffff'
    use: Funding-state chip solid (오픈중)
  label-badge-tint:
    type: badge
    backgroundColor: '#e6fafa'
    textColor: '#00c4c4'
    use: Funding-state chip tint (얼리버드)
  reward-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px
    use: Most-shipped component; 4:3 thumbnail, badge row, funding row
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333d4b'
    rounded: 8px
    padding: 12px 16px
    typography: 15px/400
    use: 'Border 1px #ced4de, focus #00c4c4, error #ff5959'
  modal:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 32px
    use: Desktop modal max-w 480px; mobile bottom-sheet top corners only
  tooltip:
    type: card
    backgroundColor: '#191f28'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 12px
    typography: 12px/400
    use: Tooltip/popover
  nav:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#191f28'
    use: Fixed top header h64, white veil, hairline shadow
fonts:
  roles:
    sans: Pretendard
    mono: ui-monospace
---

# Wadiz

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wadiz; reproduced for educational reference. Full prose: https://oh-my-design.kr/wadiz/design.md
