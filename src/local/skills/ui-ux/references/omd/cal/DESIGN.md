---
name: Cal.com
colors:
  primary: '#242424'
  primary-hover: '#111111'
  brand: '#242424'
  canvas: '#ffffff'
  foreground: '#242424'
  deep-text: '#111111'
  muted: '#898989'
  on-primary: '#ffffff'
  surface-alt: '#f5f5f5'
  link: '#0099ff'
  link-default: '#0000ee'
  black: '#000000'
  focus-ring: '#3b82f6'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0px
    use: Cal Sans hero, maximum impact, tight default spacing
  section-heading:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0px
    use: Cal Sans large section titles
  feature-heading:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0px
    use: Cal Sans feature block headlines
  subheading:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.2px
    use: Cal Sans sub-head, positive spacing at smaller size
  subheading-alt:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0px
    use: Cal Sans relaxed line-height variant
  card-title:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: 0px
    use: Cal Sans smallest usage, card titles
  caption-label:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0px
    use: Cal Sans small labels
  body-light:
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.3
    letterSpacing: '-0.2px'
    use: Cal Sans UI Light body intro text
  body-light-std:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: Cal Sans UI Light body text
  caption-light:
    fontSize: 14px
    fontWeight: 300
    lineHeight: 1.4
    letterSpacing: '-0.2px'
    use: Cal Sans UI Light captions and descriptions
  ui-label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0px
    use: Inter UI buttons and nav labels
  caption-inter:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.14
    letterSpacing: 0px
    use: Inter small UI text
  micro:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0px
    use: Inter smallest text
  code:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0px
    use: Roboto Mono code snippets, technical text
  body-matter:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.14
    letterSpacing: 0px
    use: Matter Regular alternate body text (product UI)
rounded:
  xs: 2px
  sm: 4px
  base: 6px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 28
  section: 80
  section-lg: 96
components:
  button-primary:
    type: button
    backgroundColor: '#242424'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 20px
    typography: 16px / 600
    hover: opacity 0.7
    use: Signature CTA — maximally dark on white
  button-ghost:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#242424'
    rounded: 8px
    padding: 12px 20px
    shadow: rgba(19,19,22,0.7) 0px 1px 5px -4px, rgba(34,42,53,0.08) 0px 0px 0px 1px, rgba(34,42,53,0.05) 0px 4px 8px 0px
    typography: 16px / 600
    use: Secondary CTA with shadow-ring border (no CSS border)
  button-pill:
    type: button
    backgroundColor: '#242424'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 8px 16px
    use: Rounded pill-shaped actions
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#242424'
    border: 1px solid rgb(118,118,118)
    rounded: 8px
    padding: 8px 12px
    focus: '--framer-focus-outline'
    use: Text input / select
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    padding: 16px 24px
    shadow: rgba(19,19,22,0.7) 0px 1px 5px -4px, rgba(34,42,53,0.08) 0px 0px 0px 1px, rgba(34,42,53,0.05) 0px 4px 8px 0px
    use: Standard card; ring shadow as border
  badge-pill:
    type: badge
    backgroundColor: '#242424'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 10px
    typography: 12px / 600
    use: Pill-shaped badges and tags
  badge-default:
    type: badge
    backgroundColor: '#f5f5f5'
    textColor: '#242424'
    rounded: 8px
    padding: 4px 8px
    typography: 12px / 600
    use: Default badge
  nav:
    type: tab
    backgroundColor: white/transparent
    textColor: '#111111'
    use: Sticky top nav, Cal Sans links, dark primary CTA
fonts:
  roles:
    sans: Cal Sans
    body: Inter
    mono: Roboto Mono
---

# Cal.com

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cal.com; reproduced for educational reference. Full prose: https://oh-my-design.kr/cal/design.md
