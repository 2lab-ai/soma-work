---
name: Lezhin Comics
colors:
  primary: '#eb0014'
  primary-hover: '#ff5254'
  primary-dark: '#c40017'
  ink: '#111115'
  deep-dark: '#09090b'
  charcoal: '#222225'
  text-soft: '#36363a'
  text-subtle: '#6f6f77'
  text-muted: '#a1a1a9'
  border-muted: '#e9e9ec'
  surface-muted: '#f4f4f5'
  canvas: '#ffffff'
  on-primary: '#ffffff'
typography:
  section-header:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: '-0.36px'
    use: Section headers
  title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.4
    use: Smaller section headers
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body default
  label:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    use: Label / UI text, button labels
  label-medium:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Medium UI text
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Caption / metadata
  caption-small:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Smallest metadata
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 56
components:
  button-primary:
    type: button
    backgroundColor: '#eb0014'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 12px
    typography: 14px/600
    use: Primary CTA, 48px height
  button-primary-large:
    type: button
    backgroundColor: '#eb0014'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 16px
    typography: 16px/600
    use: Large primary CTA, 56px height
  button-secondary:
    type: button
    backgroundColor: '#222225'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 12px
    typography: 14px/600
    use: Secondary, 48px height
  button-tertiary:
    type: button
    backgroundColor: '#f4f4f5'
    textColor: '#36363a'
    rounded: 4px
    padding: 0 12px
    typography: 14px/600
    use: Tertiary, 48px height
  button-outlined:
    type: button
    backgroundColor: transparent
    textColor: '#36363a'
    rounded: 4px
    padding: 0 20px
    typography: 14px/600
    use: 'Outlined, 1px #a1a1a9 border, 40px height'
  card-thumbnail:
    type: card
    backgroundColor: '#f4f4f5'
    rounded: 4px
    use: Comic thumbnail card, 2/3 portrait aspect
  card-circle:
    type: card
    rounded: 9999px
    use: Circle thumb card, tracked ring
  badge-chip:
    type: badge
    backgroundColor: transparent
    textColor: '#6f6f77'
    rounded: 9999px
    padding: 0 12px
    use: 'Default genre/tag chip, 1px #e9e9ec border, 32px height'
  badge-chip-selected:
    type: badge
    textColor: '#c40017'
    rounded: 9999px
    use: Selected chip
  tab-default:
    type: tab
    textColor: '#111115'
    rounded: 4px
    padding: 0 12px
    use: Default tab, 36px height
  tab-selected:
    type: tab
    textColor: '#ffffff'
    rounded: 4px
    use: Selected tab
  dialog-dropdown:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 4px
    padding: 12px 0
    use: 'Dropdown/select container, 1px #f4f4f5 border'
fonts:
  roles:
    sans: Pretendard Variable
    mono: Pretendard Variable
---

# Lezhin Comics

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Lezhin Comics; reproduced for educational reference. Full prose: https://oh-my-design.kr/lezhin/design.md
