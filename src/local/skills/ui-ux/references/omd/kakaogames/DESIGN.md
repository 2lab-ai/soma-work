---
name: 카카오게임즈
colors:
  ink: '#000000'
  hero-on-dark: '#ffffff'
  footer-muted: '#898989'
typography:
  hero:
    fontSize: 50px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0px
    use: Homepage desktop hero title only.
  section-title:
    fontSize: 34px
    fontWeight: 600
    letterSpacing: 0px
    use: Homepage section heading only.
  footer:
    fontSize: 14px
    fontWeight: 300
    lineHeight: 1.4
    letterSpacing: 0px
    use: Homepage footer information only.
rounded:
  none: 0px
  news-item: 4px
spacing:
  card-bottom: 40
components:
  home-game-card:
    type: card
    rounded: 0px
    padding: 0px 0px 40px
    use: home::div.card; static homepage game-card wrapper, observed at 248px × 437px.
  home-hero-arrow:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.05)
    rounded: 0px
    padding: 0px
    height: 60
    states: Default on the prev/next pair (capture 1, 2), 60px × 60px; the bundle holds no state frame for any element, so hover, focus, and pressed values are not recorded.
    use: home::[data-omd-capture="1"] (.btn-arrow.btn-arrow--prev) on the homepage hero; its font size is 0px, so no label style is claimed.
  home-slide-control:
    type: tab
    backgroundColor: transparent
    padding: 0px 10px
    size: 330px x 60px
    states: rest on three hero control-bar buttons (capture 4-6); capture 3 carries class active, but none of its captured properties differs from theirs and the capture holds no opacity, so no selected value is declared; the bundle holds no state frame
    use: Homepage hero slide control (button.swiper-controlbar__btn) at home::[data-omd-capture="4"]; its own font size is 0px, so its label sits in an unsampled child and no label style is claimed
  home-game-filter-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    padding: 0px
    height: 43px
    typography: 34px / 600 / normal SUIT Variable
    states: rest on two filter buttons (capture 13, 14); capture 12 carries class active, but none of its captured properties differs from theirs and the capture holds no opacity, so no selected value is declared; the bundle holds no state frame
    use: Homepage game-category filter button inside li.game-filter__item at home::[data-omd-capture="13"], 60 x 43
  notice-bar-title-link:
    type: button
    textColor: '#000000'
    size: 70px x 25px
    typography: 20px / 400 / normal SUIT Variable
    states: default on the homepage (capture 32) and the error page (surface-2 capture 2); the bundle holds no state frame
    use: 'Notice-bar title link (a) inside h1.notice-bar__title at home::[data-omd-capture="32"]; the ticker items beside it are p elements at #000000, 16px / 300 / 16px'
  notice-bar-slide-button:
    type: button
    backgroundColor: transparent
    size: 26px x 26px
    states: default on the prev/next pair on the homepage (capture 33, 34) and the error page (surface-2 capture 3, 4); the bundle holds no state frame
    use: Notice-bar prev/next button (button.btn-slide) at home::[data-omd-capture="33"]; its font size is 0px, so no label style is claimed
  footer-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#898989'
    padding: 0px
    height: 20px
    typography: 14px / 300 / 19.6px SUIT Variable
    states: default on two footer buttons on the homepage (capture 46, 47) and the error page (surface-2 capture 16, 17); the bundle holds no state frame
    use: Footer information-line text button (button.btn-text) at home::[data-omd-capture="47"]; capture 46 adds class underline, which the capture does not confirm as a text decoration
  error-outline-link:
    type: button
    backgroundColor: transparent
    border: '1px #e0e0e0'
    rounded: 4px
    size: 318px x 78px
    states: default on the error page (surface-2 capture 1; the second error capture repeats it); the bundle holds no state frame
    use: Error-page outline link (a) at surface-2::[data-omd-capture="1"]; its own font size is 0px and its colour is the browser-default link blue, so its label sits in an unsampled child and no label style is claimed
  home-news-card:
    type: card
    textColor: '#000000'
    rounded: 4px
    size: 650px x 230px
    typography: 24.48px / 600 / 35.496px SUIT Variable
    states: default on two news items; the bundle holds no state frame
    use: 'Homepage news item (li.news-box__item): radius and size sit on the li; text colour and type come from its title paragraph (home::p, 540 x 71), which holds all of the item text'
  home-media-card:
    type: card
    textColor: '#000000'
    padding: 18px 0px 18px 28px on the caption
    size: 423px x 291px
    typography: 16px / 400 / 16px SUIT Variable
    states: default on three media items; the bundle holds no state frame
    use: 'Homepage media item (li.media-box__item): size sits on the li; colour, padding and type come from its caption paragraph (home::p, 423 x 52), which holds all of the item text'
fonts:
  roles:
    ui: SUIT Variable
---

# 카카오게임즈

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 카카오게임즈; reproduced for educational reference. Full prose: https://oh-my-design.kr/kakaogames/design.md
