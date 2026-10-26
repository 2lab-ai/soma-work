---
name: Duolingo
colors:
  primary: '#58cc02'
  primary-lip: '#58a700'
  mask: '#89e219'
  accent: '#1cb0f6'
  accent-lip: '#1899d6'
  canvas: '#ffffff'
  foreground: '#4b4b4b'
  on-primary: '#ffffff'
  error: '#ff4b4b'
  warning: '#ffc800'
  fox: '#ff9600'
  beetle: '#ce82ff'
typography:
  display-hero:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.5px'
    use: Landing hero, big celebrations
  title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    use: Section titles, modal headers
  body:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  button:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.2
    use: CTA button labels (uppercase)
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
  lg: 24
  xl: 32
  xxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#58cc02'
    textColor: '#ffffff'
    rounded: 12px
    padding: 14px 20px
    height: 50px
    typography: 15px / 700
    shadow: '0 4px 0 #58a700'
    active: translateY(4px), lip collapses
    disabled: 'bg #e5e5e5, fg #afafaf, no lip'
    use: Single primary action — CONTINUE, START, CHECK ANSWER (uppercase)
  button-accent:
    type: button
    backgroundColor: '#1cb0f6'
    textColor: '#ffffff'
    rounded: 12px
    padding: 14px 20px
    typography: 15px / 700
    shadow: '0 4px 0 #1899d6'
    use: Alternative positive action, Super upsell, info CTA (uppercase)
  card:
    type: card
    backgroundColor: '#ffffff'
    border: '2px solid #e5e5e5'
    rounded: 16px
    padding: 16px
    shadow: none
    use: Course units, skill tiles, list rows
fonts:
  roles:
    sans: din-round
    display: Feather Bold
---

# Duolingo

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Duolingo; reproduced for educational reference. Full prose: https://oh-my-design.kr/duolingo/design.md
