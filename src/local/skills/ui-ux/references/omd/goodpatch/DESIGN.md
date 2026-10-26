---
name: Goodpatch
colors:
  primary: '#096fc8'
  primary-light: '#81b0da'
  sky: '#76b7ed'
  ink: '#333333'
  ink-pure: '#000000'
  body: '#6e6e6e'
  muted: '#9096a2'
  faint: '#8f95a1'
  canvas: '#ffffff'
  paper: '#f6f6f6'
  dark: '#191b1f'
  dark-chrome: '#45474a'
  coral: '#ff776b'
  coral-tint: '#ffaba3'
  plum: '#534c97'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 150px
    fontWeight: 700
    lineHeight: 0.85
    letterSpacing: '-5.25px'
    use: English hero wordmark headline, Galano Grotesque Bold
  display-news:
    fontSize: 53px
    fontWeight: 600
    lineHeight: 1.13
    letterSpacing: '-1.33px'
    use: Large section banner (News), Galano Grotesque
  work-title:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: '-1px'
    use: Work / case-study card titles
  section-label:
    fontSize: 23px
    fontWeight: 400
    lineHeight: 1.23
    use: Section sub-heads (Company profile, Culture), Galano Grotesque
  eyebrow:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.25
    use: Blue section eyebrow labels (Services, Work, Products)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 2
    use: Standard reading text, Yu Gothic Pr6N
  news-head:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.58
    use: News item headlines, Yu Gothic Pr6N B
  button:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.25
    use: Pill CTA label, Galano Grotesque
  nav-jp:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 2.2
    use: Sub-nav Japanese links, Yu Gothic Pr6N B
rounded:
  sm: 8px
  pill: 9999px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  base: 16
  md: 24
  lg: 40
  xl: 66
  section: 120
components:
  cta-primary:
    type: button
    backgroundColor: '#096fc8'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 16px 24px
    height: 56px
    typography: 15px / 400 My Galano Grotesque
    use: Primary pill CTA — View services / View selected works
  cta-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#096fc8'
    border: '1px solid #096fc8'
    rounded: 9999px
    padding: 16px 24px
    height: 56px
    typography: 15px / 400 My Galano Grotesque
    use: Secondary outline pill — View career info
  cta-consent:
    type: button
    backgroundColor: '#096fc8'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 40px
    height: 48px
    typography: 15px / 400 Yu Gothic Pr6N
    use: Cookie-consent confirm (同意する)
  contact-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#096fc8'
    rounded: 8px
    padding: 66px 16px
    use: Large Contact / Careers entry panel, blue-on-white, no shadow
  work-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 8px
    use: 'Work / case-study tile on #f6f6f6 paper, title shifts to #81b0da'
  section-eyebrow:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#096fc8'
    rounded: 8px
    typography: 16px / 400 My Galano Grotesque
    use: Blue section eyebrow label (Services, Work, Products)
  nav-link:
    type: tab
    textColor: '#333333'
    typography: 16px / 400 My Galano Grotesque
    active: 'text #096fc8'
    use: Top nav item; hover/active turns signature blue
  footer-link:
    type: listItem
    textColor: '#333333'
    typography: 15px / 400 Yu Gothic Pr6N
    use: Footer / sub-nav Japanese navigation link
fonts:
  roles:
    display: My Galano Grotesque
    cjk: Yu Gothic Pr6N
    sans: sans-serif
---

# Goodpatch

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Goodpatch; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/goodpatch/DESIGN.md
