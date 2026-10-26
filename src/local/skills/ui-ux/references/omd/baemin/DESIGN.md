---
name: Baemin
colors:
  primary: '#0cefd3'
  canvas: '#ffffff'
  foreground: '#222222'
  baemin-dark: '#000000'
  baemin-panel: '#f6f6f6'
  corporate-foreground: '#232324'
  corporate-muted: '#6c6d6f'
  corporate-surface: '#f3f4f5'
  corporate-disabled: '#cccccc'
  corporate-border: '#a6a7a9'
  on-dark: '#ffffff'
typography:
  baemin-hero:
    fontSize: 60px
    fontWeight: 800
    lineHeight: 84px
  baemin-heading:
    fontSize: 24px
    fontWeight: 700
  baemin-button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 22.4px
  corporate-heading:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 52px
    letterSpacing: '-1.2px'
  corporate-card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 36px
    letterSpacing: '-0.4px'
  corporate-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: '-0.32px'
  corporate-label:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 21px
    letterSpacing: '-0.32px'
  catalog-title:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 64.8px
    letterSpacing: '-0.32px'
rounded:
  corporate-control: 8px
  download-card: 12px
  media-control: 16px
  circle: 9999px
spacing:
  xs: 6
  sm: 8
  md: 12
  lg: 16
  xl: 20
  xxl: 24
  section: 32
components:
  app-download-card:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 12px
    height: 54px
    padding: 14px 19px
    typography: 13.3333px / 400
    hover: '#ffffff'
    pressed: '#ffffff'
    states: 'store buttons: on App Store, hover and pressed measured 2026-09-29 with :hover and :active matched and nothing changes, as a 2026-09-17 run also found; keyboard focus-visible shows no indicator: outline none and nothing else changes (real Tab walk, 2026-09-29); Google Play shares the geometry but its states are unmeasured (corrected 2026-09-29: the #f7f7f7 hover and pressed previously recorded here belong to the QR button, now app-download-qr)'
    use: baemin.com App Store and Google Play download buttons
  baemin-nav-link:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 22px
    typography: 16px / 700
    hover: 'border-bottom 1px solid #ffffff'
    pressed: 'border-bottom 1px solid #ffffff'
    states: 'hover and pressed add a 1px solid #ffffff bottom border (22.4px to 23.4px tall, a 1px layout shift) on all three header links in the 2026-07-11 capture and again on 2026-09-29 with :hover and :active matched; keyboard focus-visible shows no indicator: outline none and nothing else changes (real Tab walk, 2026-09-29); corrected 2026-09-29, earlier text said hover not retained'
    use: 'baemin.com top navigation link, white on the mint #0cefd3 navigation bar'
  woowa-more-light:
    type: button
    backgroundColor: '#f3f4f5'
    textColor: '#232324'
    rounded: 8px
    height: 52px
    padding: 0 22px
    typography: 16px / 700
    states: default captured; hover not retained
    use: Woowa corporate light read-more action
  woowa-more-overlay:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.3)
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 8px
    height: 52px
    padding: 0 22px
    typography: 16px / 700
    states: default on image overlay; hover not retained
    use: Woowa corporate overlay read-more action
  woowa-site-selector:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#6c6d6f'
    border: '1px solid #a6a7a9'
    rounded: 8px
    height: 50px
    padding: 13px 16px
    typography: 14px / 400
    states: default captured; expanded state not retained
    use: Woowa footer family-site selector
  woowa-carousel-control:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.4)
    textColor: '#000000'
    rounded: 50%
    height: 40px
    states: default and disabled navigation states observed
    use: Woowa media carousel navigation
  font-download:
    type: button
    backgroundColor: transparent
    textColor: '#232324'
    height: 28px
    typography: 16px / 700
    states: available download and unavailable/disabled controls observed on the catalog
    use: official font catalog download action
  app-download-qr:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 12px
    padding: 13px
    size: 54px x 54px
    typography: 13.3333px / 400
    hover: '#f7f7f7'
    pressed: '#f7f7f7'
    states: 'hover and pressed fill #f7f7f7 in the 2026-07-11 capture (home capture 2) and again on 2026-09-29 with :hover and :active matched; keyboard focus-visible shows no indicator: outline none and nothing else changes (real Tab walk, 2026-09-29)'
    use: baemin.com QR-code app download button beside the store buttons
  baemin-gift-pill:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 16px 32px
    height: 58px
    typography: 18px / 700 / 25.2px
    hover: '#000000'
    pressed: '#000000'
    states: 'present in the 2026-09-29 DOM (bottom section) and absent from the 2026-07-11 capture; hover and pressed measured 2026-09-29 with :hover and :active matched and nothing changes; keyboard focus-visible shows no indicator: outline none and nothing else changes (real Tab walk, 2026-09-29)'
    use: baemin.com B2B gift-certificate purchase link (기업용 상품권 구매하기)
  baemin-footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 39px
    typography: 30px / 700 / 39px
    hover: 'underline #ffffff'
    pressed: 'underline #ffffff'
    states: 'hover and pressed add a #ffffff underline (2026-09-29, :hover and :active matched); keyboard focus-visible shows no indicator: a focus-visible class is applied but outline stays none and nothing else changes (real Tab walk, 2026-09-29)'
    use: 'baemin.com footer service link (배민외식업광장), white on the #000000 footer'
  baemin-footer-legal-link:
    type: button
    backgroundColor: transparent
    textColor: '#b1b3b5'
    height: 19.6px
    typography: 14px / 400 / 19.6px
    hover: 'fg #b1b3b5 (unchanged)'
    pressed: 'fg #b1b3b5 (unchanged)'
    states: 'hover and pressed measured 2026-09-29 with :hover and :active matched: no visible change; keyboard focus-visible shows no indicator: outline none and nothing else changes (real Tab walk, 2026-09-29)'
    use: 'baemin.com footer legal link (개인정보처리방침) on the #000000 footer'
  catalog-fill-button:
    type: button
    backgroundColor: '#232324'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 22px
    height: 52px
    typography: 14px / 700 / 28px / -0.3px
    states: 'rest sampled (2026-07-11); the hover and pressed frames change only border-color, #d6d7da to #0cefd3, on a 0px border, so nothing visible changes and no state value is declared; focus not sampled'
    use: Woowa font catalog filled link button (.btn-fill)
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  catalog-pill-button:
    type: button
    backgroundColor: '#f3f4f5'
    textColor: '#a6a7a9'
    rounded: 20px
    padding: 0px 22px
    height: 40px
    typography: 14px / 400 / 28px
    states: rest identical on ten same-style buttons (2026-07-11); no pointer-state, selected or focus sample, so none is declared
    use: Woowa font catalog pill button (.btn), ten instances
fonts:
  roles:
    ui: BAEMINWORK
---

# Baemin

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Baemin; reproduced for educational reference. Full prose: https://oh-my-design.kr/baemin/design.md
