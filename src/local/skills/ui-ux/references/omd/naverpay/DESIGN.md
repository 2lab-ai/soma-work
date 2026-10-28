---
name: Naver Pay
colors:
  primary: '#09aa5c'
  ink: '#1e1e23'
  body: '#404048'
  muted: '#767678'
  nav-idle: '#aaaaac'
  subtle: '#929294'
  surface: '#f6f8fa'
  surface-strong: '#edeff2'
  chip: '#eef0f2'
  canvas: '#ffffff'
  error-text: '#ff5252'
  corporate-ink: '#121212'
  corporate-muted: '#878890'
  corporate-link: '#03c75a'
typography:
  guide-title:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.19
    use: 'Design-guide page title (h3.title, #1e1e23, 38px line)'
  guide-subtitle:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.27
    use: 'Design-guide section title (h4.sub_title, #1e1e23, 28px line)'
  guide-lede:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Design-guide description paragraph (p.description, #1e1e23, 21px line)'
  guide-nav:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.33
    use: Design-guide side navigation link (24px line); the current item is 700
  top-nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.4
    use: Developer-center top navigation link (21px line); hover and current are 700
  guide-note:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.46
    use: 'Bridge-guide annotation text (p.bridge_guide_text, #404048, 19px line)'
  footer-link:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Developer-center footer sitemap link (#767678, 20px line)
  prompt-title:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.36
    letterSpacing: '-0.5px'
    use: Developer-center home prompt heading (h3.title_prompt, 30px line)
  corporate-hero:
    fontSize: 53px
    fontWeight: 900
    lineHeight: 1.11
    letterSpacing: '-1px'
    use: Naver Financial corporate hero headline in NanumSquare (59px line)
  corporate-lede:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.6
    letterSpacing: '-0.5px'
    use: Naver Financial corporate hero sub-line in NanumSquare (32px line)
  corporate-section:
    fontSize: 18px
    fontWeight: 900
    lineHeight: 1.39
    use: Naver Financial corporate section title in NanumSquare (25px line)
rounded:
  hover-pill: 8px
  chip: 10px
  link-card: 12px
spacing:
  top-nav-x: 15
  guide-nav-y: 12
  guide-nav-x: 10
  link-card-y: 37
  link-card-x: 29
  chip-y: 12
  chip-x: 16
components:
  top-nav-link:
    type: tab
    textColor: '#aaaaac'
    rounded: 0px
    padding: 13px 15px 10px
    height: 44px
    typography: 15px / 400 / 21px
    hover: 'bg #edeff2, fg #1e1e23, 15px / 700, radius 8px'
    pressed: 'bg #edeff2, fg #1e1e23, 15px / 700, radius 8px'
    states: 'hover and pressed are settled frames: four sibling links (captures 3-6) on home and on surface-2 record identical values on published grey steps; the current-section link (class on, surface-2 capture 5) rests at fg #09aa5c, 15px / 700 and keeps #09aa5c over the #edeff2 hover fill; that variant is described, not declared as a state, because the bundle records no aria-current or aria-selected'
    use: Developer-center top navigation link (a.link_lnb) at home::[data-omd-capture="3"], 95 x 44; text renders the OS system stack (-apple-system first), no webfont is loaded
  guide-nav-link:
    type: tab
    textColor: '#404048'
    rounded: 0px
    padding: 12px 10px
    height: 48px
    typography: 18px / 500 / 24px
    hover: 'bg #f6f8fa, radius 8px, fg unchanged'
    pressed: 'bg #edeff2, radius 8px, fg unchanged'
    states: 'settled frames on three sibling links (captures 9, 10, 12) and on the current link (capture 11), which takes the same fills; the current item (class on) rests at fg #09aa5c, 18px / 700, a described variant rather than a declared state (no aria-current or aria-selected recorded)'
    use: Design-guide side navigation link (a.link_guide) at surface-2::[data-omd-capture="9"], 230 x 48
  developer-link-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #edeff2'
    rounded: 12px
    padding: 37px 29px
    size: 400px x 156px
    hover: box-shadow rgba(0, 0, 0, 0.1) 0px 4px 16px 0px; bg and border unchanged
    states: hover shadow on both sibling cards (captures 14, 15); the pressed frame keeps the same shadow; the anchor's own text colour is the browser default link blue, so no label colour is claimed
    use: Developer-center link card (a.item_link) at home::[data-omd-capture="14"]
  prompt-chip:
    type: card
    backgroundColor: '#eef0f2'
    rounded: 10px
    padding: 12px 16px
    height: 42px
    use: 'Developer-center home prompt chip (div.card): fourteen captured in one row, seven widths each twice; its 12px / 400 black text equals the body''s inherited values, so no label style is claimed'
  language-select:
    type: input
    textColor: '#929294'
    rounded: 0px
    padding: 0px 11px 0px 20px
    height: 19px
    typography: 13px / 400 / 19px
    states: rest on home and surface-2 (capture 8 on each); the bundle holds no state frame for this select
    use: Header language select (select.select_language), 65 x 19, no fill or border
  footer-sitemap-link:
    type: listItem
    textColor: '#767678'
    height: 17px
    typography: 14px / 400 / 20px
    states: rest on thirteen links (captures 16-28); no state frame
    use: Developer-center footer sitemap link (a.link) at home::[data-omd-capture="16"]
  footer-policy-link:
    type: listItem
    textColor: '#404048'
    height: 15px
    typography: 12px / 400 / 18px
    states: rest on three links (captures 29-31); no state frame
    use: 'Developer-center footer policy link at home::[data-omd-capture="29"], beside a #404048 12px / 400 / 24px copyright line'
  corporate-gnb-link:
    type: tab
    textColor: '#000000'
    padding: 6px 0px
    height: 34px
    typography: 18px / 400 / 21.6px NanumSquare
    states: rest on five links (captures 1-5); the collector recorded no pseudo-state frame on surface-3
    use: Naver Financial corporate top navigation link (a.lk_item) at surface-3::[data-omd-capture="1"]
  corporate-more-link:
    type: button
    textColor: '#03c75a'
    height: 18px
    typography: 15px / 700 / 18px NanumSquare
    states: rest on two links (captures 6, 19); a third green link (capture 22, a.lk_view) records 15px / 600 / 24px; no pseudo-state frame on surface-3
    use: Naver Financial corporate section 'more' text link (a.lk_more) at surface-3::[data-omd-capture="6"], 69 x 18, no fill
  corporate-family-site-toggle:
    type: button
    textColor: '#878890'
    border: '1px #c9c9c9'
    rounded: 0px
    padding: 0px 31px 0px 12px
    height: 35px
    typography: 13px / 400 / 35px NanumSquare
    states: 'the collector''s menu interaction opened it into a 168 x 106 list (ul.select_list) with a #ffffff fill, 1px #c9c9c9 top and side borders and #878890 15px / 400 / 18px items; no pseudo-state frame'
    use: Naver Financial corporate footer family-site select (button.btn_toggle) at surface-3::[data-omd-capture="30"], 168 x 35, letter-spacing -0.3px
fonts:
  roles:
    corporate: NanumSquare
---

# Naver Pay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Naver Pay; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/naverpay/DESIGN.md
