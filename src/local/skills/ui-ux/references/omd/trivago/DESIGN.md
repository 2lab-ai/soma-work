---
name: trivago
colors:
  primary: '#0079c2'
  primary-hovered: '#4dbeff'
  primary-pressed: '#00578b'
  primary-emphasis: '#24a3ec'
  highlight-subdued: '#bde7ff'
  revenue: '#0a850e'
  revenue-hovered: '#6dce70'
  revenue-pressed: '#075f0a'
  critical: '#e22851'
  critical-pressed: '#b4183a'
  warning: '#e27423'
  notice: '#ffcc31'
  decorative-blue: '#78daff'
  decorative-orange: '#ff932c'
  decorative-pink: '#ff9dde'
  foreground: '#171717'
  text-strong: '#4d4d4c'
  text-subdued: '#6c6c6b'
  border-neutral: '#8d8d8b'
  canvas: '#ffffff'
  surface-subdued: '#f2f2f1'
  disabled: '#d9d8d6'
typography:
  button:
    fontSize: 16px
    fontWeight: 700
    use: search button; system font stack
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
components:
  button-search:
    type: button
    backgroundColor: '#0079c2'
    textColor: '#ffffff'
    rounded: 8px
    height: 44px
    padding: 12px 32px
    typography: 16px / 700
    focus: 'outline 1px dotted #4d4d4c'
    use: 'Suchen — the primary blue search button (--action-primary-default); hover and press could not be measured; the tokens declare hovered #4dbeff and pressed #00578b.'
  button-header:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171717'
    rounded: 8px
    height: 36px
    padding: 8px 16px
    typography: 14px / 700
    focus: 'outline 2px solid #0079c2'
    use: 'Einloggen in the header — white with #171717 text; focus drops the border for a 2px blue outline. Hover not measured.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# trivago

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to trivago; reproduced for educational reference. Full prose: https://oh-my-design.kr/trivago/design.md
