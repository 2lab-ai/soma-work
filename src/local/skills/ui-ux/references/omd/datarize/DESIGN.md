---
name: Datarize
colors:
  canvas: '#ffffff'
  ink: '#191919'
  action: '#111111'
  body: '#5d6875'
  link: '#007aff'
  surface: '#f2f5fa'
  hairline: '#e5e7eb'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 83.2
    letterSpacing: '-3.2px'
    use: Marketing homepage H1; loaded Pretendard Bold
  section:
    fontSize: 44px
    fontWeight: 600
    lineHeight: 57.2
    letterSpacing: '-0.05px'
    use: Marketing H2; loaded Pretendard SemiBold
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24
    use: Blog and pricing body copy; loaded Pretendard Regular
  nav:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 21
    use: Marketing navigation; loaded Pretendard Medium
  cta:
    fontSize: 16px
    fontWeight: 600
    use: Marketing CTA links; loaded Pretendard Variable
rounded:
  sm: 8px
  md: 10px
  pill: 50px
  full: 999px
spacing:
  xs: 6
  sm: 8
  md: 10
  lg: 14
  xl: 16
  xxl: 20
  xxxl: 24
  section: 32
components:
  pricing-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#191919'
    rounded: 999px
    padding: 8px 16px
    typography: 12px / 400 Pretendard
    selected: 'bg #ffffff'
    states: 'unselected rest (capture 12, aria-selected=false) and selected (capture 11, aria-selected=true) captured; after the collector clicked capture 12 and 13, each was re-captured with bg #ffffff and aria-selected=true (tab-0-0, tab-1-0); no pointer-state frame'
    use: 'Pricing tab (button role=tab, 34px) at surface-3::[data-omd-capture="12"] inside the pricing tablist. Corrected 2026-09-29: the July token held the selected tab''s #ffffff as its rest background'
  action-ink-pill:
    type: button
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 50px
    padding: 14px 24px
    height: 47px
    typography: 16px / 600 / Pretendard Variable
    states: default captured; the bundle holds no pointer-state frame on any of its three surfaces
    use: Home CTA link at home::[data-omd-capture="11"]
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  shared-ink-pill:
    type: button
    backgroundColor: '#191919'
    textColor: '#ffffff'
    rounded: 50px
    padding: 14px 24px
    height: 46px
    typography: 15px / 600 / Pretendard Variable
    states: default captured on home, blog and pricing (capture 10 on each, identical values); no pointer-state frame
    use: Header CTA link at home::[data-omd-capture="10"]; the pricing body repeats the fill at 16px / 47px (surface-3 capture 18)
  outline-pill:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    border: '1px #111111'
    rounded: 100px
    padding: 14px 24px
    height: 49px
    typography: 16px / 600 / Pretendard Variable
    states: default captured; no pointer-state frame
    use: 'Home outline CTA link at home::[data-omd-capture="12"]; the pricing copy (surface-3 capture 16) uses #191919 for its text and border'
  locale-control:
    type: button
    backgroundColor: transparent
    textColor: '#191919'
    rounded: 8px
    padding: 10px 12px
    height: 40px
    typography: 15px / 500 / Pretendard Variable
    states: default captured on all three surfaces (capture 8); no pointer-state frame
    use: Header button at home::[data-omd-capture="8"]; its 1px border computes rgba(0, 0, 0, 0), so no visible frame is claimed
  testimonial-nav-button:
    type: button
    backgroundColor: transparent
    border: '1px #e5e7eb'
    rounded: 8px
    padding: 1px 6px
    size: 48px x 48px
    states: default captured on both buttons (capture 18 and 19, identical values); no pointer-state frame
    use: Home testimonial carousel button at home::[data-omd-capture="18"]; it has no text node, so no label colour is claimed
  pricing-tablist:
    type: card
    backgroundColor: '#f2f5fa'
    border: 1px rgba(25, 25, 25, 0.1)
    rounded: 999px
    padding: 5px
    height: 46px
    states: default captured; container of the pricing tabs
    use: Pricing tablist (div role=tablist, 275 x 46) at surface-3::div; it holds the 34px pricing tabs
  newsletter-email-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    size: 295px x 20px
    typography: 15px / 400 / 18px Pretendard Regular
    states: default captured; the form-error interaction re-captured the same input (form-error-0-0) with identical computed values, so no error style is declared; no pointer-state or focus frame
    use: Blog newsletter email field at surface-2::[data-omd-capture="15"]; the input has a 0px border, so no field frame is claimed
  newsletter-submit-button:
    type: button
    backgroundColor: '#191919'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0px
    size: 141px x 44px
    typography: 15px / 600 / 18px Pretendard SemiBold
    states: default captured; no pointer-state frame
    use: 'Blog newsletter submit button at surface-2::[data-omd-capture="16"]; the button itself computes #000000, so the label colour and font come from its child p at top 6170px (#ffffff)'
  text-link:
    type: tab
    backgroundColor: transparent
    textColor: '#007aff'
    rounded: 0px
    padding: 0px
    height: 24px
    typography: 15px / 400 / 24px Pretendard
    states: default captured on six home links (capture 14-17, 21, 22); no pointer-state frame
    use: Home text link at home::[data-omd-capture="14"]
  preset-text-link:
    type: tab
    backgroundColor: transparent
    textColor: '#00a3eb'
    rounded: 0px
    padding: 0px
    height: 19px
    typography: 16px / 400 / 24px Pretendard Regular
    states: default captured on five links across home, blog and pricing; no pointer-state frame
    use: Framer text-preset link (framer-styles-preset-1pfuu6) at home::[data-omd-capture="23"]; the blog copy (surface-2 capture 11) computes Inter at 16px / 28.8px
  footer-social-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.1)
    rounded: 1000px
    padding: 6px
    size: 36px x 36px
    states: default captured, four per surface on all three surfaces; no pointer-state frame
    use: Footer social icon link at home::[data-omd-capture="53"]; icon only, so no label colour is claimed
fonts:
  roles:
    marketing: Pretendard
---

# Datarize

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Datarize; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/datarize/DESIGN.md
