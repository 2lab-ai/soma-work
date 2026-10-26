---
name: Moin
colors:
  primary: '#0082ff'
  primary-alt: '#007bff'
  ink: '#1a1b22'
  body: '#333333'
  dark: '#242424'
  muted: '#6b6c74'
  muted-slate: '#818daa'
  grey: '#555555'
  faint: '#a9abb4'
  canvas: '#ffffff'
  surface: '#f7f7f8'
  surface-cool: '#f3f5f8'
  hairline: '#efefef'
  border: '#e0e0e0'
  border-cool: '#e9ecef'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    use: Hero H1 headline, Spoqa Han Sans Bold
  section-lg:
    fontSize: 32px
    fontWeight: 700
    use: Large section titles + currency amount value
  section:
    fontSize: 24px
    fontWeight: 700
    use: Feature section headings
  eyebrow:
    fontSize: 16px
    fontWeight: 700
    use: Blue accent eyebrow labels (Speed, Lower fees)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body + UI text
  button:
    fontSize: 16px
    fontWeight: 700
    use: Primary / dark button label
rounded:
  sm: 6px
  md: 8px
  lg: 16px
  xl: 20px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0082ff'
    textColor: '#ffffff'
    rounded: 6px
    height: 50px
    padding: 8px 16px
    border: 1px solid rgba(0,50,100,0.1)
    typography: 16px / 400 Spoqa Han Sans
    use: Currency-exchange 'Send money' CTA — the core product action
  button-nav:
    type: button
    backgroundColor: '#007bff'
    textColor: '#ffffff'
    rounded: 6px
    height: 40px
    padding: 8px 16px
    border: '1px solid #007bff'
    typography: 16px / 700 Spoqa Han Sans
    use: Top-nav 'Send money' button
  button-dark:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 6px
    height: 52px
    padding: 14px 48px
    typography: 16px / 700 Spoqa Han Sans
    use: Secondary 'More reviews' action
  button-carousel:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#555555'
    border: '1px solid #e0e0e0'
    rounded: 8px
    height: 48px
    use: Review carousel prev / next arrow
  input-amount:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#242424'
    rounded: 6px
    typography: 32px / 700 Spoqa Han Sans
    states: 'active value turns #0082ff'
    use: Currency amount field on the exchange widget
  card-surface:
    type: card
    backgroundColor: '#f7f7f8'
    textColor: '#1a1b22'
    rounded: 16px
    shadow: rgba(0,0,0,0.05) 0px 4px 15px
    use: Tinted content / review card
  card-cool:
    type: card
    backgroundColor: '#f3f5f8'
    textColor: '#1a1b22'
    border: '1px solid #efefef'
    rounded: 16px
    use: Cool-tinted feature block
  eyebrow-label:
    type: badge
    textColor: '#0082ff'
    typography: 16px / 700 Spoqa Han Sans
    use: Blue accent eyebrow above feature headings (Speed, Easy to start, Lower fees)
fonts:
  roles:
    sans: Spoqa Han Sans
    fallback: Spoqa Han Sans JP
---

# Moin

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Moin; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/moin/DESIGN.md
