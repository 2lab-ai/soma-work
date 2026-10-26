---
name: AmazingTalker
colors:
  primary: '#02cab9'
  primary-deep: '#02b3a4'
  coral: '#ff5f5f'
  coral-soft: '#ffe5e5'
  canvas: '#ffffff'
  surface: '#f3f5f7'
  surface-alt: '#fbfbfb'
  heading: '#363636'
  body: '#484848'
  muted: '#767676'
  slate: '#909399'
  on-primary: '#ffffff'
  hairline: '#dcdfe6'
  hairline-soft: '#ebebeb'
typography:
  display-hero:
    fontSize: 50px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0px
    use: Hero H1 over imagery, white text, friendly authority
  section:
    fontSize: 31px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0px
    use: Feature section titles, e.g. 4 reasons to learn
  section-cjk:
    fontSize: 30px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0px
    use: CJK section titles on Helvetica/PingFang stack
  subhead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: 0px
    use: Hero subtitle, card category heads
  body-lg:
    fontSize: 18px
    fontWeight: 300
    lineHeight: 1.5
    letterSpacing: 0px
    use: Price labels, intro lines
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Standard reading text, nav links
  button:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Primary hero CTA label
  button-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Header utility buttons, Sign In
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Small labels, helper text
rounded:
  sm: 3px
  md: 5px
  lg: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 18
  xl: 24
  xxl: 36
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#02cab9'
    textColor: '#ffffff'
    rounded: 5px
    typography: Roboto 20px/400
    use: hero primary CTA
  button-primary-cta:
    type: button
    backgroundColor: '#02cab9'
    textColor: '#ffffff'
    rounded: 3px
    padding: 8px 18px
    typography: 24px/300
    use: section CTA
  button-ghost:
    type: button
    textColor: '#484848'
    use: header utility actions (Sign In, Apply To Teach), no border
  card-course:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#484848'
    rounded: 8px
    use: ambient shadow, image top + price label
  accent-coral:
    type: badge
    backgroundColor: '#ffe5e5'
    textColor: '#ff5f5f'
    use: badges, highlights, urgency tags, soft tint background
  nav-link:
    type: tab
    typography: Roboto 16px/400
    use: nav link
    active: 'teal #02cab9 on active/hover'
fonts:
  roles:
    sans: Roboto
    cjk: Helvetica Neue, PingFang, Microsoft JhengHei
---

# AmazingTalker

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to AmazingTalker; reproduced for educational reference. Full prose: https://oh-my-design.kr/amazingtalker/design.md
