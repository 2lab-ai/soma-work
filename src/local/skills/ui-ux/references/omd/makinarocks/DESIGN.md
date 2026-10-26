---
name: MakinaRocks
colors:
  primary: '#2b2b3b'
  canvas: '#ffffff'
  ink: '#000000'
  slate: '#5a5a72'
  muted: '#8d8da5'
typography:
  display-hero:
    fontSize: 64px
    fontWeight: 700
    lineHeight: 83.2
    letterSpacing: '-1.6px'
    use: Public-home marketing hero
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 25.6
    letterSpacing: '-0.16px'
    use: Public marketing and corporate reading text
rounded:
  nav-control: 0px
  carousel-arrow: 28px
spacing:
  nav-control: 16
components:
  header-nav-button:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 16px
    height: 64px
    typography: 16px / 400 / 32px KmrApparat
    states: rest on four header buttons (capture 1-4) on all three capture records; the bundle holds no state frame for any MakinaRocks element
    use: Public header navigation button at home::[data-omd-capture="1"], 133 x 64, tracking normal
  header-contact-link:
    type: button
    backgroundColor: '#ffffff'
    border: '1px #000000'
    rounded: 19px
    padding: 5px 30px
    height: 38px
    states: rest on all three capture records (capture 5); no state frame
    use: 'Header contact link (a.contact) at home::[data-omd-capture="5"], 117 x 38 on home and 141 x 38 on About and Blog; its #000000 16px / 400 / 25.6px Pretendard text equals the page body text, so no label style is claimed'
    typography: 16px / 400
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  hero-outline-link:
    type: button
    backgroundColor: transparent
    textColor: '#1a1a1a'
    border: '1px #1a1a1a'
    rounded: 50px
    padding: 9px 24px
    height: 46px
    typography: 16px / 500 / 25.6px KmrApparat
    states: 'rest on the light hero slide (capture 9, a.outline); the dark hero slide link (capture 8, a.outline.dark) records fg #ffffff and border 1px #ffffff with the same geometry; no state frame'
    use: Hero outline pill link at home::[data-omd-capture="9"], 157 x 46, gap 12px, tracking -0.16px
  large-outline-link:
    type: button
    backgroundColor: transparent
    textColor: '#1a1a1a'
    border: '1px #e7e7ee'
    rounded: 50px
    padding: 12px 24px
    height: 55px
    typography: 18px / 500 / 28.8px KmrApparat
    states: 'rest on two About links (capture 8, 9, a.outline.light); the home closing-band link (capture 31, a.outline.dark) records fg #ffffff and border 1px #ffffff with the same geometry; no state frame'
    use: Large outline pill link at surface-2::[data-omd-capture="8"], 169 x 55, gap 12px, tracking -0.16px
  carousel-arrow-button:
    type: button
    backgroundColor: rgba(196, 196, 212, 0.5)
    rounded: 28px
    padding: 0px
    size: 40px x 40px
    states: rest on the enabled next arrows (capture 20, 30); the prev arrows beside them (capture 19, 29) are disabled and record the same captured values, and opacity is not among the captured properties, so no disabled treatment is declared; no state frame
    use: Home carousel arrow button (button.next) at home::[data-omd-capture="20"]; its 13.3333px / 400 type is the browser default for a button, so no label style is claimed
  solution-card-link:
    type: card
    rounded: 24px
    padding: 20px 37px
    size: 358px x 358px
    typography: 24px / 700 / 38.4px KmrApparat
    states: captured at rest on the home solution cards (capture 12 and its siblings); no state frame
    use: 'Home solution card link (a) at home::[data-omd-capture="12"]; the title is a child h3 in #ffffff 24px / 700 / 38.4px KmrApparat over artwork the capture does not record (background-color computes transparent; background-image is not among the captured properties), so no fill or fg is claimed; the link''s own #0000ee is the browser default link colour'
  news-card-link:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 12px
    padding: 0px
    size: 340px x 376px
    typography: 16px / 500 / 20.8px KmrApparat
    states: eight cards captured at rest (capture 21-28); no state frame
    use: Home news card link (a) at home::[data-omd-capture="21"]; fg and font come from its child h3 title (tracking -0.16px); the link itself records the page body text
  about-stat-card:
    type: card
    backgroundColor: '#f9f9fb'
    rounded: 24px
    padding: 24px
    size: 328px x 328px
    states: eight tiles captured at rest; no state frame
    use: 'About-page tile (li) at surface-2::li, two rows of four; the li records #5a5a72 24px / 400 / 31.2px Pretendard, but its inner text elements were not sampled, so no label style is claimed'
  blog-category-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#5a5a72'
    rounded: 12px
    padding: 4px 30px
    height: 29px
    typography: 16px / 500 / 20.8px Pretendard
    selected: 'bg #ffffff'
    states: 'rest on three category links (capture 9-11); the link with class on (capture 8) records bg #ffffff with the same text and geometry and is recorded as selected; no state frame'
    use: Blog category filter link (a) in div#category-toggle.tab-list at surface-3::[data-omd-capture="9"], tracking -0.16px
  blog-featured-post:
    type: card
    textColor: '#2b2b3b'
    size: 1408px x 422px
    typography: 32px / 500 / 41.6px Pretendard
    states: one featured post captured at rest; no state frame
    use: 'Blog featured post link (a) at surface-3::[data-omd-capture="12"]: a 774 x 422 image block with 24px radius (p.image) beside a text column opened by a category line (padding 40px 40px 0px), a #2b2b3b 32px / 500 / 41.6px title (h3) and a #5a5a72 16px / 400 description'
  blog-post-card:
    type: card
    textColor: '#2b2b3b'
    rounded: 16px
    padding: 16px
    size: 354px x 381px
    typography: 20px / 500 / normal Pretendard
    states: twelve post cards captured at rest (capture 13-24); no state frame
    use: 'Blog post card link (a) at surface-3::[data-omd-capture="13"]: a 322 x 180 image with 16px radius, a category line (padding 24px 0px 0px), a #2b2b3b 20px / 500 title (h3) and a #5a5a72 16px / 400 / 25.6px date'
  blog-pagination-link:
    type: button
    backgroundColor: transparent
    textColor: '#2b2b3b'
    rounded: 22px
    size: 44px x 44px
    typography: 16px / 400 / 25.6px Pretendard
    states: rest on three page links (capture 25-27); no link records a different value, so no current-page variant is declared; no state frame
    use: Blog pagination link (a) at surface-3::[data-omd-capture="25"]
  footer-link:
    type: listItem
    textColor: '#ffffff'
    height: 26px
    typography: 16px / 400 / 25.6px KmrApparat
    states: rest on the footer link columns (capture 35 and its siblings); no state frame
    use: 'Footer link (a) at home::[data-omd-capture="35"] inside a 202 x 26 li whose own text is #8d8da5; tracking -0.16px'
  footer-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 10px
    size: 100px x 40px
    typography: 12px / 700 / normal Pretendard
    states: one button captured at rest (capture 32); no state frame
    use: Footer outline button at home::[data-omd-capture="32"]; its 1px 6px padding is the browser default for a button and is not claimed
fonts:
  roles:
    display: KmrApparat
    body: Pretendard
---

# MakinaRocks

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MakinaRocks; reproduced for educational reference. Full prose: https://oh-my-design.kr/makinarocks/design.md
