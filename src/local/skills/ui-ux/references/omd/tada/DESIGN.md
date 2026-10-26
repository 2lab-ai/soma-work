---
name: TADA
colors:
  primary: '#1ec59f'
  primary-pressed: '#17a384'
  primary-deep: '#149378'
  mint-light: '#e6f8f3'
  canvas: '#ffffff'
  heading: '#1a1a1a'
  gray-800: '#333333'
  gray-700: '#555555'
  body: '#777777'
  gray-500: '#999999'
  gray-400: '#bbbbbb'
  border: '#e5e5e5'
  surface: '#f2f2f2'
  on-primary: '#ffffff'
  error: '#ff4452'
  warning: '#ff9f1c'
  navy: '#19254d'
typography:
  display:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 38
    letterSpacing: '-0.4px'
    use: Onboarding / hero moment
  heading-lg:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 30
    letterSpacing: '-0.4px'
    use: Screen title
  heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 26
    letterSpacing: '-0.3px'
    use: Section header, vehicle type title
  title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 24
    letterSpacing: '-0.3px'
    use: Bottom-sheet header, list header
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    letterSpacing: '-0.2px'
    use: Descriptions, address text
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22
    letterSpacing: '-0.2px'
    use: Default body, list metadata
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18
    letterSpacing: '-0.2px'
    use: Secondary metadata, timestamps
  micro:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16
    letterSpacing: '-0.2px'
    use: Fine print, map labels
rounded:
  sm: 8px
  md: 12px
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
  section: 40
components:
  button-primary:
    type: button
    backgroundColor: '#1ec59f'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px 20px
    typography: 16/700
    use: Primary CTA, thumb-reachable bottom action
  button-dark:
    type: button
    backgroundColor: '#19254d'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px 20px
    typography: 16/700
    use: Marketing-surface strong CTA
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1ec59f'
    rounded: 12px
    padding: 16px 20px
    typography: 16/600
    use: Secondary CTA
  button-neutral:
    type: button
    backgroundColor: '#f2f2f2'
    textColor: '#333333'
    rounded: 12px
    padding: 14px 16px
    typography: 14/500
    use: Tertiary actions
  button-danger:
    type: button
    backgroundColor: '#ff4452'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px 20px
    typography: 16/700
    use: Destructive confirm
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1a'
    rounded: 12px
    padding: 14px 16px
    typography: 16/400
    use: Default text input
  input-search:
    type: input
    backgroundColor: '#f2f2f2'
    textColor: '#1a1a1a'
    rounded: 12px
    padding: 14px 16px 14px 44px
    typography: 16/400
    use: Destination-entry field
  card-vehicle:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 16px
    use: Vehicle type selection card
  card-trip:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 20px
    use: Active-trip summary over map
  badge-status:
    type: badge
    backgroundColor: '#e6f8f3'
    textColor: '#149378'
    rounded: 8px
    padding: 4px 8px
    typography: 12/700
    use: Trip status
  badge-neutral:
    type: badge
    backgroundColor: '#f2f2f2'
    textColor: '#555555'
    rounded: 8px
    padding: 4px 8px
    typography: 12/700
    use: Metadata / feature label
  tab-bottom:
    type: tab
    textColor: '#999999'
    use: Bottom tab bar
    active: 'label #1ec59f, icon filled'
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# TADA

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to TADA; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/tada/DESIGN.md
