---
name: Mercari
colors:
  public-action: '#5356ee'
  canvas: '#ffffff'
  foreground: '#222222'
  muted: '#6b6b6b'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: '-0.16px'
    use: Repeated public-site body and link text on the supplied US surfaces.
  header-action:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.38
    use: Observed corporate-marketing header text action only.
  marketing-display:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.2
    use: Observed corporate-marketing display heading only.
rounded:
  none: 0px
  compact: 4px
  image: 8px
  circular: 50px
spacing:
  xs: 4
  sm: 6
  md: 12
  lg: 16
  xl: 20
components:
  marketplace-sell-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 4px
    padding: 0px 16px
    typography: 14px/600 Averta
    states: Default baseline captured; no changed interaction style promoted.
    use: Observed default at home::[data-omd-capture="12"] on the public marketplace home only.
    height: 32px
    pressed: opacity 0.76 (:hover + :active)
    focus: opacity 0.76, browser default focus ring (outline auto) on :focus-visible
  marketing-sell-action:
    type: button
    backgroundColor: '#5356ee'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 16px
    typography: 14px/600 Averta
    states: Default baseline captured; no changed interaction style promoted.
    use: Observed default at surface-2::[data-omd-capture="11"] on the corporate-marketing route only.
  marketing-skip-link:
    type: button
    backgroundColor: '#5356ee'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 16px
    typography: 16px/600 Averta
    states: Default and an identical focus snapshot captured; no distinct focus value promoted.
    use: Observed skip-link default and identical focus snapshot at home::[data-omd-capture="3"] on public routes.
  listing-image:
    type: card
    rounded: 8px
    use: Observed image shell at home::[data-testid="AnonCardImage"] on the public marketplace home only.
fonts:
  roles:
    sans: Averta
---

# Mercari

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Mercari; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mercari/DESIGN.md
