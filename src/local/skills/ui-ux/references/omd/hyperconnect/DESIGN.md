---
name: Hyperconnect
colors:
  primary: '#00dd99'
  azar-cta: '#1cd092'
  ink: '#222222'
  text-secondary: '#858585'
  text-muted: '#b4b4b4'
  legal: '#888888'
  on-dark: '#ffffff'
typography:
  hero:
    fontSize: 62px
    fontWeight: 700
    lineHeight: 1.17
    use: Page hero headline (h1 Our Mission) in white over the hero video, the same on all three captured pages
  section:
    fontSize: 46px
    fontWeight: 700
    lineHeight: 1.2
    use: Home section title (h2 Grow Rapidly & Expand Globally) in rgba(0, 0, 0, 0.8)
  hero-body:
    fontSize: 22px
    fontWeight: 400
    lineHeight: 1.5
    use: Hero paragraph under the headline; Pretendard on /ko/, Inter on the English pages
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.63
    use: Global navigation item and footer column heading (Poppins)
  card-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
    use: 'Press card title on /en/news (h2, Poppins, #222222)'
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Press card date and footer copyright (Inter on the English pages)
  link:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.86
    use: Footer link; its stack asks for noto-sans, which never loads, so it renders in the fallback sans
  button:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.75
    letterSpacing: 0.42855px
    use: Azar call-to-action label on /en/business (Roboto stack, no web font loaded)
  pagination:
    fontSize: 15.75px
    fontWeight: 500
    lineHeight: 1.75
    use: Page numbers under the press list on /en/news (Inter)
  label:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.75
    use: RELATED SITE footer button (Pretendard on /ko/, Inter on the English pages)
rounded:
  none: 0px
  pill: 28px
spacing:
  pagination-y: 6
  pagination-x: 8
  cta-y: 6
  cta-x: 16
  arrow: 12
  footer-gap: 90
  footer-heading: 20
components:
  global-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 26px
    typography: 16px / 700 / 26.1px Poppins
    selected: 'fg #00dd99 on the current section: About on /ko/ (home c=1), Product on /en/business (surface-2 c=2), Newsroom on /en/news (surface-3 c=4)'
    states: 'selected read from rest values on all three pages; one hover and pressed pair on home (Product, c=2) reads #505050 and one pressed frame on /en/business (Newsroom, c=4) reads #f5fefb; the two disagree and neither has a sibling to agree, so they are treated as transition frames and no hover value is declared; focus is not declared from the capture'
    use: Header navigation over the hero video (About, Product, Tech, Newsroom, Career, Contact) at home::[data-omd-capture="2"], 65 x 26
  language-switch:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    typography: 12px / 400 / 26.1px Poppins
    selected: 'weight 700 on the active language: KOR on /ko/ (home c=8), ENG on the English pages (surface-2 c=7)'
    states: selected read from rest values; no pointer frame
    use: ENG / KOR switch at the right end of the header at home::[data-omd-capture="7"], 24 x 26
  accent-link:
    type: button
    backgroundColor: transparent
    textColor: '#00dd99'
    typography: 14px / 700 / 26.1px (noto-sans stack, falls back)
    states: 'one element; its hover and pressed frames read #b4b4b4, but with no sibling to agree no state is declared'
    use: 자세히 알아보기 text link under Technology Driven on /ko/ at home::[data-omd-capture="10"], 630 x 26
  azar-cta:
    type: button
    backgroundColor: '#1cd092'
    textColor: rgba(0, 0, 0, 0.87)
    rounded: 28px
    padding: 6px 16px
    height: 52px
    typography: 15px / 700 / 26.25px, 0.42855px tracking, Roboto stack (no web font loaded)
    states: rest on two sibling buttons (c=12, c=14); no state frame
    use: START VIDEO CHAT and INSTALL AZAR APP on the Product page at surface-2::[data-omd-capture="12"] and "14", 183 x 52 and 181 x 52; Azar's calls to action carried onto the corporate site in a separate MUI instance
  news-card:
    type: card
    rounded: 0px
    size: 344px x 350px
    use: 'Press card on /en/news (six captured, c=10-15), two per row: title 16px / 700 / 19.2px Poppins #222222, date 12px / 400 / 18px Inter #b4b4b4; the anchor computes the browser-default link colour, so the visible label colours come from its children'
  pagination-button:
    type: button
    backgroundColor: transparent
    textColor: '#b4b4b4'
    rounded: 0px
    padding: 6px 8px
    size: 50px x 50px
    typography: 15.75px / 500 / 27.5625px Inter
    hover: 'fg #858585'
    pressed: 'fg #858585'
    selected: 'fg #222222 on the current page (c=17)'
    states: 'rest, hover and pressed; five sibling buttons (c=18-22) read #858585 in both frames; focus is not declared from the capture'
    use: Page numbers under the press list on /en/news at surface-3::[data-omd-capture="18"]
  pagination-arrow:
    type: button
    backgroundColor: '#858585'
    textColor: '#ffffff'
    rounded: 0px
    padding: 12px
    size: 51px x 51px
    disabled: icon rgba(0, 0, 0, 0.26) on the previous arrow (c=16), which is disabled at rest
    states: rest on the next arrow (c=23); the disabled variant is a rest attribute, not a pointer frame
    use: Previous and next arrows beside the page numbers on /en/news at surface-3::[data-omd-capture="23"]
  related-site-button:
    type: button
    backgroundColor: transparent
    textColor: '#858585'
    border: 1px solid rgba(233, 233, 233, 0.15)
    rounded: 0px
    padding: 6px 8px
    height: 35px
    typography: 12px / 500 / 21px
    states: rest only; no state frame
    use: RELATED SITE button with an end icon in the footer of all three pages (home c=34, surface-2 c=37, surface-3 c=46), 135 x 35; Pretendard on /ko/, Inter on the English pages
fonts:
  roles:
    display: Poppins
    body: Inter
    body-ko: Pretendard
---

# Hyperconnect

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Hyperconnect; reproduced for educational reference. Full prose: https://oh-my-design.kr/hyperconnect/design.md
