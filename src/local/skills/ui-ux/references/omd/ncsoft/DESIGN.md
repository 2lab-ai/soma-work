---
name: NCSOFT
colors:
  primary: '#ffffff'
  on-primary: '#252628'
  on-dark: '#ffffff'
  ink: '#000000'
  editorial-ink: '#1e1e1e'
  text-strong: '#333333'
  nav-inactive: '#a9a9a9'
  footer-on-dark: '#ebebeb'
  muted: '#888888'
  portal-meta: '#888890'
  portal-date: '#62626a'
typography:
  media-hero:
    fontSize: 39px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: '-0.25px'
    use: NC PLAY featured headline on the dark /play page (h2), white
  media-hero-sm:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.54
    letterSpacing: '-0.25px'
    use: Featured headline on the /news page (h2), white over its image
  section:
    fontSize: 26px
    fontWeight: 700
    use: NC PLAY section heads (PLAY HIGHLIGHTS, CATEGORIES, FEATURED, LATEST); line height normal
  nav:
    fontSize: 20px
    fontWeight: 700
    use: 'Selected NC PLAY header tab (PLAY or NEWS); the other tab is 20px / 500 #a9a9a9'
  display:
    fontSize: 74px
    fontWeight: 400
    lineHeight: 0.99
    use: Helvetica Now Display Black slide titles in the NC PLAY carousels
  display-xl:
    fontSize: 125px
    fontWeight: 400
    lineHeight: 1.16
    use: Outlined category links on NC PLAY (ALL, INTERACTIVE, FILM, CREATIVE)
  card-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.61
    letterSpacing: '-0.25px'
    use: 'LATEST article title on the /news page, #333333'
  caption:
    fontSize: 12px
    fontWeight: 400
    use: Article date and category line on the /news page; line height normal
  footer:
    fontSize: 16px
    fontWeight: 500
    use: NC PLAY footer headings and links (Helvetica Now); line height normal
  legal:
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.7
    use: NC PLAY footer copyright and policy links
  portal-hero:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.35
    use: www.nc.com hero headline (h3), white over the key art
  portal-section:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.36
    use: www.nc.com shelf heads (MMORPG, NC NEWS)
  portal-button:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.35
    use: 바로가기 label on the www.nc.com hero action
  portal-card-title:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.33
    use: 'NC NEWS item title on www.nc.com, #000000'
  portal-meta:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.33
    use: NC NEWS category (#888890) and date (#62626a) on www.nc.com
rounded:
  md: 8px
  lg: 16px
spacing:
  nav-underline: 5
  meta-gap: 10
  footer-heading: 24
  cta-y: 16
  cta-x: 24
components:
  media-nav-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#a9a9a9'
    padding: 0px 0px 5px
    height: 34px
    typography: 20px / 500 Helvetica Now
    selected: 'fg #ffffff at 700 on the dark /play page (home c=1); fg #1e1e1e at 700 on the light /news page (surface-3 c=2)'
    states: 'selected read from rest values on both pages; the unselected NEWS tab''s hover and pressed frames read #acacac, three steps from #a9a9a9 on one element, so they are treated as a transition frame and no hover is declared; focus is not declared from the capture'
    use: PLAY / NEWS switch in the NC PLAY header at home::[data-omd-capture="2"], 60 x 34
  media-carousel-arrow:
    type: button
    size: 32px x 32px
    disabled: the previous arrow is disabled at the first slide (home c=17, surface-3 c=6)
    states: the disabled variant is a rest attribute; no pointer frame; the icon is a background image, so no colour is claimed
    use: Swiper previous and next arrows beside PLAY HIGHLIGHTS and FEATURED at home::[data-omd-capture="18"]
  media-more-button:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    height: 33px
    typography: 16px / 700 / 22.08px Helvetica Now; the label inside is set at 24px / 700
    states: rest only; no state frame
    use: VIEW MORE under the LATEST list on the /news page at surface-3::[data-omd-capture="14"], 177 x 33
  media-article-card:
    type: card
    rounded: 0px
    size: 432px x 334px
    use: 'LATEST article on the /news page (six captured, c=8-13), three per row: date and category 12px / 400 #333333 with 10px below, title 18px / 700 / 28.98px Helvetica Now #333333 at -0.25px'
  media-footer-heading:
    type: button
    backgroundColor: transparent
    textColor: '#ebebeb'
    border: '1px solid #ebebeb (bottom only)'
    padding: 0px 0px 24px
    height: 49px
    typography: 16px / 500 Helvetica Now
    states: 'rest only; on the light /news page the same heading is #1e1e1e with a #1e1e1e rule (surface-3 c=23)'
    use: FAMILY SITE and GLOBAL headings in the dark footer of the /play page at home::[data-omd-capture="24"], 258 x 49
  portal-contained-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#252628'
    rounded: 8px
    padding: 16px 24px
    height: 55px
    typography: 17px / 700 / 23px Pretendard
    states: rest only; no state frame
    use: 바로가기 on the www.nc.com hero at surface-2::[data-omd-capture="0"], 107 x 55 (pd-button--contained, --color-common, --size-xxl)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  portal-game-card:
    type: card
    rounded: 16px
    size: 266px x 266px
    typography: 16px / 500 / 22px Pretendard
    use: Game tile on www.nc.com (eleven captured, c=1-11), four per row, the game name set in white 16.38px / 400 Pretendard over the key art; tiles lead to PURPLE (purple.plaync.com), which was not captured
  portal-news-card:
    type: card
    rounded: 0px
    size: 365px x 297px
    use: 'NC NEWS item on www.nc.com (six captured, c=12-17): category 15px / 400 #888890, date 15px / 400 #62626a, title 18px / 500 / 24px #000000'
fonts:
  roles:
    media: Helvetica Now
    display: Helvetica-Now-Display-Black
    portal: Pretendard
---

# NCSOFT

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NCSOFT; reproduced for educational reference. Full prose: https://oh-my-design.kr/ncsoft/design.md
