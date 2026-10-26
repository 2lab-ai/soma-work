---
name: Lablup
colors:
  primary: '#28ab6c'
  teal: '#002926'
  cyan: '#03b5e5'
  ink: '#000000'
  dark-card: '#1a1a1a'
  canvas: '#ffffff'
  surface: '#fafafa'
  surface-grey: '#f3f3f3'
  hairline: '#e5e5e5'
  muted: '#606060'
  faint: '#929292'
  mint: '#badba3'
  dark-grey: '#383838'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 700
    lineHeight: 1.05
    use: Hero headline, Google Sans Bold
  display-lg:
    fontSize: 52px
    fontWeight: 700
    use: Major section titles (Better together / Need a hand)
  section:
    fontSize: 36px
    fontWeight: 600
    use: Section headings (Latest news / Trusted by)
  subsection:
    fontSize: 34px
    fontWeight: 600
    use: News card headline / feature heads
  button:
    fontSize: 19px
    fontWeight: 700
    use: Pill CTA label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  caption:
    fontSize: 13px
    fontWeight: 500
    use: Consent / utility button label
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 18px
  xl: 24px
  pill: 999px
spacing:
  xs: 4
  sm: 8
  md: 14
  base: 16
  lg: 24
  xl: 32
  xxl: 40
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#002926'
    textColor: '#ffffff'
    rounded: 999px
    padding: 16px 36px
    typography: 19px / 700
    use: Primary deep-teal pill CTA (View all partners)
  button-dark:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 999px
    padding: 14px 24px
    typography: 19px / 500
    use: Black pill CTA (About Lablup)
  button-inverse:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#002926'
    rounded: 999px
    padding: 18px 40px
    typography: 19px / 700
    use: White pill CTA on dark sections (Contact Us)
  button-outline:
    type: button
    textColor: '#ffffff'
    border: 1px solid rgba(255,255,255,0.3)
    rounded: 999px
    padding: 14px 34px
    typography: 19px / 600
    use: Ghost outline pill on dark (View All)
  button-accent:
    type: button
    backgroundColor: '#28ab6c'
    textColor: '#ffffff'
    rounded: 4px
    padding: 7px 16px
    typography: 13px / 500
    use: Emerald accent action (consent Accept All)
  card-light:
    type: card
    backgroundColor: '#f3f3f3'
    textColor: '#000000'
    rounded: 24px
    padding: 20px 24px
    use: Light feature shortcut card (Product / News / Careers grid)
  card-dark:
    type: card
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 24px
    padding: 20px 24px
    use: Near-black dark feature card
  card-blog:
    type: card
    backgroundColor: '#f3f3f3'
    rounded: 18px
    padding: 32px
    border: '1px solid #e5e5e5'
    use: Blog link card with hairline outline (no shadow)
  nav-circle:
    type: button
    textColor: '#ffffff'
    border: 1px solid rgba(255,255,255,0.3)
    rounded: 50%
    use: Carousel prev/next circle on dark hero
  doc-link:
    type: listItem
    textColor: '#03b5e5'
    typography: 18px / 400
    use: Backend.AI docs TOC / inline link accent
fonts:
  roles:
    display: Google Sans
    body: Pretendard
    docs: Poppins
---

# Lablup

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Lablup; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/lablup/DESIGN.md
