---
name: Bito
colors:
  primary: '#f92c16'
  accent-orange: '#ff5529'
  accent-deep: '#e74118'
  accent-red: '#ff2700'
  accent-blue: '#4419fe'
  accent-cobalt: '#126dff'
  accent-magenta: '#fb76ff'
  accent-green: '#166b22'
  ink: '#000000'
  canvas: '#ffffff'
  muted: '#707070'
  faint: '#bebebe'
  hairline: '#e2e2e2'
  on-accent: '#ffffff'
typography:
  page-title:
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.5
    use: Project page H3 title, Neue Haas Unica medium
  label-lg:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.2
    use: Filter / section labels (Genre, Service, Sector, Credits)
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.2
    use: Top nav links (Work, News, About, Bitween)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text, Neue Haas Unica regular
  meta:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.2
    use: Faint metadata / tag chips (#bebebe)
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 0px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 24
  lg: 32
  xl: 40
  section: 96
components:
  nav-link:
    type: tab
    textColor: '#000000'
    typography: 16px / 400 neue-haas-unica
    use: Top nav item (Work/News/About/Bitween)
    active: 'ink #000000 label, no underline indicator'
  lang-toggle:
    type: tab
    textColor: '#000000'
    typography: 16px / 400 neue-haas-unica
    use: EN / 中 language switch in header
  project-tile:
    type: card
    backgroundColor: '#f92c16'
    textColor: '#ffffff'
    rounded: 0px
    use: 'Full-bleed warm project thumbnail in the Work grid (also #ff5529 / #e74118 variants)'
  project-tile-dark:
    type: card
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 0px
    use: Black project tile / cover, sharp-cornered
  filter-label:
    type: badge
    textColor: '#000000'
    rounded: 0px
    typography: 24px / 500 neue-haas-unica
    use: Genre / Service / Sector filter heading
  tag-chip:
    type: badge
    textColor: '#bebebe'
    rounded: 0px
    typography: 16px / 400 neue-haas-unica
    use: Inactive genre/service tag (Live Action, Event, Branding…)
  footer-link:
    type: listItem
    textColor: '#000000'
    typography: 16px / 400 neue-haas-unica
    use: Footer contact / social link (Facebook, Instagram, info@bito.tv)
fonts:
  roles:
    latin: neue-haas-unica
    cjk: Noto Sans TC
---

# Bito

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bito; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/bito/DESIGN.md
