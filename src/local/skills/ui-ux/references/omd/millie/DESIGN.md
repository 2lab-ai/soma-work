---
name: Millie
colors:
  ink: '#242424'
  canvas: '#FFFFFF'
  surface-subtle: '#F7F7F7'
  muted: '#6F6F6F'
  divider: '#ECECEC'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7143
    use: Observed public home body and list text.
  heading-xl:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 1.2273
    use: Observed public B2B heading specimen.
  heading:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.3571
    use: Observed public B2B section heading specimen.
  utility:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed compact home utility button.
rounded:
  utility-button: 4px
  carousel-pagination: 100px
components:
  home-utility-button:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px 12px
    height: 32px
    typography: 12px / 400 / 18px Pretendard Variable
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home header utility button (button.button__Button-sc-746c0757-0) at home::[data-omd-capture="10"], 80 x 32
  hero-play-control:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.3)
    rounded: 100px
    padding: 8px
    size: 32px x 32px
    states: default captured; no state frame (the bundle holds none on either route)
    use: 'Home hero carousel play control (styled__PlayButtonContainer) at home::[data-omd-capture="21"]; its 8-character text cannot render inside the 16 x 16 content box, so the computed #242424 is not claimed as a label colour'
  hero-pagination-control:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.3)
    textColor: '#ffffff'
    rounded: 100px
    padding: 4px 10px
    height: 32px
    typography: 16px / 400 / 24px Pretendard Variable
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home hero pagination counter (styled__PaginationButtonContainer) at home::[data-omd-capture="22"], 76 x 32 over the hero image
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#242424'
    rounded: 0px
    padding: 0px 24px
    height: 64px
    typography: 20px / 400 Pretendard Variable
    selected: 20px / 700, same colour (class on, capture 1)
    states: rest on five links (capture 2-6); the link carrying the class on (capture 1) renders 20px / 700; no state frame (the bundle holds none on either route)
    use: Home top navigation link at home::[data-omd-capture="2"]
  category-tab-link:
    type: tab
    backgroundColor: transparent
    textColor: '#242424'
    rounded: 0px
    padding: 0px 10px
    height: 44px
    typography: 16px / 400 / 24px Pretendard Variable
    states: rest on five links (capture 11, 13-16; 15 adds 32px left padding); capture 12 carries a different generated class and renders 16px / 700 / 22px, but no aria-selected or active class marks it, so it is not declared selected; no state frame (the bundle holds none on either route)
    use: Home category tab link (styled__MdsTabLink) at home::[data-omd-capture="11"]
  white-anchor-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#242424'
    rounded: 4px
    padding: 0px 16px
    height: 40px
    typography: 14px / 400 / 20px Pretendard Variable
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home anchor button (a.button__Anchor-sc-746c0757-1, the utility button component family) at home::[data-omd-capture="38"], 311 x 40; its border width is 0px
  translucent-icon-button:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.4)
    border: 1px rgba(255, 255, 255, 0.3)
    rounded: 8px
    size: 24px x 24px
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home translucent icon button (classes rounded-8 border-white-alpha-30 bg-black-alpha-40) at home::[data-omd-capture="34"]; it has no text node, so no label colour is claimed
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#6f6f6f'
    rounded: 0px
    padding: 0px 12px 0px 0px
    height: 14px
    typography: 12px / 400 Pretendard Variable
    states: default captured on eleven links (capture 43-53); no state frame (the bundle holds none on either route)
    use: Home footer link row at home::[data-omd-capture="43"]
  footer-about-button:
    type: button
    backgroundColor: transparent
    textColor: '#a5a5a5'
    rounded: 0px
    padding: 0px 14px 0px 0px
    height: 12px
    typography: 10px / 400 Pretendard Variable
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home footer about button (styled__AboutButton) at home::[data-omd-capture="42"], 97 x 12
  hero-slide:
    type: card
    backgroundColor: transparent
    rounded: 20px
    size: 1392px x 400px
    states: default captured; no state frame (the bundle holds none on either route)
    use: Home hero banner slide (li.swiper-slide, bundle variant 13); the selector home::li is shared by many list items, so the class is the locator; the hero links (capture 17-20) span the same 1392 x 400 box
  skeleton-card:
    type: card
    backgroundColor: '#f7f7f7'
    rounded: 16px
    padding: 45px 24px 30px
    size: 280px x 424px
    states: 'captured shell only: no loading event, timing, or state frame'
    use: Home skeleton card (div.skeleton__SkeletonCard-sc-3613fd6a-1, bundle variant 5), five occurrences; the selector home::div is shared, so the class is the locator
  b2b-benefit-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 10px
    padding: 16px 24px
    size: 297px x 169px
    states: default captured on three list items; no state frame (the bundle holds none on either route)
    use: B2B benefit list item (surface-2::li, bundle variant 7); a container, so its inherited 14px / 400 type is not claimed as a label style
  b2b-campaign-cta:
    type: button
    backgroundColor: '#fef08c'
    textColor: '#242424'
    rounded: 4px
    padding: 0px
    height: 56px
    typography: 16px / 400 / 56px Pretendard Variable
    shadow: rgba(0, 0, 0, 0.22) 0px 4px 16px 0px
    states: default captured; no state frame (the bundle holds none on either route)
    use: B2B page HubSpot CTA (a.hs-cta-embed) at surface-2::[data-omd-capture="1"], 318 x 56; its wrapper anchor (capture 0) records the same values; route-local marketing evidence, not a consumer product CTA
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Pretendard Variable
---

# Millie

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Millie; reproduced for educational reference. Full prose: https://oh-my-design.kr/millie/design.md
