---
name: PatternFly
colors:
  primary: '#0066cc'
  foreground: '#151515'
  body: '#4d4d4d'
  canvas: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated body, list-item, and default control text on all three supplied PatternFly.org surfaces.
  display-title:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.3
    use: Observed H1 on the supplied public PatternFly.org surfaces.
rounded:
  none: 0px
  control: 6px
  card: 16px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
components:
  primary-action:
    type: button
    backgroundColor: '#0066cc'
    textColor: '#ffffff'
    rounded: 999px
    padding: 8px 24px
    typography: 14/400 Red Hat Text
    states: 'Observed default only; the supplied artifact has interactionCount: 0, so no hover, focus, pressed, disabled, or error value is specified.'
    use: home::[data-omd-capture="2"] — selector-backed pf-v6-c-button pf-m-primary action on the public home.
  featured-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#151515'
    rounded: 16px
    typography: 14/400 Red Hat Text
    use: home::#featured-blog-post-1 — selector-backed pf-v6-c-card pf-m-clickable default geometry on the public home.
fonts:
  roles:
    ui: Red Hat Text
    display: Red Hat Display
---

# PatternFly

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PatternFly; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/patternfly/DESIGN.md
