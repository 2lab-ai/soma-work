---
name: Studysapuri
colors:
  primary: '#0b41a0'
  primary-dark: '#093788'
  primary-light: '#275ab3'
  foreground: '#24243f'
  text-secondary: '#808d96'
  text-spot: '#adb8be'
  action-primary: '#0ca5e6'
  action-primary-light: '#30b6f0'
  action-primary-dark: '#0c8dd8'
  action-secondary: '#3ec1bd'
  action-secondary-light: '#64cdca'
  action-secondary-dark: '#33aab2'
  ultra-blue: '#1c80e7'
  spot-gray: '#67717a'
  spot-pink: '#de30ca'
  spot-purple: '#aa30de'
  spot-violet: '#b551e0'
  canvas: '#ffffff'
  surface-gray: '#fafafa'
  surface-sky: '#f0f8ff'
  surface-sky-strong: '#e1f4ff'
  surface-tint: '#e3eefa'
  line: '#e9eeef'
  promo-red: '#f0307d'
  promo-pink: '#f56ca3'
  promo-yellow: '#fcda21'
  promo-orange: '#ff8c5a'
  subject-math: '#436fba'
  subject-japanese: '#e7cc4c'
  subject-informatics: '#69cbf5'
  subject-practical: '#8eaee5'
typography:
  caption:
    fontSize: 11px
    use: 6 text elements
  small:
    fontSize: 12px
    use: 61 text elements; the login link
  body:
    fontSize: 14px
    use: 104 text elements, the dominant size; cards and grade pills
  lead:
    fontSize: 16px
    use: 12 text elements
  cta:
    fontSize: 19px
    use: the primary call to action, 700
  heading:
    fontSize: 20px
    use: 5 text elements
  display:
    fontSize: 24px
    use: 2 text elements, the largest measured
rounded:
  md: 8px
  lg: 10px
  pill: 1440px
components:
  button-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0b41a0'
    rounded: 10px
    height: 69px
    padding: 20px 0
    typography: 19px / 700
    shadow: rgba(0,0,0,0.15) 0 3px 6px
    hover: opacity 0.9
    pressed: opacity 0.9
    use: 初回の方は14日間無料体験！会員登録へ — the sign-up call to action. White with a blue label and the page's only offset shadow. Hover and press fade it to 90% over 0.3s; colours do not change. Focus is the browser's ring.
  link-login:
    type: button
    backgroundColor: transparent
    textColor: '#0b41a0'
    rounded: 0px
    height: 32px
    padding: 1px 12px
    typography: 12px / 700
    hover: opacity 0.5
    pressed: opacity 0.5
    use: ログイン in the header. Fades to half opacity on hover — the deepest fade on the page.
  card-audience:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#24243f'
    rounded: 8px
    padding: 0 12px 0 0
    typography: 14px / 400
    shadow: rgba(0,0,0,0.1) 0 0 10px
    hover: opacity 0.8
    pressed: opacity 0.8
    use: Audience cards (高校生・高卒生 and siblings) — a centred soft shadow, fading to 80% on hover.
  pill-grade:
    type: button
    backgroundColor: '#e3eefa'
    textColor: '#0b41a0'
    rounded: 8px
    height: 60px
    typography: 14px / 700
    hover: opacity 0.7
    pressed: opacity 0.7
    use: Grade selectors (高校1年生 and siblings) on a pale blue tint, fading to 70% on hover.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Open Sans
---

# Studysapuri

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Studysapuri; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/studysapuri/DESIGN.md
