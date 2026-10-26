---
name: MiriCanvas
colors:
  primary: '#21afbf'
  primary-deep: '#1c95a2'
  ink: '#16181d'
  ink-soft: '#23242a'
  muted: '#70798f'
  canvas: '#ffffff'
  on-primary: '#ffffff'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 1.5
    use: Public homepage h1
  page-title:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.2
    use: Public pricing h1
  subsection:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.29
    use: Public-surface heading
  section:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    use: Public-surface heading
  ui:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Observed navigation and standard buttons
rounded:
  sm: 8px
  md: 10px
  lg: 12px
  xl: 16px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 12
  xl: 16
  xxl: 20
  hero: 24
components:
  primary-button:
    type: button
    backgroundColor: '#21afbf'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    height: 40px
    typography: 14px / 500 / 20px Pretendard Variable
    states: default captured on all three routes; the bundle holds no state frame for any element
    use: Header filled action (button.gidKcw) at home::[data-omd-capture="21"], 80 x 40; repeated near the foot of home (capture 58) and as the highlighted pricing-plan button (surface-3::[data-omd-capture="25"], 249 x 40)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  nav-item:
    type: button
    backgroundColor: transparent
    textColor: '#23242a'
    rounded: 8px
    padding: 8px 16px
    height: 40px
    typography: 14px / 500 / 20px Pretendard Variable
    states: default captured, five per route; no state frame
    use: Global navigation item (button.cuArBU) at home::[data-omd-capture="12"], 68 x 40; the fill computes rgba(35, 36, 42, 0)
  nav-switcher-item:
    type: button
    backgroundColor: transparent
    textColor: '#23242a'
    rounded: 8px
    padding: 12px
    height: 44px
    typography: 14px / 500 / 20px Pretendard Variable
    states: default captured, four per route; no state frame and no selected attribute
    use: 'Top service-switcher item (button.cuArBU) at home::[data-omd-capture="1"], 85 x 44; the first switcher link (capture 0) computes a #ffffff fill and the other three are transparent'
  menu-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#23242a'
    rounded: 8px
    padding: 8px 12px 8px 16px
    height: 40px
    typography: 14px / 500 / 20px Pretendard Variable
    states: default captured with aria-haspopup=menu; the open state is the menu-panel component; no pointer-state frame
    use: Global navigation menu trigger at home::[data-omd-capture="9"], 86 x 40 (capture 10 is 102 x 40)
  menu-panel:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 16px
    size: 1172px x 321px
    shadow: rgba(11, 60, 65, 0.2) 0px 6px 20px 0px
    states: 'captured open only: the three interaction records are menu expansions (expanded, menu-open), one per route'
    use: Navigation menu panel (div role=menu) at home::[data-omd-interaction-capture="menu-0-0"]; the second home menu and the templates and pricing menus are 696 x 321; its links (156 x 40) and feature tiles (288 x 260) carry their labels in children that were not sampled, so no text colour is declared
  hero-primary-cta:
    type: button
    backgroundColor: '#21afbf'
    textColor: '#ffffff'
    rounded: 12px
    padding: 14px 24px
    height: 56px
    typography: 18px / 500 / 26px Pretendard Variable
    states: default captured; no state frame
    use: Home hero filled action (button.hxEAEt) at home::[data-omd-capture="22"], 200 x 56; the same style closes a later home section (capture 49, 197 x 56)
  hero-secondary-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1c95a2'
    rounded: 12px
    padding: 14px 24px
    height: 56px
    typography: 18px / 500 / 26px Pretendard Variable
    states: default captured; no state frame
    use: Home hero white action (a) beside the filled one at home::[data-omd-capture="23"], 200 x 56
  white-large-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0, 0, 0, 0.8)
    rounded: 12px
    padding: 14px 24px
    height: 56px
    typography: 18px / 500 / 26px Pretendard Variable
    states: default captured on four copies; no state frame
    use: 'Home white large button (button.dFMoUp): labelled 146 x 56 at home::[data-omd-capture="59"]; three icon-only 56 x 56 copies at captures 34 to 36'
  pricing-plan-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#1c95a2'
    rounded: 8px
    padding: 8px 16px
    size: 249px x 40px
    typography: 14px / 500 / 20px Pretendard Variable
    states: default captured on three plan buttons; no state frame
    use: Pricing plan button (button.dnPzbg) at surface-3::[data-omd-capture="24"]; captures 26 and 27 match, beside the filled plan button (capture 25); border width 0px
  pricing-billing-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#505462'
    rounded: 0px
    padding: 0px 12px
    height: 40px
    typography: 14px / 400 / 19.88px Pretendard Variable
    states: 'two options at rest: capture 22 computes #505462 and capture 23 #23242a; neither carries an aria state, so no selected value is declared; no state frame'
    use: Pricing billing-period toggle option (button.eufCKf) at surface-3::[data-omd-capture="22"], 48 x 40; its partner (capture 23, kiVaiH) has the same geometry
  pricing-white-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0, 0, 0, 0.8)
    rounded: 10px
    padding: 12px 20px
    height: 48px
    typography: 16px / 500 / 24px Pretendard Variable
    states: default captured on two copies; no state frame
    use: Pricing white button (button.cWuGVk) at surface-3::[data-omd-capture="29"], 143 x 48; capture 30 is 113 x 48
  template-search-input:
    type: input
    backgroundColor: transparent
    textColor: '#16181d'
    size: 827px x 46px
    typography: 16px / 400 / 24.48px Pretendard Variable
    states: default captured; no state frame
    use: Templates search field (input) at surface-2::[data-omd-capture="22"]; the input's own border width is 0px, so any visible frame belongs to a wrapper that was not sampled and no border is declared
  carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    border: 1px rgba(88, 98, 118, 0.1)
    rounded: 50%
    size: 40px x 40px
    shadow: rgba(0, 0, 0, 0.1) 0px 2px 8px 0px
    states: default captured on two arrows; no state frame
    use: Templates carousel arrow (button.lkcSVE, icon-only) at surface-2::[data-omd-capture="40"]; capture 61 matches; the glyph colour was not sampled
  footer-social-link:
    type: button
    backgroundColor: rgba(88, 98, 118, 0.05)
    rounded: 50%
    padding: 8px
    size: 40px x 40px
    states: default captured, five per footer; no state frame
    use: Footer social link (a.qpvPW, icon-only) at home::[data-omd-capture="61"]; captures 62 to 65 match, and the pricing footer repeats them (surface-3 captures 32 to 36)
fonts:
  roles:
    sans: Pretendard Variable
---

# MiriCanvas

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MiriCanvas; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/miricanvas/DESIGN.md
