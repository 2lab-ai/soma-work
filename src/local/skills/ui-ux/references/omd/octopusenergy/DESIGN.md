---
name: Octopus Energy
colors:
  primary: '#f050f8'
  primary-border: '#f050f8'
  canvas: '#100030'
  canvas-alt: '#180048'
  brand-accent: '#5840ff'
  cyan: '#60f0f8'
  foreground: '#f0ffff'
  on-primary: '#100030'
  muted: '#a49fc8'
typography:
  display-hero:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.5
    use: H1 hero headline — cyan on deep indigo
  section:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.5
    use: H2 section headings — cyan
  subsection:
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.5
    use: H3 feature subheadings — foreground white
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Body paragraphs — foreground white
  body-sm:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Nav links, captions — foreground white
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Fine-print trust indicators
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.11
    use: Button label — Chromatophore medium
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
  lg: 20
  xl: 24
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#f050f8'
    textColor: '#100030'
    rounded: 12px
    padding: 12px 16px
    typography: 16px / 500 Chromatophore
    border: '2px solid #f050f8'
    use: Primary CTA — cookie accept, standard action
  button-primary-lg:
    type: button
    backgroundColor: '#f050f8'
    textColor: '#f0ffff'
    rounded: 12px
    padding: 16px 20px
    typography: 18px / 500 Chromatophore
    border: '2px solid #f050f8'
    use: Large primary CTA — Get a quote on tariffs page
  button-outlined:
    type: button
    backgroundColor: transparent
    textColor: '#f050f8'
    rounded: 12px
    padding: 12px 16px
    typography: 16px / 500 Chromatophore
    border: '2px solid #f050f8'
    use: Secondary outlined button — Fine tune / cookie secondary
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#f0ffff'
    rounded: 12px
    padding: 12px 16px
    typography: 16px / 500 Chromatophore
    use: Nav ghost link-buttons — Energy, Heat pumps, Log in
  input-postcode-hero:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 12px 0px 0px 12px
    padding: 16px
    typography: 18px / 600 Arial
    height: 60px
    use: Hero homepage postcode field — white bg / black text / Arial 600, left-rounded, attached to magenta Get-a-quote button on right
  input-postcode-tariffs:
    type: input
    backgroundColor: transparent
    textColor: '#f0ffff'
    rounded: 0px
    padding: 16px
    typography: 18px / 400 Chromatophore
    border: 2px solid transparent
    height: 60px
    use: 'Tariffs page full-width postcode input — transparent / #f0ffff text / Chromatophore 400 / no radius'
  button-hero-cta:
    type: button
    backgroundColor: '#f050f8'
    textColor: '#f0ffff'
    rounded: 0px 12px 12px 0px
    padding: 16px 20px
    typography: 18px / 400 Chromatophore
    border: '2px solid #f050f8'
    use: Hero attached-CTA button — magenta, right-rounded, paired with hero postcode input
  nav-link:
    type: tab
    textColor: '#f0ffff'
    typography: 16px / 500 Chromatophore
    use: Top nav item
    active: 'text #f0ffff on #180048 background'
  card-product:
    type: card
    backgroundColor: '#180048'
    textColor: '#100030'
    rounded: 12px
    use: Product feature card (Energy/Heat pumps/Solar) on deep indigo
  badge-trust:
    type: badge
    backgroundColor: '#180048'
    textColor: '#f0ffff'
    rounded: 9999px
    typography: 12px / 400 Chromatophore
    use: Trust indicator pill — star ratings, awards
  link-inline:
    type: listItem
    textColor: '#60f0f8'
    typography: 18px / 500 Chromatophore
    use: Inline body links and sub-nav anchor text
fonts:
  roles:
    sans: Chromatophore, helvetica, arial, sans-serif
---

# Octopus Energy

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Octopus Energy; reproduced for educational reference. Full prose: https://oh-my-design.kr/octopusenergy/design.md
