---
name: Tumblbug
colors:
  primary: '#fd5744'
  primary-hover: '#f86453'
  primary-pressed: '#e53c41'
  canvas: '#ffffff'
  foreground: '#000000'
  gray-900: '#1c1c1c'
  gray-800: '#3d3d3d'
  gray-600: '#545454'
  gray-500: '#6d6d6d'
  gray-400: '#9e9e9e'
  border: '#e4e4e4'
  surface: '#f0f0f0'
  gray-50: '#f6f6f6'
  error: '#e53c41'
typography:
  display:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 38
    letterSpacing: '-0.4px'
    use: Editorial banner / featured project title
  heading-lg:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 30
    letterSpacing: '-0.4px'
    use: Section header
  heading:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 26
    letterSpacing: '-0.3px'
    use: Project detail title, sub-section
  title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 24
    letterSpacing: '-0.3px'
    use: Card project title
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    letterSpacing: '-0.2px'
    use: Project story body
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22
    letterSpacing: '-0.2px'
    use: Default body, card metadata
  body-bold:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 22
    letterSpacing: '-0.2px'
    use: Creator name, emphasis, nav
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 18
    letterSpacing: '-0.2px'
    use: Days-left, backer count, timestamps
  micro:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16
    letterSpacing: '-0.2px'
    use: Fine print, category labels
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
components:
  button-primary:
    type: button
    backgroundColor: '#fd5744'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 14px 24px
    typography: 16/700
    use: Primary CTA 후원하기
  button-secondary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 14px 24px
    typography: 16/700
    use: Strong neutral action
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#545454'
    rounded: 9999px
    padding: 11.5px 16px
    typography: 14/700
    use: 'Secondary actions, 1px border #e4e4e4'
    hover: '#f0f0f0'
    pressed: '#f0f0f0'
  button-ghost:
    type: button
    textColor: '#000000'
    rounded: 9999px
    padding: 8px 12px
    typography: 14/700
    use: Inline nav / utility action
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    padding: 12px 14px
    typography: 14/400
    use: 'Default text input, 1px border #e4e4e4'
  input-search:
    type: input
    backgroundColor: '#f0f0f0'
    textColor: '#000000'
    rounded: 9999px
    padding: 12px 16px 12px 40px
    typography: 14/400
    use: Header pill search bar
  input-error:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    padding: 12px 14px
    typography: 14/400
    use: 'Validation failure, 1px border #e53c41'
  card-project:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    use: Project listing card, thumbnail + funding bar
  card-reward:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 20px
    use: 'Pledge-tier reward, selected 1.5px #fd5744'
  badge-category:
    type: badge
    backgroundColor: '#f0f0f0'
    textColor: '#545454'
    rounded: 9999px
    padding: 6px 12px
    typography: 13/700
    use: Category filter chip
    active: 'bg #000000, text #ffffff'
  badge-status:
    type: badge
    backgroundColor: '#fd5744'
    textColor: '#ffffff'
    rounded: 4px
    padding: 3px 6px
    typography: 11/700
    use: Time-sensitive project flag
  badge-new:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 3px 6px
    typography: 11/700
    use: 'NEW / editor flag, 1px border #000000'
  tab-bottom:
    type: tab
    textColor: '#9e9e9e'
    use: Bottom tab bar
    active: 'label #000000'
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# Tumblbug

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Tumblbug; reproduced for educational reference. Full prose: https://oh-my-design.kr/tumblbug/design.md
