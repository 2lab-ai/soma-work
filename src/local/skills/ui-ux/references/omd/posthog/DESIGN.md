---
name: PostHog
colors:
  primary: '#1e1f23'
  brand: '#F54E00'
  canvas: '#fdfdf8'
  foreground: '#4d4f46'
  heading: '#23251d'
  muted: '#65675e'
  surface: '#eeefe9'
  surface-sage: '#e5e7e0'
  surface-tan: '#d4c9b8'
  hairline: '#bfc1b7'
  border-light: '#b6b7af'
  placeholder: '#9ea096'
  accent-amber: '#F7A501'
  accent-gold: '#b17816'
  focus: '#3b82f6'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 30px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: '-0.75px'
    use: Hero headline — extra-bold, tight
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    use: Section titles — large, generous line-height
  feature:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Feature section titles
  subheading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.5px'
    use: Content sub-sections
  body-semi:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.56
    use: Semi-bold body / callout text
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  nav:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.5
    use: Navigation and UI labels
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Small text, captions
  micro:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
    use: Tags, badges, smallest labels
  code:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Code snippets and terminal
rounded:
  sm: 2px
  md: 4px
  lg: 6px
  full: 9999px
spacing:
  xs: 2
  sm: 4
  md: 8
  base: 12
  lg: 16
  xl: 24
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#1e1f23'
    textColor: '#ffffff'
    rounded: 6px
    padding: 10px 12px
    typography: 15px / 600
    hover: 'opacity 0.7, text #F7A501'
    active: opacity 0.8, slight scale
    use: Main CTA — dark and confident
  button-sage:
    type: button
    backgroundColor: '#e5e7e0'
    textColor: '#4d4f46'
    rounded: 4px
    padding: 4px
    typography: 14px / 500
    hover: 'bg #f4f4f4, text #F54E00'
    use: Compact utility button
  button-tan:
    type: button
    backgroundColor: '#d4c9b8'
    textColor: '#000000'
    rounded: 0px
    padding: 10px 12px
    hover: 'text #F54E00'
    use: Featured/premium actions
  button-ghost:
    type: button
    backgroundColor: '#fdfdf8'
    textColor: '#4d4f46'
    border: 1px solid transparent
    rounded: 4px
    padding: 8px 12px
    hover: 'text #F54E00'
    use: Minimal-presence ghost button
  input-default:
    type: input
    backgroundColor: '#eeefe9'
    textColor: '#374151'
    border: '1px solid #b6b7af'
    rounded: 4px
    padding: 2px 0 2px 8px
    focus: '#3b82f6 ring at 50% opacity'
    use: Standard form input
  input-search:
    type: input
    backgroundColor: '#eeefe9'
    textColor: '#374151'
    border: '1px solid #b6b7af'
    rounded: 4px
    padding: 6px 8px
    use: Search/filter control
  card-bordered:
    type: card
    backgroundColor: '#fdfdf8'
    border: '1px solid #bfc1b7'
    rounded: 6px
    padding: 16px
    use: Clean minimal default card
  card-sage:
    type: card
    backgroundColor: '#eeefe9'
    border: '1px solid #bfc1b7'
    rounded: 4px
    padding: 16px
    use: Secondary content container
  card-shadow:
    type: card
    backgroundColor: '#fdfdf8'
    rounded: 6px
    padding: 16px
    shadow: 0px 25px 50px -12px rgba(0,0,0,0.25)
    hover: orange text flash
    use: Elevated content (modals, dropdowns)
  badge-default:
    type: badge
    backgroundColor: '#e5e7e0'
    textColor: '#4d4f46'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 500
    use: Default tag
  badge-featured:
    type: badge
    backgroundColor: '#d4c9b8'
    textColor: '#000000'
    rounded: 4px
    padding: 2px 8px
    typography: 12px / 600
    use: Warm tan featured tag
fonts:
  roles:
    sans: IBM Plex Sans Variable
    mono: Source Code Pro
---

# PostHog

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PostHog; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/posthog/DESIGN.md
