---
name: Blinkist
colors:
  brand-green: '#2ee081'
  brand-midnight: '#033049'
  brand-blue: '#0266f2'
  blue-hover: '#0552bd'
  conversion-text: '#008566'
  violet: '#694dd1'
  raspberry: '#c81e34'
  summer-yellow: '#fdbe21'
  rating: '#edab02'
  foreground: '#033049'
  text-secondary: '#3b474a'
  text-tertiary: '#6d787e'
  black: '#000000'
  canvas: '#ffffff'
  pale-mint-grey: '#eff5f3'
  surface-neutral: '#f9fbfa'
  light-grey: '#bac8ce'
  lightest-grey: '#e1e7ea'
typography:
  display:
    fontSize: 64px
    fontWeight: 700
    use: section headings in midnight
  body:
    fontSize: 16px
    fontWeight: 500
    use: buttons and navigation
rounded:
  sm: 4px
  md: 6px
  lg: 8px
components:
  button-conversion:
    type: button
    backgroundColor: '#2ee081'
    textColor: '#033049'
    rounded: 6px
    height: 44px
    padding: 0 16px
    typography: 16px / 500
    hover: rgba(46,224,129,0.8)
    pressed: rgba(46,224,129,0.8)
    focus: 'outline 2px solid #0266f2'
    use: 'Get started — the brand green conversion button with midnight text; hover drops it to 80% and adds a 0 3px 6px #bac8ce shadow; focus a 2px blue outline.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 6px
    height: 32px
    typography: 14px / 500
    hover: 'fg #0552bd'
    pressed: 'fg #0552bd'
    focus: 'outline 2px solid #0266f2'
    use: 'Log in / For Business / Categories — black text turning blue #0552bd on hover; focus a 2px #0266f2 outline.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: CeraPRO
    serif: blinkist-serif
---

# Blinkist

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Blinkist; reproduced for educational reference. Full prose: https://oh-my-design.kr/blinkist/design.md
