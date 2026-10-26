---
name: Dailymotion
colors:
  purple: '#6200ee'
  purple-700: '#8133f1'
  purple-deep: '#360083'
  lavender: '#c5a1f9'
  hover-surface: '#f2ebfe'
  gradient-pink-1: '#fab3f7'
  gradient-pink-2: '#f682f2'
  gradient-lavender: '#a2a2fb'
  decorative-selected: '#fde1fc'
  magenta-text: '#8108a6'
  lime: '#c2ff80'
  foreground: '#0d0d0d'
  text-secondary: '#2b2b2b'
  text-muted: '#767676'
  canvas: '#ffffff'
  surface-secondary: '#f8f8f8'
  surface-tertiary: '#f0f0f0'
  input-border: '#dadada'
  error: '#b72a1a'
typography:
  heading:
    fontSize: 28px
    fontWeight: 500
    use: page H1; DailySans 700 for card titles
  button:
    fontSize: 14px
    fontWeight: 500
    use: header buttons
rounded:
  md: 6px
components:
  button-gradient:
    type: button
    backgroundColor: transparent
    textColor: '#0d0d0d'
    rounded: 6px
    height: 40px
    padding: 0 16px
    typography: 14px / 500
    hover: '#f682f2'
    pressed: '#fde1fc'
    use: 'Se connecter — a 228° gradient #fab3f7 → #f682f2 → #a2a2fb (decorative-gradient tokens); hover paints a solid #f682f2 ::before; press #fde1fc.'
  button-secondary:
    type: button
    backgroundColor: '#f8f8f8'
    textColor: '#0d0d0d'
    rounded: 6px
    height: 40px
    padding: 0 16px
    typography: 14px / 500
    hover: '#f8f8f8'
    pressed: '#f0f0f0'
    use: 'Rechercher — light grey; hover adds a 0 0 8px rgba(13,13,13,.12) shadow; press #f0f0f0.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: ABCFavorit
    display: DailySans
---

# Dailymotion

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Dailymotion; reproduced for educational reference. Full prose: https://oh-my-design.kr/dailymotion/design.md
