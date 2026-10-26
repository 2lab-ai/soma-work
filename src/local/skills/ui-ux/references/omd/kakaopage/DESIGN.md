---
name: KakaoPage
colors:
  primary: '#ffd618'
  ink: '#000000'
  canvas: '#ffffff'
  cta-label: '#222222'
  muted: '#999999'
  on-media: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Default text on all three pages (body)
  section-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.38
    use: Shelf heading on home and the webtoon page (h2)
  cover-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.25
    use: Title overlaid on a cover card, white
  cta:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.38
    use: 첫 화 보기 label on the content page
  small-heading:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.33
    use: Small bold heading on the content page (h2)
  search:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Header search field
  footer-link:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    use: Underlined footer link
rounded:
  md: 8px
spacing:
  menu-gap: 6
  chip-x: 12
  chip-gap: 8
  cta-x: 15
components:
  main-menu-item:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    height: 56px
    typography: 16px / 400 / 22.4px
    states: rest only in the capture; a same-day supplementary probe found the current menu marked aria-current=page and set bold, which the bundle does not record, so no selected value is declared
    use: Top menu item (추천, 웹툰, 웹소설 and the rest) at home::li, 64-97 x 56 with a 6px right margin; the webtoon page repeats it
  primary-cta:
    type: button
    textColor: '#222222'
    padding: 0px 15px
    height: 56px
    typography: 16px / 700 / 22px
    states: the pressed frame reads the label at rgba(34, 34, 34, 0.3), matching the authored class active:text-[rgb(var(--colors-static-mono-90)_/_30%)]; one element with no sibling, so no pressed value is declared
    use: 첫 화 보기 on the content page at surface-3::[data-omd-capture="12"], 272 x 56. The button's own background is transparent; the visible fill is painted by a wrapper div the collector does not record (see §2), so no bg or radius is declared
  carousel-button-lg:
    type: button
    backgroundColor: '#000000'
    rounded: 3.35544e+07px
    size: 44px x 44px
    states: rest only; no state frame
    use: Hero carousel previous and next buttons (bg-static-mono-black, class opacity-80) at home::[data-omd-capture="43"] and 44; the webtoon page repeats the pair
  carousel-button:
    type: button
    backgroundColor: '#000000'
    rounded: 3.35544e+07px
    size: 36px x 36px
    states: rest only; no state frame
    use: Shelf carousel button (bg-static-mono-black, class opacity-80) at home::[data-omd-capture="61"]; also on the webtoon page and twice on the content page
  reaction-chip:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.05)
    textColor: '#000000'
    rounded: 8px
    padding: 0px 12px
    height: 28px
    states: rest only; no state frame
    use: Comment reaction chip (bg-theme-transparent-10) on the content page at surface-3::[data-omd-capture="47"], 55-75 x 28 with an 8px right margin; icon-only variants are 28 x 28; 77 captured. The label sits in a child the collector did not record, so no font is declared
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    height: 18px
    typography: 13px / 400 / 18px
    states: rest only; no state frame
    use: Header search field at home::[data-omd-capture="6"], 150 x 18, identical on all three pages; no border or fill of its own
  cover-card:
    type: card
    rounded: 8px
    size: 152px x 274px
    use: 'Cover card (rounded-8pxr overflow-hidden) at home::div on home and the webtoon page, 24 captured; the cover image fills it and its title overlays in 16px / 700 / 20px #ffffff'
  content-row:
    type: listItem
    textColor: '#000000'
    size: 632px x 88px
    typography: 16px / 400 / 22.4px
    use: List row on the content page at surface-3::li, six captured
  first-episode-cta:
    type: button
    backgroundColor: '#ffd618'
    textColor: '#222222'
    size: 272px x 56px
    typography: 12px / 700 (label span)
    hover: no change across self, 1 descendant and 3 ancestor levels (live probe)
    pressed: label fg rgba(34, 34, 34, 0.3), opacity 1 -> 0.3; the yellow wrapper is unchanged
    states: hover and pressed measured by the live keyboard probe on 2026-09-30; focus not measured (--no-focus)
    use: Work-page 첫 화 보기 call-to-action on surface-3; the button is transparent and the point-yellow fill is its grandparent div (bg-static-point-yellow)
---

# KakaoPage

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KakaoPage; reproduced for educational reference. Full prose: https://oh-my-design.kr/kakaopage/design.md
