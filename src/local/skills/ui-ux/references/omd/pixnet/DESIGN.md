---
name: PIXNET
colors:
  primary: '#ff7200'
  primary-deep: '#e85f00'
  accent-red: '#ff432b'
  accent-tint: '#fcdfda'
  canvas: '#ffffff'
  surface-muted: '#f4f4f4'
  heading: '#423e3c'
  body: '#423e3c'
  label: '#575451'
  muted: '#817f7d'
  muted-2: '#969492'
  on-primary: '#ffffff'
  hairline: '#eaeae9'
  border-soft: '#c0bfbe'
  ink: '#000000'
typography:
  heading-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: 0.5px
    use: Section / channel headings, nav emphasis
  heading:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1.2px
    use: Card titles, tag labels, h1/h2 inline
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 1.2px
    use: Standard reading text, article copy
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Meta, captions, secondary lines
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Primary CTA label (login)
  nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Header nav links, footer links
  caption:
    fontSize: 13px
    fontWeight: 400
    use: Timestamps, counts, fine print
rounded:
  sm: 4px
  md: 6px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ff7200'
    textColor: '#ffffff'
    rounded: 6px
    typography: weight 500, 36px tall
    use: Primary CTA (login)
  button-ghost:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#423e3c'
    rounded: 6px
    use: 'Secondary action, 1px #eaeae9 hairline border'
  tag-pill:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#423e3c'
    rounded: 6px
    typography: weight 700
    use: Tag / channel label, hairline border
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 6px
    use: 'Article/content card, hairline #eaeae9 border, low warm shadow'
fonts:
  roles:
    serif: Noto Serif TC
    sans: system-ui
---

# PIXNET

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PIXNET; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/pixnet/DESIGN.md
