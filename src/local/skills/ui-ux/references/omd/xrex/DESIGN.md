---
name: XREX
colors:
  primary: '#275cfd'
  primary-hover: '#153fda'
  link: '#2250f7'
  link-light: '#4d88ff'
  link-mid: '#336aff'
  link-muted: '#4677d4'
  ink: '#0d0e0f'
  ink-pure: '#000000'
  canvas: '#ffffff'
  page: '#dbdbdc'
  surface: '#f8f8f8'
  surface-blue: '#ebf2ff'
  dark-chip: '#2d2f2f'
  navy: '#081b68'
  hairline: '#eeeeee'
  muted: '#696a6a'
  faint: '#b2b3b3'
  success: '#22c55e'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 63px
    fontWeight: 550
    lineHeight: 1.3
    use: Hero/section headlines, Sora
  display-bold:
    fontSize: 63px
    fontWeight: 700
    lineHeight: 1.3
    use: Closing CTA headline, Sora 700
  feature-xl:
    fontSize: 45px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.45px'
    use: Animated word stack (Traceable/Safe/Intuitive), Sora
  section-sub:
    fontSize: 39px
    fontWeight: 700
    lineHeight: 1.4
    use: Sub-section heads, Sora
  section-light:
    fontSize: 39px
    fontWeight: 300
    lineHeight: 1.2
    letterSpacing: '-0.39px'
    use: Light editorial sub-head, Sora 300
  card-title:
    fontSize: 28.5px
    fontWeight: 600
    lineHeight: 1.4
    use: Feature card titles, Sora SemiBold
  hero-lead:
    fontSize: 24px
    fontWeight: 300
    lineHeight: 1.6
    use: Hero lead paragraph, Manrope Light
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading / UI text, Manrope
  cta:
    fontSize: 15.75px
    fontWeight: 400
    use: Header CTA + nav link label, Manrope
  pill:
    fontSize: 19.5px
    fontWeight: 500
    use: Pill Contact-sales button label, Manrope Medium
rounded:
  sm: 13px
  md: 15px
  lg: 999px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 11
  base: 15
  lg: 25
  xl: 34
  xxl: 56
  section: 81
components:
  button-primary:
    type: button
    backgroundColor: '#275cfd'
    textColor: '#ffffff'
    rounded: 15px
    padding: 11.25px 15px
    height: 49px
    typography: 15.75px / 400 Manrope
    use: 'Header Contact-sales CTA, hover #153fda'
  button-pill:
    type: button
    backgroundColor: '#275cfd'
    textColor: '#ffffff'
    rounded: 999px
    padding: 7.5px 33.75px
    height: 41px
    typography: 19.5px / 500 Manrope
    use: In-page Contact-sales pill CTA
  button-glass:
    type: button
    textColor: '#0d0e0f'
    rounded: 15px
    padding: 11.25px 15px
    height: 49px
    typography: 15.75px / 400 Manrope
    use: Log in — translucent rgba(255,255,255,0.35) glass on hero
  icon-circle:
    type: button
    backgroundColor: '#2d2f2f'
    textColor: '#ffffff'
    rounded: 9999px
    height: 38px
    use: Round social/scroll icon chip, dark
  nav-pill:
    type: badge
    backgroundColor: '#2d2f2f'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 15.75px / 400 Sora
    use: Mega-menu category pill (Pay / RegTech / Resources)
  card-glass:
    type: card
    textColor: '#ffffff'
    rounded: 12.75px
    padding: 25.5px
    shadow: rgba(0,0,0,0.1) 0px 0px 50px 0px
    use: Glass feature card on dark — translucent rgba(255,255,255,0.2) + blur
  card-feature:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#0d0e0f'
    rounded: 15px
    use: 'White feature card on #dbdbdc page'
  surface-tint:
    type: card
    backgroundColor: '#ebf2ff'
    textColor: '#0d0e0f'
    rounded: 15px
    use: Tinted blue info surface / highlight block
  nav-link:
    type: tab
    textColor: '#0d0e0f'
    typography: 15.75px / 400 Manrope
    active: 'blue #2250f7 text'
    use: Mega-menu sub-item link, chevron-right affordance
  badge-success:
    type: badge
    textColor: '#22c55e'
    rounded: 9999px
    typography: 15px / 400 Manrope
    use: Positive status / save-percentage indicator
fonts:
  roles:
    display: Sora
    body: Manrope
    merchant: merchant
---

# XREX

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to XREX; reproduced for educational reference. Full prose: https://oh-my-design.kr/xrex/design.md
