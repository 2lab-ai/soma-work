---
name: PUBLY
colors:
  primary: '#7a3bff'
  primary-pressed: '#6429e6'
  primary-tint: '#f1ebff'
  canvas: '#ffffff'
  ink: '#0f172a'
  slate-950: '#111213'
  slate-800: '#282b2f'
  slate-700: '#3c4043'
  slate-600: '#575b5c'
  slate-500: '#77797b'
  slate-400: '#979b9e'
  slate-300: '#ced0d1'
  slate-200: '#e2e8f0'
  slate-100: '#f5f5f5'
  error: '#ef4444'
  success: '#16a34a'
  on-primary: '#ffffff'
typography:
  display:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.4px'
    use: Landing hero, report cover title
  heading-lg:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.3px'
    use: Section / report title
  heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.3px'
    use: Sub-section, card group header
  title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: Card title, list header
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.63
    letterSpacing: '-0.2px'
    use: Long-form report body, generous leading
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: '-0.2px'
    use: Default body, card description
  label:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: '-0.2px'
    use: Tab label, emphasized inline
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: '-0.2px'
    use: Metadata, author, read-time
  micro:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: '-0.2px'
    use: Fine print, control labels
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
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#7a3bff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px / 600
    use: Primary CTA — 멤버십 시작하기, 3일 무료체험
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#7a3bff'
    rounded: 8px
    padding: 12px 16px
    typography: 14px / 600
    use: 'Secondary CTA — 저장하기, 공유하기, 1px #7a3bff border'
  button-neutral:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#282b2f'
    rounded: 8px
    padding: 12px 16px
    typography: 14px / 500
    use: 'Tertiary action, 1px #e2e8f0 border'
  button-ghost:
    type: button
    textColor: '#7a3bff'
    rounded: 8px
    padding: 8px 12px
    typography: 14px / 600
    use: Inline text action, 더 보기
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0f172a'
    rounded: 8px
    padding: 12px 14px
    typography: 14px / 400
    use: 'Default text input, 1px #e2e8f0 border, focus #7a3bff'
  search:
    type: input
    backgroundColor: '#f5f5f5'
    textColor: '#0f172a'
    rounded: 8px
    padding: 12px 16px
    use: Header / discovery search bar
  content-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 20px
    use: 'Report / content card, 1px #e2e8f0 border'
  membership-card:
    type: card
    backgroundColor: '#f1ebff'
    rounded: 12px
    padding: 24px
    use: Membership / paywall promotion
  tag-default:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#575b5c'
    rounded: 6px
    padding: 4px 8px
    typography: 13px / 600
    use: Topic category
  tag-active:
    type: badge
    backgroundColor: '#f1ebff'
    textColor: '#7a3bff'
    rounded: 6px
    padding: 4px 8px
    typography: 13px / 600
    use: Selected topic filter
  badge-best:
    type: badge
    backgroundColor: '#7a3bff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 3px 6px
    typography: 11px / 700
    use: BEST / NEW / Series flags
  tab:
    type: tab
    textColor: '#575b5c'
    typography: 14px / 600
    use: Topic nav
    active: '#7a3bff text + 2px purple underline'
fonts:
  roles:
    sans: system-ui
---

# PUBLY

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PUBLY; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/publy/DESIGN.md
