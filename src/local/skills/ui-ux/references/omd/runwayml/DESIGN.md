---
name: RunwayML
colors:
  black: '#000000'
  deep-black: '#030303'
  surface-dark: '#1a1a1a'
  white: '#ffffff'
  near-white: '#fefefe'
  cool-cloud: '#e9ecf2'
  border-dark: '#27272a'
  charcoal: '#404040'
  near-charcoal: '#3f3f3f'
  cool-slate: '#767d88'
  mid-slate: '#7d848e'
  muted-gray: '#a7a7a7'
  cool-silver: '#c9ccd1'
  light-silver: '#d0d4d4'
  tailwind-gray: '#6b7280'
  dark-link: '#0c0c0c'
  footer-gray: '#999999'
typography:
  display-hero:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1.2px'
    use: Hero, film-title presence
  section:
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-1px'
    use: Feature section titles
  subheading:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.9px'
    use: Secondary section markers
  card-title:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1
    use: Article and card headings
  feature-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1
    use: Small headings
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.16px'
    use: Standard body, nav links
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: 0.35px
    use: Metadata, uppercase section labels
  small:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: '-0.16px'
    use: Compact descriptions
  micro:
    fontSize: 11px
    fontWeight: 450
    lineHeight: 1.3
    use: Uppercase tags, tiny labels
rounded:
  sm: 4px
  md: 8px
  lg: 16px
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
  button-default:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 12px
    typography: 14px/600 abcNormal
    use: Restrained button, blends into editorial flow
  button-link:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 8px
    typography: 14px/600 abcNormal
    use: Inline link-style button
  input-default:
    type: input
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 4px
    padding: 8px 12px
    typography: 14px/400 abcNormal
    use: 'Minimal dark input, 1px #27272a border'
  card-photo:
    type: card
    rounded: 8px
    padding: 0px
    use: Mixed-size image grid card, image fills frame, no shadow
  card-dark:
    type: card
    backgroundColor: '#1a1a1a'
    textColor: '#ffffff'
    rounded: 8px
    padding: 16px
    use: 'Functional dark card, 1px #27272a border'
  card-alert:
    type: card
    backgroundColor: '#1a1a1a'
    rounded: 16px
    padding: 24px
    use: 'Alert-style container, 1px #27272a border, larger radius'
  badge-default:
    type: badge
    textColor: '#ffffff'
    rounded: 4px
    padding: 2px 8px
    typography: 11px/600 abcNormal
    use: 'Uppercase label-style, 1px #27272a border'
fonts:
  roles:
    sans: abcNormal
    mono: abcNormal
---

# RunwayML

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to RunwayML; reproduced for educational reference. Full prose: https://oh-my-design.kr/runwayml/design.md
