---
name: SurveyCake
colors:
  primary: '#3dba90'
  primary-hover: '#34a07d'
  primary-deep: '#2b8568'
  on-primary: '#ffffff'
  canvas: '#ffffff'
  surface-mute: '#f7f7f7'
  surface-gray: '#f2f2f2'
  ink: '#3e3e3e'
  ink-strong: '#000000'
  muted: '#9b9b9b'
  hairline: '#dddddd'
  accent-violet: '#5f54e0'
  accent-amber: '#f5b849'
  accent-coral: '#f26659'
  accent-blue: '#0073b7'
typography:
  display-hero:
    fontSize: 42px
    fontWeight: 900
    lineHeight: 1.5
    letterSpacing: 1px
    use: Hero headline, heavy black weight authority
  section:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: Feature section titles
  subheading:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: Card / sub-section heads
  body-lg:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.75
    use: Feature descriptions, intro
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.75
    use: Standard reading text
  link:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Inline 了解更多 green text links
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Primary CTA label
  nav:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1
    use: Top navigation links
  caption:
    fontSize: 14px
    fontWeight: 400
    use: Plan labels, metadata, fine print
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
  section: 80
components:
  button-primary:
    type: button
    backgroundColor: '#3dba90'
    textColor: '#ffffff'
    rounded: 4px
    padding: 60px tall hero
    typography: 14px/500 Noto Sans TC
    use: 'Hero/section primary action, hover #34a07d'
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3dba90'
    rounded: 4px
    typography: 14px/700 Noto Sans TC
    use: 'Sign-up 註冊, 1px #3dba90 border'
  link-green:
    type: badge
    textColor: '#3dba90'
    typography: 16px/700 Noto Sans TC
    use: Inline 了解更多 learn-more link, no underline
  input-text:
    type: input
    textColor: '#000000'
    rounded: 4px
    use: 'Form input, 1px #dddddd border, focus #3dba90, placeholder #9b9b9b'
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 8px
    use: 'Feature card, soft neutral shadow on #f7f7f7 sections'
  tab-pricing:
    type: tab
    textColor: '#3e3e3e'
    typography: 14px/400 Noto Sans TC
    active: 'Highlighted tier #3dba90 top band'
    use: Pricing tier card label
fonts:
  roles:
    sans: Noto Sans TC
    fallback: Helvetica Neue, Microsoft JhengHei, sans-serif
---

# SurveyCake

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SurveyCake; reproduced for educational reference. Full prose: https://oh-my-design.kr/surveycake/design.md
