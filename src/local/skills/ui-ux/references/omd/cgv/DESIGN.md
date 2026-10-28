---
name: CGV
colors:
  foreground: '#121212'
  canvas: '#ffffff'
  subtle: '#f4f4f4'
  secondary: '#454545'
  line: '#d9d9d9'
  signal: '#fc5555'
typography:
  display:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.4px'
    use: Observed prominent body-role heading
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.2px'
    use: Observed public-page body and input copy
  label:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.2px'
    use: Observed category-tab label
rounded:
  badge: 4px
  media: 16px
  action: 20px
  chip: 25px
spacing:
  dense: 10
  sm: 8
  base: 16
  lg: 24
components:
  category-chip:
    type: button
    backgroundColor: '#f4f4f4'
    textColor: '#454545'
    border: '1px solid #f4f4f4'
    rounded: 25px
    padding: 0px 16px
    height: 40px
    typography: 15px / 400 / Pretendard
    selected: 'bg #121212, border 1px #121212, fg #ffffff, 15px / 700'
    states: rest on four main-category tabs (home capture 36-39); the tab with class maintab_tabTitleActive (capture 35) differs from them and is recorded as selected; the bundle holds no state frame for any CGV element
    use: Public main-category tab
  outline-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#121212'
    border: '1px solid #d9d9d9'
    rounded: 20px
    padding: 9px 24px
    typography: 14px / 500 / Pretendard
    states: rest on 33 movie-card actions per capture; rects vary with the carousel slide they sit on (e.g. 104px x 31px, 90px x 31px); no state frame
    use: Rounded public movie-card action (button.btn.btn-round32.line-gray.bg-white) at home::[data-omd-capture="49"]
  screen-format-badge:
    type: badge
    backgroundColor: rgba(0, 0, 0, 0.55)
    rounded: 4px
    padding: 0px 5px
    height: 20px
    use: Movie-card screen-format marker (span.badge.screenType.img); all 15 sampled badges record no text (textLength 0), so no label colour or type is claimed
  menu-row:
    type: listItem
    backgroundColor: transparent
    rounded: 0px
    height: 40px
    use: 'Observed public navigation/menu row (li.mets01390_linkItem, 200px x 40px, five per capture); its #121212 and 10px / 400 equal the page body''s inherited values, so no label style is claimed'
  line-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#121212'
    padding: 2px 0px 8px
    height: 25px
    typography: 15px / 500 / 15px Pretendard, tracking -0.225px
    selected: 'weight 700, tracking -0.3px; fg #121212 as at rest'
    states: rest on five tabs (home capture 42-46); the tab with class linetabMini_tabTitleActive (capture 41) differs from them and is recorded as selected; the bundle holds no state frame for any CGV element
    use: Movie-chart line tab (button.linetabMini_tabTitle) at home::[data-omd-capture="42"], 74px x 25px; the capture records no border on the tab element
  like-button:
    type: button
    backgroundColor: rgba(18, 18, 18, 0.2)
    rounded: 50%
    size: 36px x 36px
    states: rest on 22-23 buttons per capture; copies on the smaller carousel slides render 27-33px; no state frame
    use: 'Circular like button (button.btn-like.dark) on the largest movie-chart poster at home::[data-omd-capture="51"]; its own #121212 and 10px / 400 equal the page body''s inherited values, so no label style is claimed'
  poster-card:
    type: card
    rounded: 12px
    size: 254px x 362px
    shadow: rgba(18, 18, 18, 0.24) 0px 20px 25px 0px on the largest card
    states: rest; 33 poster areas per capture; the largest records the shadow, the other 32 a zero-alpha shadow and smaller rects; no state frame
    use: Movie-chart poster area (div.mainMovieChartCard_imgArea) holding the poster image (img.mainMovieChartCard_poster, same rect); its text values are inherited, so no label style is claimed
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px #121212'
    rounded: 8px
    padding: 0px 52px 0px 16px
    size: 530px x 46px
    typography: 14px / 400 / 19.6px Pretendard, tracking -0.2px
    states: rest, empty (textLength 0); no state frame
    use: Main search field (input.mainSearch_mainSearchInput) at home::[data-omd-capture="141"]; its 52px right padding matches the 52px x 46px search button beside it (capture 143, radius 0px 8px 8px 0px)
  search-shortcut-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#121212'
    border: '1px #e9e9e9'
    rounded: 30px
    padding: 0px 12px
    height: 46px
    typography: 13px / 500 / 13px Pretendard, tracking -0.2px
    states: rest on three pills (home capture 144-146); no state frame
    use: Search shortcut pill (button.mainSearch_searchBtn) at home::[data-omd-capture="145"], 78px x 46px, below the search field; the two with class mainSearch_withImg (capture 144, 146) use 0px 12px 0px 6px padding
  reserve-button:
    type: button
    backgroundColor: transparent
    textColor: '#fc5555'
    border: '1px #fc5555'
    rounded: 4px
    padding: 8px
    size: 60px x 29px
    typography: 11px / 500 / 11px Pretendard, tracking -0.165px
    states: rest; one per capture (surface-2 and surface-3 capture 151); no state frame
    use: 'Outline button with class btn_reserve at home::[data-omd-capture="152"], inside the video article, below its player; the #fc5555 signal value is this button''s text and border'
  text-link-button:
    type: button
    backgroundColor: transparent
    textColor: '#707070'
    size: 77px x 20px
    typography: 14px / 400 / 19.6px Pretendard, tracking -0.21px
    states: rest; no state frame
    use: Movie-chart text button (button.mainMovieChart_linkBtn) at home::[data-omd-capture="47"], at the end of the line-tab row; column gap 2px
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#707070'
    padding: 0px 9px 0px 0px
    height: 17px
    typography: 12px / 400 / 16.8px Pretendard, tracking -0.2px
    states: rest on eight footer links (home capture 21-28); no state frame
    use: Footer link (button.cgv-footer-link) at home::[data-omd-capture="21"]; the last link of each row (capture 23, 25, 28) has 0px padding
  common-select:
    type: input
    backgroundColor: transparent
    textColor: '#121212'
    border: '1px #d9d9d9'
    rounded: 10px
    padding: 0px 16px
    size: 200px x 48px
    typography: 14px / 400 / 19.6px Pretendard, tracking -0.2px
    states: rest; no state frame
    use: Native select (select.select_commonSelect) below the footer links at home::[data-omd-capture="29"]
  bottom-sheet:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 24px 24px 0px 0px
    padding: 20px 0px 32px
    size: 600px x 391px
    states: open in all three captures (div.cgv-modal.cgv-bot-modal.active, role dialog); no state frame
    use: 'Promotional bottom sheet (div.main-modal-container), 600px wide and flush with the bottom of the 900px viewport (top 509px); its own #121212 10px / 400 is inherited page text, so no label style is claimed'
  sheet-close-button:
    type: button
    backgroundColor: '#f5f5f5'
    textColor: '#707070'
    rounded: 6px
    padding: 8px 10px
    size: 40px x 28px
    typography: 12px / 400 / 12px Pretendard, tracking -0.2px
    states: rest; no state frame
    use: 'Close button (button.mmns00008_close) in the bottom sheet at home::[data-omd-capture="8"]; beside it a fill-less #707070 14px / 400 / 19.6px text button (button.mmns00008_today, capture 7)'
  round-outline-pill:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 100px
    padding: 0px 12px
    size: 90px x 34px
    typography: 12px / 500 / 16.8px Pretendard, tracking -0.2px
    states: rest; no state frame
    use: White outline pill (button.mets01390_roundBtn) at home::[data-omd-capture="30"], under white 22px / 700 and 14px / 700 text (p.mets01390_title, p.mets01390_txt); the fill behind the three is not in the capture
fonts:
  roles:
    sans: Pretendard
---

# CGV

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to CGV; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/cgv/DESIGN.md
