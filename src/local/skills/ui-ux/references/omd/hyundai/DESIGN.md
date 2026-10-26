---
name: Hyundai
colors:
  primary: '#002c5f'
  accent-teal: '#007fa8'
  accent-cyan: '#00aad2'
  ink: '#000000'
  on-primary: '#ffffff'
  muted: '#999999'
  utility: '#444444'
  footer: '#1c1b1b'
typography:
  display-h2:
    fontSize: 44px
    fontWeight: 400
    lineHeight: 1.32
    letterSpacing: '-0.4px'
    use: Observed h2 on the KR product home surface
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.15
    use: Observed product-surface text
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.4px'
    use: Observed navy vehicle action
rounded:
  none: 0px
  pager: 6px
components:
  selected-carousel-indicator:
    type: tab
    textColor: '#000000'
    rounded: 0px
    active: true
    use: 'Selected shell observed on the home surface; its #000000 text colour is inherited and styles no visible label, and the visible mark is the carousel-pager button'
  vehicle-action:
    type: button
    backgroundColor: '#002c5f'
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px
    height: 50px
    typography: 16px / 500 / HyundaiSansTextKR
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Vehicle catalogue filled action (a.btn.nuxt-link-active) at surface-2::[data-omd-capture="15"], 180 x 50; the IONIQ 6 intro carries the same values
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: 'border #007fa8, outline #000000 solid 2px on :focus-visible'
  primary-nav-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 30px
    typography: 16px / 400 / HyundaiSansHeadKRR
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Top-level menu trigger (button.lnb_depth0_btn) at home::[data-omd-capture="2"]; 15 instances across the three product surfaces
  external-link-sm:
    type: button
    backgroundColor: transparent
    textColor: '#444444'
    rounded: 0px
    padding: 10px 0px
    height: 34px
    typography: 14px / 500 / HyundaiSansHeadKR
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Inline external link (a.btn.btn-external-sm.in-phrase) at home::[data-omd-capture="128"]; 9 instances across the three product surfaces
  carousel-pager:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.1)
    rounded: 6px
    size: 12px x 12px
    selected: 'bg #007fa8'
    states: rest and selected variants captured; the label is hidden (font-size 0, transparent text); no pointer-state frame
    use: Home carousel pager (button.el-carousel__button) at home::[data-omd-capture="76"]; the selected one is home::[data-omd-capture="75"], paired one-to-one in document order with the aria-selected indicator li
  family-site-control:
    type: button
    backgroundColor: '#1c1b1b'
    textColor: '#999999'
    border: '1px solid #676767'
    rounded: 0px
    padding: 0px 13px
    height: 30px
    typography: 13.3333px / 400 / Arial
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Footer Family Site control at home::[data-omd-capture="146"], 190 x 30; present on all three product surfaces
  chatbot-trigger:
    type: button
    backgroundColor: '#00aad2'
    border: 4px solid transparent
    rounded: 100%
    size: 60px x 60px
    shadow: rgba(0, 0, 0, 0.15) 0px 0px 20px 0px
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Home chatbot button (button.btn.ibtn.chatbot) at home::[data-omd-capture="122"]; one instance
  quick-menu-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 82px 0px 0px
    size: 100px x 100px
    typography: 15px / 500 / HyundaiSansTextKR
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Home quick-menu link (a.btn.menu-link.btn-text) at home::[data-omd-capture="36"]; 13 instances; the 82px top padding leaves room for an icon that the style dump does not record
  slide-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#666666'
    rounded: 0px
    padding: 0px
    height: 30px
    typography: 16px / 400 / HyundaiSansTextKRR
    selected: 'fg #007fa8 (class is-active)'
    states: rest and is-active variants captured (role=tab, no aria-selected); no pointer-state frame
    use: Home slide-information tab (button.slideinfo-list__link, role=tab) at home::[data-omd-capture="52"] through "54"; the active one is home::[data-omd-capture="51"]
  slide-dot:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.1)
    rounded: 60%
    size: 12px x 12px
    selected: 'bg #007fa8 (class is-active)'
    states: rest and is-active variants captured; no pointer-state frame
    use: Home slide dot (button.slideinfo-list__link) at home::[data-omd-capture="29"] through "34"; the active one is home::[data-omd-capture="28"]
  more-link:
    type: button
    backgroundColor: transparent
    textColor: '#002c5f'
    rounded: 0px
    padding: 0px
    height: 18px
    typography: 16px / 500 / HyundaiSansHeadKR
    states: default captured; the bundle holds no pointer-state frame for any Hyundai element
    use: Home navy more link (a.btn.btn-more-blue) at home::[data-omd-capture="58"]; a white-text instance at "57" stands on a backdrop that is not claimed
  footer-disclosure-toggle:
    type: toggle
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 24px 50px 21px
    size: 1118px x 69px
    typography: 16px / 400 / HyundaiSansHeadKR
    states: default captured; the expanded state was not captured
    use: Footer disclosure toggle (span.button-toggle.area-icon) recorded as home::span at 1118 x 69 (top 6619); present on all three product surfaces
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: HyundaiSansHeadKR
    body: HyundaiSansTextKR
---

# Hyundai

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hyundai; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/hyundai/DESIGN.md
