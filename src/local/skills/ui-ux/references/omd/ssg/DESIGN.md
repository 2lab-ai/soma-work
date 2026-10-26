---
name: SSG.COM
colors:
  primary: '#ff5452'
  ink: '#222222'
  ink-legacy: '#000000'
  muted: '#666666'
  subtle: '#777777'
  faint: '#888888'
  canvas: '#ffffff'
  surface: '#fafafa'
  surface-2: '#f5f5f5'
  hairline: '#e5e5e5'
typography:
  title:
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    use: 'Page and section titles on the event page (이벤트/쿠폰, 지금 인기 상승 중!) and the ranking page title 베스트, 36px line, in #222222'
  hero-title:
    fontSize: 24px
    fontWeight: 700
    use: 'Home hero slide titles (ssghero24_titmain), white or #222222 over the slide image; line-height computes normal, so none is declared'
  home-section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.3px'
    use: 'Home section titles (cmmain_title), 24px line, in #222222'
  tab-lg:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.2
    use: Event page tabs (전체 이벤트, 구매사은 혜택, 체험단); 700 selected, 400 unselected, 24px line
  tab:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Ranking category tabs (전체, 패션의류 … 반려동물); 700 selected, 500 unselected, 24px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on the ranking and event pages, 24px line, in #222222'
  nav:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: Header menu triggers on the ranking and event pages, 21px line
  subtitle:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.21
    use: 'Event page subtitle (쿠폰과 혜택이 모두 여기에!), 17px line, in #777777'
  chip:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.5
    use: Filter chip label (백화점상품) on the ranking page, 19.5px line
  body-legacy:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Document default on the legacy home build, 18px line, in #000000'
  utility:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    use: 'Header utility links on home, 18px line, in #666666'
rounded:
  none: 0px
  input: 2px
  pill: 9999px
spacing:
  tab-x: 12
  tab-lg: 20
components:
  ranking-tab:
    type: tab
    backgroundColor: '#fafafa'
    textColor: '#666666'
    rounded: 0px
    padding: 0px 12px
    height: 52px
    typography: 16px / 500 / 24px Pretendard
    selected: 'bg #222222, fg #ffffff, 16px / 700'
    states: rest values only; the selected variant is read from aria-selected=true at rest; the Aside bundle has no hover, pressed or focus frame, so none is declared
    use: Category tabs on the 베스트 ranking page, a 183 x 52 grid of 14 tabs (전체 selected at capture, then 패션의류, 패션잡화, 명품, 뷰티 … 반려동물) at surface-2::[data-omd-capture="26"]
  event-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#888888'
    rounded: 0px
    padding: 20px
    height: 64px
    typography: 20px / 400 / 24px Pretendard
    selected: 'fg #222222, 20px / 700, 1px #000000 bottom border'
    states: rest values only; the selected variant is read from aria-selected=true at rest; no hover, pressed or focus frame in the bundle
    use: Section tabs on the event page (전체 이벤트 selected, 구매사은 혜택, 체험단), 160 x 64, at surface-3::[data-omd-capture="66"]
  filter-chip:
    type: button
    backgroundColor: '#f5f5f5'
    textColor: '#666666'
    rounded: 9999px
    height: 28px
    typography: 13px / 700 / 19.5px Pretendard
    states: rest only on three instances; no state frame in the bundle
    use: Pill filters under the ranking tabs at surface-2::[data-omd-capture="41"] (백화점상품, 73 x 28); the two neighbouring 84 x 28 chips carry logo images instead of text
    padding: 0px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: outline rgba(0, 0, 0, 0.5) dashed 1px on :focus-visible
  search-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 2px
    height: 33px
    typography: 13px / 400 / 16px Pretendard
    states: rest only; the field computes no border of its own (the outline belongs to a wrapper the collector did not record), and no focus frame exists in the bundle
    use: Header search field on the ranking and event pages, 304 x 33, at surface-2::[data-omd-capture="8"]
  slider-control:
    type: button
    backgroundColor: transparent
    border: '1px solid #e5e5e5'
    rounded: 0px
    padding: 3px
    size: 28px x 28px
    states: rest only; no state frame
    use: Autoplay control of the home hero slider (slider_ctrl_auto) at home::[data-omd-capture="71"]
  product-thumb:
    type: card
    rounded: 0px
    size: 302px x 302px
    use: Square product image links in the ranking grid at surface-2::[data-omd-capture="58"]; image only, no fill, border or shadow
fonts:
  roles:
    display: Pretendard
    body: Pretendard
---

# SSG.COM

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SSG.COM; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/ssg/DESIGN.md
