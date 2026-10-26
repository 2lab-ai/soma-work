---
name: Triple
colors:
  primary: '#368fff'
  primary-pressed: '#1a85e8'
  sky-accent: '#1aadf6'
  blue-tint: '#f1f7ff'
  canvas: '#ffffff'
  surface: '#f5f6f7'
  heading: '#1b1d1f'
  body: '#3a3e41'
  secondary: '#7e848a'
  tertiary: '#adb1b5'
  border: '#e8eaec'
  border-strong: '#d5d8db'
  success: '#22c55e'
  highlight-teal: '#0ecedb'
  error: '#ff3b30'
  warning: '#faad14'
typography:
  hero:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.3
    use: Intro hero, feature headlines
  section:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.35
    use: Itinerary day headers, section titles
  card-title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Place/itinerary card titles
  cta:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.4
    use: Primary buttons
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptions, tip copy
  meta:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Place metadata, distance, hours
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Badges, fine print
rounded:
  sm: 12px
  md: 12px
  lg: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#368fff'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 28px
    typography: 18/700
    use: Primary CTA, 56px pill
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#368fff'
    rounded: 9999px
    padding: 0 28px
    typography: 18/700
    use: 'Secondary action, 1px border #368fff'
  button-soft:
    type: button
    backgroundColor: '#f1f7ff'
    textColor: '#368fff'
    rounded: 9999px
    padding: 0 24px
    typography: 16/600
    use: Low-emphasis action
  button-ghost:
    type: button
    textColor: '#3a3e41'
    typography: 16/600
    use: Tertiary nav, 더보기
  input-search:
    type: input
    backgroundColor: '#f5f6f7'
    textColor: '#1b1d1f'
    rounded: 12px
    padding: 12px 16px
    typography: 16/400
    use: Destination/place search
  card-place:
    type: card
    backgroundColor: '#ffffff'
    rounded: 20px
    padding: 16px
    use: 'Place/itinerary card, 1px border #e8eaec'
  card-tip:
    type: card
    backgroundColor: '#f1f7ff'
    textColor: '#3a3e41'
    rounded: 20px
    padding: 20px
    typography: 16/400
    use: Travel tips, contextual info
  chip-filter:
    type: badge
    backgroundColor: '#f5f6f7'
    textColor: '#3a3e41'
    rounded: 9999px
    padding: 6px 14px
    typography: 13/500
    use: Place-type filters
    active: 'text #368fff'
  chip-selected:
    type: badge
    textColor: '#368fff'
    rounded: 12px
    use: 'Selected itinerary item, 1px border #368fff'
  tab-nav:
    type: tab
    textColor: '#7e848a'
    typography: 12/500
    use: Bottom/top nav switcher
    active: 'icon+label #368fff'
  toast:
    type: toast
    backgroundColor: '#1b1d1f'
    textColor: '#ffffff'
    rounded: 12px
    padding: 12px 16px
    use: Snackbar transient feedback
  sheet:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#1b1d1f'
    rounded: 20px
    padding: 24px
    use: Modal / bottom sheet
fonts:
  roles:
    sans: '-apple-system'
    mono: '-apple-system'
---

# Triple

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Triple; reproduced for educational reference. Full prose: https://oh-my-design.kr/triple/design.md
